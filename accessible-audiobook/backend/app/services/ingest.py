"""Book ingestion: file -> structure in SQL -> vectors in Qdrant."""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from dataclasses import replace
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, joinedload

from ingestion.chunker import build_chunks, split_sentences
from ingestion.pdf_parser import PICTURE_PREFIX, DocumentParseError, parse_document

from ..config import get_settings
from ..db import SessionLocal
from ..models import Book, Chapter, DocumentChunk, Section
from .providers import get_providers

logger = logging.getLogger(__name__)
EMBED_BATCH = 32


def _progress(db: Session, book: Book, value: float, detail: str) -> None:
    book.progress, book.status_detail = value, detail
    db.commit()


def _store_structure(db: Session, book: Book, chunks) -> None:
    """Create Chapter / Section / DocumentChunk rows in reading order."""
    for model in (DocumentChunk, Section, Chapter):  # re-ingestion replaces any old structure
        db.execute(delete(model).where(model.book_id == book.id))
    chapters: dict[int, Chapter] = {}
    sections: dict[tuple[int, int], Section] = {}
    for order, chunk in enumerate(chunks):
        chapter = chapters.get(chunk.chapter_index)
        if chapter is None:
            chapter = Chapter(book_id=book.id, index=chunk.chapter_index, title=chunk.chapter_title,
                              start_page=chunk.page)
            chapters[chunk.chapter_index] = chapter
            db.add(chapter)
            db.flush()
        key = (chunk.chapter_index, chunk.section_index)
        section = sections.get(key)
        if section is None:
            section = Section(book_id=book.id, chapter_id=chapter.id, index=chunk.section_index,
                              title=chunk.section_title)
            sections[key] = section
            db.add(section)
            db.flush()
        chapter.char_count += len(chunk.text)
        db.add(DocumentChunk(
            book_id=book.id, chapter_id=chapter.id, section_id=section.id, chunk_index=order,
            page=chunk.page, text=chunk.text, sentences=chunk.sentences,
            paragraph_starts=chunk.paragraph_starts, embedding_text=chunk.embedding_text,
        ))
    book.total_chunks = len(chunks)
    book.total_chars = sum(len(c.text) for c in chunks)
    db.commit()


def index_book(db: Session, book: Book, on_progress=None) -> None:
    """(Re)build the Qdrant index for a book from the chunks stored in SQL."""
    providers = get_providers()
    rows = list(db.scalars(
        select(DocumentChunk).options(joinedload(DocumentChunk.chapter), joinedload(DocumentChunk.section))
        .where(DocumentChunk.book_id == book.id).order_by(DocumentChunk.chunk_index)))
    providers.store.delete_book(book.id)
    for start in range(0, len(rows), EMBED_BATCH):
        batch = rows[start:start + EMBED_BATCH]
        vectors = providers.embedder.embed_documents([r.embedding_text for r in batch])
        providers.store.upsert(
            [r.id for r in batch], vectors,
            [{"book_id": book.id, "chapter": r.chapter.title, "section": r.section.title, "page": r.page,
              "chunk_id": r.id, "chunk_index": r.chunk_index, "text": r.text} for r in batch],
        )
        if on_progress:
            on_progress(min(1.0, (start + len(batch)) / len(rows)))


class _PictureCache:
    """Remembers each picture's description on disk as soon as it is written.

    Describing a book's pictures takes minutes and costs requests. If the server is restarted
    part-way through, the work already done must not be thrown away and paid for again.
    """

    def __init__(self, path: Path, describer) -> None:
        self._path, self._describer, self._lock = path, describer, threading.Lock()
        try:
            self._known: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self._known = {}

    def describe(self, image: bytes, context: str) -> str:
        key = hashlib.sha1(image).hexdigest()
        with self._lock:
            if key in self._known:
                return self._known[key]
        text = self._describer.describe(image, context)  # a failure is not remembered: it is tried again next time
        with self._lock:
            self._known[key] = text
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(self._known, ensure_ascii=False), encoding="utf-8")
        return text


_ingesting: set[str] = set()
_ingesting_lock = threading.Lock()


def resume_interrupted() -> None:
    """Pick up books whose preparation was cut short by a restart, so none is left "processing" for ever."""
    data_dir = get_settings().data_dir
    with SessionLocal() as db:
        stuck = [book.id for book in db.scalars(select(Book).where(Book.status == "processing"))]
    for book_id in stuck:
        with _ingesting_lock:
            if book_id in _ingesting:
                continue  # being prepared right now by this server
        sources = [*(data_dir / "uploads").glob(f"{book_id}.*"), *(data_dir / "samples").glob(f"{book_id}.*")]
        if sources:
            logger.info("resuming the preparation of %s", book_id)
            ingest_file(book_id, sources[0])
            continue
        with SessionLocal() as db:
            book = db.get(Book, book_id)
            if book is not None:
                book.status = "failed"
                book.status_detail = "The file for this book is missing. Please add it again."
                db.commit()
    # Books that are readable but whose pictures were still being described.
    for pending in sorted((data_dir / "pictures").glob("*.pending.json")):
        _describe_pending(pending.name[:-len(".pending.json")])


def ingest_file(book_id: str, path: Path) -> None:
    """Parse, chunk, store and index a document. Safe to run in a background thread."""
    with _ingesting_lock:
        if book_id in _ingesting:
            return
        _ingesting.add(book_id)
    try:
        _ingest_file(book_id, path)
    finally:
        with _ingesting_lock:
            _ingesting.discard(book_id)


def _ingest_file(book_id: str, path: Path) -> None:
    with SessionLocal() as db:
        book = db.get(Book, book_id)
        if book is None:
            return
        pictures: dict[str, tuple[bytes, str]] = {}
        try:
            describing = get_providers().describer is not None
            _progress(db, book, 0.1, "Reading the text and finding the pictures" if describing else "Extracting text")
            parsed, pictures = _parse_marking_pictures(path, describing)
            book.title = book.title or parsed.title
            book.author = book.author or parsed.author
            book.total_pages = parsed.page_count

            _progress(db, book, 0.3, "Finding chapters and sections")
            chunks, places = _take_out_pictures(build_chunks(parsed))
            if not chunks and places:
                # A picture book with no text of its own: its pictures have to be described before there is anything to read.
                chunks, places = _describe_now(db, book, path, pictures), []
            if not chunks:
                raise DocumentParseError("No readable paragraphs were found in this document.")
            _store_structure(db, book, chunks)

            _progress(db, book, 0.5, "Building the search index")
            index_book(db, book, lambda done: _progress(db, book, 0.5 + 0.5 * done, "Building the search index"))
            # The book can be read from here on. Its pictures are described afterwards, at whatever pace
            # the vision service allows (a free allowance manages only a few a minute), and slotted in.
            _save_pending(db, book, places)
            book.status, book.progress = "ready", 1.0
            book.status_detail = _pictures_note(0, len(places)) if places else ""
        except DocumentParseError as exc:
            db.rollback()
            book.status, book.status_detail = "failed", str(exc)
        except Exception:
            logger.exception("ingestion failed for %s", book_id)
            db.rollback()
            book.status = "failed"
            book.status_detail = "Something went wrong while processing this book. Please try again."
        db.commit()
        ready = book.status == "ready"
    if ready:
        _describe_pending(book_id, pictures)


# --- pictures ---------------------------------------------------------------
#
# A book is made readable from its text straight away. Each picture leaves a marker where it
# sits; the markers are taken out and remembered as "a picture belongs after this chunk". The
# pictures are then described one at a time and each description is inserted as a chunk of its
# own. Existing chunks keep their ids, so reading positions, bookmarks and notes stay valid.

_MARK = "PICTUREMARK"
_MARK_RE = re.compile(rf"^{_MARK}([0-9a-f]{{40}})\.?$")


def _parse_marking_pictures(path: Path, describing: bool):
    """The document with each picture replaced by a marker, and the pictures themselves by marker."""
    pictures: dict[str, tuple[bytes, str]] = {}
    lock = threading.Lock()

    def mark(image: bytes, context: str) -> str:
        key = hashlib.sha1(image).hexdigest()
        with lock:
            pictures[key] = (image, context)
        return f"{_MARK}{key}"

    parsed = parse_document(path, mark if describing else None, get_settings().max_pictures_per_book)
    return parsed, pictures


def _take_out_pictures(chunks) -> tuple[list, list[tuple[str, int | None]]]:
    """Remove the picture markers. Returns the chunks of text, and for each picture its key and the
    position (in that list) of the chunk it comes after - None for a picture before any text.
    A chunk with a picture in the middle is split there, so the picture is read exactly in its place."""
    kept: list = []
    places: list[tuple[str, int | None]] = []
    for chunk in chunks:
        was_start = set(chunk.paragraph_starts)
        overlap = "" if _MARK in chunk.overlap else chunk.overlap
        sentences: list[str] = []
        starts: list[int] = []

        def close() -> None:
            nonlocal sentences, starts, overlap
            if sentences:
                kept.append(replace(chunk, sentences=sentences, paragraph_starts=starts, overlap=overlap))
                overlap = sentences[-1]  # the next piece of the same chunk follows straight on
            sentences, starts = [], []

        i = 0
        while i < len(chunk.sentences):
            following = chunk.sentences[i + 1] if i + 1 < len(chunk.sentences) else ""
            marker = _MARK_RE.match(following) if chunk.sentences[i] == PICTURE_PREFIX.strip() else None
            if marker:
                close()
                places.append((marker.group(1), len(kept) - 1 if kept else None))
                i += 2
                continue
            if i in was_start:
                starts.append(len(sentences))
            sentences.append(chunk.sentences[i])
            i += 1
        close()
    return kept, places


def _pictures_note(done: int, total: int) -> str:
    return f"Ready to read. Describing the pictures: {done} of {total} so far."


def _pending_path(book_id: str) -> Path:
    return get_settings().data_dir / "pictures" / f"{book_id}.pending.json"


def _save_pending(db: Session, book: Book, places: list[tuple[str, int | None]]) -> None:
    """Write down which pictures still have to be described and where each belongs, so a restart loses nothing."""
    path = _pending_path(book.id)
    if not places:
        path.unlink(missing_ok=True)
        return
    ids = list(db.scalars(select(DocumentChunk.id).where(DocumentChunk.book_id == book.id).order_by(DocumentChunk.chunk_index)))
    todo = [{"key": key, "after": ids[position] if position is not None else None, "done": False, "chunk": None}
            for key, position in places]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(todo), encoding="utf-8")


def _describe_now(db: Session, book: Book, path: Path, pictures: dict[str, tuple[bytes, str]]):
    """For a book that is nothing but pictures: describe them before it can be opened at all."""
    cache = _PictureCache(get_settings().data_dir / "pictures" / f"{book.id}.json", get_providers().describer)
    parsed = parse_document(
        path, cache.describe, get_settings().max_pictures_per_book,
        lambda done, total: _progress(db, book, 0.1 + 0.2 * done / total, f"Describing the pictures: {done} of {total}"))
    return build_chunks(parsed)


def _insert_picture(db: Session, book: Book, after_id: int | None, description: str) -> int | None:
    """Add a picture's description as a chunk of its own, straight after the given chunk. Returns its id."""
    anchor = db.get(DocumentChunk, after_id) if after_id is not None else None
    if anchor is None:  # a picture before any text (or whose place has gone): the very start of the book
        anchor = db.scalar(select(DocumentChunk).where(DocumentChunk.book_id == book.id)
                           .order_by(DocumentChunk.chunk_index).limit(1))
        if anchor is None:
            return None
        index = anchor.chunk_index
    else:
        index = anchor.chunk_index + 1
    later = list(db.scalars(select(DocumentChunk).where(
        DocumentChunk.book_id == book.id, DocumentChunk.chunk_index >= index)))
    for chunk in later:
        chunk.chunk_index += 1
    sentences = [PICTURE_PREFIX.strip(), *split_sentences(description)]
    text = " ".join(sentences)
    heading = " - ".join(t for t in (anchor.chapter.title, anchor.section.title) if t)
    row = DocumentChunk(
        book_id=book.id, chapter_id=anchor.chapter_id, section_id=anchor.section_id, chunk_index=index,
        page=anchor.page, text=text, sentences=sentences, paragraph_starts=[0],
        embedding_text=f"{heading}\n{text}" if heading else text)
    db.add(row)
    book.total_chunks += 1
    book.total_chars += len(text)
    anchor.chapter.char_count += len(text)
    db.commit()
    try:  # searchable too: "what was in the picture of the load balancer?"
        providers = get_providers()
        providers.store.upsert(
            [row.id], providers.embedder.embed_documents([row.embedding_text]),
            [{"book_id": book.id, "chapter": anchor.chapter.title, "section": anchor.section.title, "page": row.page,
              "chunk_id": row.id, "chunk_index": row.chunk_index, "text": row.text}])
    except Exception:
        logger.exception("could not index a picture description for %s", book.id)  # ensure_indexed repairs it at next start
    return row.id


def _describe_pending(book_id: str, pictures: dict[str, tuple[bytes, str]] | None = None) -> None:
    """Describe the pictures still waiting for a book and insert each where it belongs.

    Safe to interrupt at any point: what has been done is on disk, and the rest is picked up
    at the next start.
    """
    pending = _pending_path(book_id)
    try:
        todo = json.loads(pending.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    describer = get_providers().describer
    if describer is None:
        return
    with _ingesting_lock:
        if f"pictures:{book_id}" in _ingesting:
            return
        _ingesting.add(f"pictures:{book_id}")
    try:
        if pictures is None:  # after a restart: fetch the pictures from the file again
            data_dir = get_settings().data_dir
            sources = [*(data_dir / "uploads").glob(f"{book_id}.*"), *(data_dir / "samples").glob(f"{book_id}.*")]
            if not sources:
                pending.unlink(missing_ok=True)
                return
            _, pictures = _parse_marking_pictures(sources[0], True)
        cache = _PictureCache(get_settings().data_dir / "pictures" / f"{book_id}.json", describer)
        with SessionLocal() as db:
            book = db.get(Book, book_id)
            if book is None or book.status != "ready":
                pending.unlink(missing_ok=True)
                return
            for number, item in enumerate(todo, 1):
                if item["done"]:
                    continue
                if db.get(Book, book_id) is None or not pending.exists():
                    return  # the book was removed meanwhile
                image = pictures.get(item["key"])
                description = ""
                if image is not None:
                    try:
                        description = cache.describe(*image)
                    except Exception:
                        logger.exception("a picture in %s could not be described", book_id)
                        continue  # left "not done": tried again at the next start
                if description:
                    # Several pictures after the same chunk keep their order: each goes after the one before it.
                    previous = [other["chunk"] for other in todo[:number - 1] if other["after"] == item["after"] and other["chunk"]]
                    item["chunk"] = _insert_picture(db, book, previous[-1] if previous else item["after"], description)
                item["done"] = True
                pending.write_text(json.dumps(todo), encoding="utf-8")
                book.status_detail = _pictures_note(sum(1 for other in todo if other["done"]), len(todo))
                db.commit()
            if all(item["done"] for item in todo):
                pending.unlink(missing_ok=True)
                book.status_detail = ""
                db.commit()
    finally:
        with _ingesting_lock:
            _ingesting.discard(f"pictures:{book_id}")


def backfill_paragraphs() -> None:
    """Recover paragraph boundaries for books ingested before they were recorded.

    The source file is still on disk and chunking is deterministic, so the document is
    chunked again and the boundaries copied onto the existing rows. Chunk ids are left
    untouched, which keeps reading positions, bookmarks and notes valid. A book whose
    source is missing, or no longer chunks identically, simply keeps coarser skimming.
    """
    data_dir = get_settings().data_dir
    with SessionLocal() as db:
        for book in db.scalars(select(Book).where(Book.status == "ready")):
            rows = list(db.scalars(select(DocumentChunk).where(DocumentChunk.book_id == book.id)
                                   .order_by(DocumentChunk.chunk_index)))
            if not rows or all(row.paragraph_starts is not None for row in rows):
                continue
            sources = [*(data_dir / "samples").glob(f"{book.id}.*"), *(data_dir / "uploads").glob(f"{book.id}.*")]
            if not sources:
                continue
            try:
                chunks = build_chunks(parse_document(sources[0]))
            except Exception:
                logger.exception("could not re-read %s to recover paragraph boundaries", book.id)
                continue
            if len(chunks) != len(rows) or any(row.sentences != chunk.sentences for row, chunk in zip(rows, chunks)):
                logger.info("paragraph boundaries for %s could not be recovered: the chunking differs", book.id)
                continue
            for row, chunk in zip(rows, chunks):
                row.paragraph_starts = chunk.paragraph_starts
            db.commit()
            logger.info("recovered paragraph boundaries for %s", book.id)


def ensure_indexed() -> None:
    """Re-index books whose vectors are missing, e.g. after switching the embedding provider."""
    store = get_providers().store
    with SessionLocal() as db:
        for book in db.scalars(select(Book).where(Book.status == "ready")):
            if store.count(book.id) != book.total_chunks:
                logger.info("re-indexing %s for embedding space %s", book.id, store.collection)
                index_book(db, book)
