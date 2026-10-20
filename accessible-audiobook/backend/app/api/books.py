"""Library, book structure, upload, playback state and bookmarks."""
from __future__ import annotations

import re
import threading
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..audiobook import playback
from ..config import get_settings
from ..db import get_db
from ..models import Book, Bookmark, Conversation, ConversationMessage, DocumentChunk, Note, User
from ..models.schemas import BookmarkCreate, NoteCreate, PlaybackOut, PlaybackUpdate
from ..services.ingest import ingest_file
from ..services.providers import get_providers
from .deps import current_user, readable_book, ready_book

router = APIRouter(prefix="/api/books", tags=["books"])

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md"}


def _book_out(db: Session, book: Book, user: User) -> dict:
    out = {
        "id": book.id, "title": book.title, "author": book.author, "description": book.description,
        "total_pages": book.total_pages, "total_chunks": book.total_chunks, "total_chars": book.total_chars,
        "chapter_count": len(book.chapters), "status": book.status, "status_detail": book.status_detail,
        "ingest_progress": book.progress, "is_sample": book.owner_id is None, "session": None,
    }
    if book.status == "ready":
        out["session"] = playback.session_out(db, playback.get_session(db, user, book), book)
    return out


@router.get("")
def list_books(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    books = list(db.scalars(select(Book).where(or_(Book.owner_id.is_(None), Book.owner_id == user.id))
                            .order_by(Book.created_at)))
    return [_book_out(db, b, user) for b in books]


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def upload_book(file: UploadFile = File(...), title: str = Form(default="", max_length=200),
                      user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    settings = get_settings()
    extension = Path(file.filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Please upload a PDF, TXT or Markdown file.")

    limit = settings.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            f"That file is larger than {settings.max_upload_mb} megabytes.")
    # Check the content, not just the name: a PDF must start with the PDF signature, text must be UTF-8.
    if extension == ".pdf":
        if b"%PDF-" not in data[:1024]:
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "That file is not a valid PDF.")
    else:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "That text file is not valid UTF-8.") from None

    original = Path(file.filename or "book").stem
    clean_title = re.sub(r"\s+", " ", title).strip()
    slug = re.sub(r"[^a-z0-9]+", "-", (clean_title or original).lower()).strip("-")[:40] or "book"
    book_id = f"{slug}-{uuid.uuid4().hex[:8]}"
    # The stored name is generated here; the client's filename never touches the filesystem.
    upload_dir = settings.data_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    path = upload_dir / f"{book_id}{extension}"
    path.write_bytes(data)

    book = Book(id=book_id, owner_id=user.id, title=clean_title, source_filename=f"{original[:150]}{extension}",
                status="processing", status_detail="Waiting to start")
    db.add(book)
    db.commit()
    threading.Thread(target=ingest_file, args=(book_id, path), daemon=True).start()
    return _book_out(db, book, user)


@router.get("/{book_id}")
def get_book(book: Book = Depends(readable_book), user: User = Depends(current_user),
             db: Session = Depends(get_db)) -> dict:
    out = _book_out(db, book, user)
    out["chapters"] = playback.outline(db, book) if book.status == "ready" else []
    return out


@router.delete("/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_book(book: Book = Depends(readable_book), user: User = Depends(current_user),
                db: Session = Depends(get_db)) -> Response:
    if book.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sample books cannot be removed.")
    if book.status == "processing":
        raise HTTPException(status.HTTP_409_CONFLICT, "This book is still being prepared.")
    get_providers().store.delete_book(book.id)
    for path in (get_settings().data_dir / "uploads").glob(f"{book.id}.*"):
        path.unlink(missing_ok=True)
    for suffix in ("pending.json", "json"):  # its picture descriptions; removing "pending" also stops any still being written
        (get_settings().data_dir / "pictures" / f"{book.id}.{suffix}").unlink(missing_ok=True)
    db.delete(book)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{book_id}/chapters/{chapter_index}")
def get_chapter(chapter_index: int, book: Book = Depends(ready_book), db: Session = Depends(get_db)) -> dict:
    return playback.chapter_content(db, book, chapter_index)


# --- playback state -------------------------------------------------------

@router.get("/{book_id}/session", response_model=PlaybackOut)
def get_playback(book: Book = Depends(ready_book), user: User = Depends(current_user),
                 db: Session = Depends(get_db)) -> PlaybackOut:
    return playback.session_out(db, playback.get_session(db, user, book), book)


@router.put("/{book_id}/session", response_model=PlaybackOut)
def put_playback(update: PlaybackUpdate, book: Book = Depends(ready_book), user: User = Depends(current_user),
                 db: Session = Depends(get_db)) -> PlaybackOut:
    session = playback.get_session(db, user, book)
    playback.save_position(db, session, book, update)
    return playback.session_out(db, session, book)


@router.delete("/{book_id}/session", response_model=PlaybackOut)
def restart_book(book: Book = Depends(ready_book), user: User = Depends(current_user),
                 db: Session = Depends(get_db)) -> PlaybackOut:
    """'Start from beginning'."""
    session = playback.get_session(db, user, book)
    playback.reset_position(db, session, book)
    return playback.session_out(db, session, book)


# --- bookmarks ------------------------------------------------------------

def _bookmark_out(db: Session, bookmark: Bookmark) -> dict:
    chunk = db.get(DocumentChunk, bookmark.chunk_id)
    return {"id": bookmark.id, "chunk_id": bookmark.chunk_id, "sentence_index": bookmark.sentence_index,
            "label": bookmark.label, "chapter_index": chunk.chapter.index, "chapter": chunk.chapter.title,
            "section": chunk.section.title, "page": chunk.page, "created_at": bookmark.created_at.isoformat()}


@router.get("/{book_id}/bookmarks")
def list_bookmarks(book: Book = Depends(ready_book), user: User = Depends(current_user),
                   db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(select(Bookmark).where(Bookmark.book_id == book.id, Bookmark.user_id == user.id)
                      .order_by(Bookmark.id))
    return [_bookmark_out(db, b) for b in rows]


@router.post("/{book_id}/bookmarks", status_code=status.HTTP_201_CREATED)
def add_bookmark(body: BookmarkCreate, book: Book = Depends(ready_book), user: User = Depends(current_user),
                 db: Session = Depends(get_db)) -> dict:
    chunk = db.get(DocumentChunk, body.chunk_id)
    if chunk is None or chunk.book_id != book.id:
        raise HTTPException(422, "That position is not in this book.")
    bookmark = Bookmark(user_id=user.id, book_id=book.id, chunk_id=chunk.id,
                        sentence_index=min(body.sentence_index, len(chunk.sentences) - 1), label=body.label.strip())
    db.add(bookmark)
    db.commit()
    return _bookmark_out(db, bookmark)


@router.delete("/{book_id}/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bookmark(bookmark_id: int, book: Book = Depends(ready_book), user: User = Depends(current_user),
                    db: Session = Depends(get_db)) -> Response:
    bookmark = db.get(Bookmark, bookmark_id)
    if bookmark is None or bookmark.user_id != user.id or bookmark.book_id != book.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bookmark not found.")
    db.delete(bookmark)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- notes ----------------------------------------------------------------

def _note_out(db: Session, note: Note) -> dict:
    chunk = db.get(DocumentChunk, note.chunk_id)
    return {"id": note.id, "chunk_id": note.chunk_id, "sentence_index": note.sentence_index, "text": note.text,
            "chapter_index": chunk.chapter.index, "chapter": chunk.chapter.title, "section": chunk.section.title,
            "page": chunk.page, "quote": chunk.sentences[note.sentence_index],
            "created_at": note.created_at.isoformat()}


def _notes(db: Session, book: Book, user: User) -> list[Note]:
    return list(db.scalars(select(Note).where(Note.book_id == book.id, Note.user_id == user.id).order_by(Note.id)))


@router.get("/{book_id}/notes")
def list_notes(book: Book = Depends(ready_book), user: User = Depends(current_user),
               db: Session = Depends(get_db)) -> list[dict]:
    return [_note_out(db, note) for note in _notes(db, book, user)]


@router.post("/{book_id}/notes", status_code=status.HTTP_201_CREATED)
def add_note(body: NoteCreate, book: Book = Depends(ready_book), user: User = Depends(current_user),
             db: Session = Depends(get_db)) -> dict:
    chunk = db.get(DocumentChunk, body.chunk_id)
    if chunk is None or chunk.book_id != book.id:
        raise HTTPException(422, "That position is not in this book.")
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "The note is empty.")
    note = Note(user_id=user.id, book_id=book.id, chunk_id=chunk.id, text=text,
                sentence_index=min(body.sentence_index, len(chunk.sentences) - 1))
    db.add(note)
    db.commit()
    return _note_out(db, note)


@router.delete("/{book_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(note_id: int, book: Book = Depends(ready_book), user: User = Depends(current_user),
                db: Session = Depends(get_db)) -> Response:
    note = db.get(Note, note_id)
    if note is None or note.user_id != user.id or note.book_id != book.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Note not found.")
    db.delete(note)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{book_id}/study-notes")
def study_notes(book: Book = Depends(ready_book), user: User = Depends(current_user),
                db: Session = Depends(get_db)) -> Response:
    """Everything the student produced while reading this book, as one plain Markdown document.

    Plain headings and numbered lists read cleanly with a screen reader or a braille display
    and can be opened in any editor.
    """
    def place(chapter: str, section: str, page: int) -> str:
        return ", ".join(part for part in (chapter, section, f"page {page}" if page else "") if part)

    session = playback.session_out(db, playback.get_session(db, user, book), book)
    lines = [f"# Study notes: {book.title}", ""]
    if book.author:
        lines += [f"Author: {book.author}", ""]
    lines += [f"Exported on {datetime.now().strftime('%d %B %Y')}. {round(session.progress * 100)} percent of the book read.", ""]

    notes = [_note_out(db, note) for note in _notes(db, book, user)]
    lines += ["## My notes", ""]
    if not notes:
        lines += ["No notes yet. Say \"take a note\" while listening.", ""]
    for number, note in enumerate(notes, 1):
        lines += [f"{number}. {note['text']}",
                  f"   - Where: {place(note['chapter'], note['section'], note['page'])}",
                  f"   - The book was saying: \"{note['quote']}\"", ""]

    bookmarks = db.scalars(select(Bookmark).where(Bookmark.book_id == book.id, Bookmark.user_id == user.id)
                           .order_by(Bookmark.id))
    marks = [_bookmark_out(db, bookmark) for bookmark in bookmarks]
    lines += ["## Bookmarks", ""]
    if not marks:
        lines += ["No bookmarks yet.", ""]
    for number, mark in enumerate(marks, 1):
        lines += [f"{number}. {place(mark['chapter'], mark['section'], mark['page'])}: \"{mark['label']}\""]
    if marks:
        lines.append("")

    messages = list(db.scalars(
        select(ConversationMessage).join(Conversation)
        .where(Conversation.book_id == book.id, Conversation.user_id == user.id).order_by(ConversationMessage.id)))
    lines += ["## Questions I asked", ""]
    if not messages:
        lines += ["No questions yet.", ""]
    number = 0
    for message in messages:
        if message.role == "student":
            number += 1
            where = message.context or {}
            asked_at = place(where.get("chapter", ""), where.get("section", ""), where.get("page", 0))
            lines += [f"{number}. Question: {message.text}"]
            if asked_at:
                lines += [f"   - Asked while reading: {asked_at}"]
        else:
            lines += [f"   - Answer: {message.text}", ""]

    filename = f"{book.id}-study-notes.md"
    return Response(content="\n".join(lines).rstrip() + "\n", media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --- question history -----------------------------------------------------

@router.get("/{book_id}/questions")
def question_history(book: Book = Depends(ready_book), user: User = Depends(current_user),
                     db: Session = Depends(get_db)) -> list[dict]:
    """Recent questions and answers for this book, newest last (for review after a study session)."""
    rows = list(db.scalars(
        select(ConversationMessage).join(Conversation)
        .where(Conversation.book_id == book.id, Conversation.user_id == user.id)
        .order_by(ConversationMessage.id.desc()).limit(40)))
    return [{"id": m.id, "role": m.role, "text": m.text, "intent": m.intent, "sources": m.sources or [],
             "created_at": m.created_at.isoformat()} for m in reversed(rows)]
