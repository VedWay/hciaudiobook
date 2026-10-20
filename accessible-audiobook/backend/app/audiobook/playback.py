"""Reading structure and precise playback-state persistence.

The position is stored as (chunk, sentence index, character offset) rather than
a page number or a timestamp, because that is what lets the audiobook resume on
the exact word after an interruption regardless of voice or speed.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..models import Book, Chapter, DocumentChunk, PlaybackState, ReadingSession, Section, User
from ..models.schemas import PlaybackOut, PlaybackUpdate


def get_session(db: Session, user: User, book: Book) -> ReadingSession:
    """The user's reading session for a book, created at the first sentence if new."""
    session = db.scalar(select(ReadingSession).where(
        ReadingSession.user_id == user.id, ReadingSession.book_id == book.id))
    if session is None:
        first = db.scalar(select(DocumentChunk).where(DocumentChunk.book_id == book.id)
                          .order_by(DocumentChunk.chunk_index).limit(1))
        session = ReadingSession(user_id=user.id, book_id=book.id,
                                 chapter_id=first.chapter_id if first else None,
                                 current_chunk_id=first.id if first else None)
        db.add(session)
        db.commit()
    return session


def session_out(db: Session, session: ReadingSession, book: Book) -> PlaybackOut:
    chunk = db.get(DocumentChunk, session.current_chunk_id) if session.current_chunk_id else None
    progress = 0.0
    if chunk is not None and book.total_chunks:
        within = session.sentence_index / max(1, len(chunk.sentences))
        progress = min(1.0, (chunk.chunk_index + within) / book.total_chunks)
    if session.status == "finished":
        progress = 1.0
    return PlaybackOut(
        book_id=book.id, chapter_id=session.chapter_id,
        chapter_index=chunk.chapter.index if chunk is not None else 0,
        chunk_id=session.current_chunk_id, sentence_index=session.sentence_index,
        character_offset=session.character_offset, audio_time=session.audio_time,
        playback_speed=session.playback_speed, status=session.status, started=session.started,
        progress=progress,
        last_updated=session.last_updated.isoformat() if session.last_updated else "",
    )


def save_position(db: Session, session: ReadingSession, book: Book, update: PlaybackUpdate) -> None:
    chunk = db.get(DocumentChunk, update.chunk_id)
    if chunk is None or chunk.book_id != book.id:
        raise HTTPException(status_code=422, detail="That position is not in this book.")
    sentence_index = min(update.sentence_index, len(chunk.sentences) - 1)
    offset = min(update.character_offset, len(chunk.sentences[sentence_index]))

    session.chapter_id = chunk.chapter_id
    session.current_chunk_id = chunk.id
    session.sentence_index = sentence_index
    session.character_offset = offset
    session.audio_time = update.audio_time
    session.playback_speed = update.playback_speed
    session.status = update.status
    session.started = True
    if update.reason != "autosave":
        db.add(PlaybackState(
            session_id=session.id, chapter_id=chunk.chapter_id, chunk_id=chunk.id,
            sentence_index=sentence_index, character_offset=offset, audio_time=update.audio_time,
            status=update.status, reason=update.reason,
        ))
    db.commit()


def reset_position(db: Session, session: ReadingSession, book: Book) -> None:
    first = db.scalar(select(DocumentChunk).where(DocumentChunk.book_id == book.id)
                      .order_by(DocumentChunk.chunk_index).limit(1))
    session.chapter_id = first.chapter_id if first else None
    session.current_chunk_id = first.id if first else None
    session.sentence_index = session.character_offset = 0
    session.audio_time = 0.0
    session.status = "paused"
    session.started = False
    db.commit()


def outline(db: Session, book: Book) -> list[dict]:
    chapters = db.scalars(select(Chapter).where(Chapter.book_id == book.id)
                          .options(selectinload(Chapter.sections)).order_by(Chapter.index))
    return [{
        "id": c.id, "index": c.index, "title": c.title, "start_page": c.start_page,
        "char_count": c.char_count,
        "sections": [{"id": s.id, "index": s.index, "title": s.title} for s in c.sections],
    } for c in chapters]


def chapter_content(db: Session, book: Book, chapter_index: int) -> dict:
    """Everything the player needs to read one chapter aloud, sentence by sentence."""
    chapter = db.scalar(select(Chapter).where(Chapter.book_id == book.id, Chapter.index == chapter_index)
                        .options(selectinload(Chapter.sections).selectinload(Section.chunks)))
    if chapter is None:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return {
        "id": chapter.id, "index": chapter.index, "title": chapter.title,
        "sections": [{
            "id": s.id, "index": s.index, "title": s.title,
            "chunks": [{
                "id": c.id, "chunk_index": c.chunk_index, "page": c.page, "sentences": c.sentences,
                # Unknown for older books: fall back to treating each chunk as one paragraph.
                "paragraph_starts": c.paragraph_starts if c.paragraph_starts is not None else [0],
            } for c in s.chunks],
        } for s in chapter.sections],
    }
