"""Database schema.

Book -> Chapter -> Section -> DocumentChunk is the reading structure.
ReadingSession holds a user's *current* precise position in a book;
PlaybackState is the append-only history of checkpoints (one per interruption).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    display_name: Mapped[str] = mapped_column(String(80), default="Guest")
    email: Mapped[str | None] = mapped_column(String(254), unique=True, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
    is_guest: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Book(Base):
    __tablename__ = "books"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)  # None = shared sample
    title: Mapped[str] = mapped_column(String(200))
    author: Mapped[str] = mapped_column(String(200), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    source_filename: Mapped[str] = mapped_column(String(200), default="")
    total_pages: Mapped[int] = mapped_column(Integer, default=0)
    total_chunks: Mapped[int] = mapped_column(Integer, default=0)
    total_chars: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="processing")  # processing | ready | failed
    status_detail: Mapped[str] = mapped_column(String(300), default="")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    chapters: Mapped[list[Chapter]] = relationship(
        back_populates="book", cascade="all, delete-orphan", order_by="Chapter.index")


class Chapter(Base):
    __tablename__ = "chapters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    index: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(300))
    start_page: Mapped[int] = mapped_column(Integer, default=0)
    char_count: Mapped[int] = mapped_column(Integer, default=0)

    book: Mapped[Book] = relationship(back_populates="chapters")
    sections: Mapped[list[Section]] = relationship(
        back_populates="chapter", cascade="all, delete-orphan", order_by="Section.index")


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), index=True)
    index: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(300), default="")  # "" = lead-in before the first heading

    chapter: Mapped[Chapter] = relationship(back_populates="sections")
    chunks: Mapped[list[DocumentChunk]] = relationship(
        back_populates="section", cascade="all, delete-orphan", order_by="DocumentChunk.chunk_index")


class DocumentChunk(Base):
    """A paragraph-sized unit of the book. Its id is also the Qdrant point id."""
    __tablename__ = "document_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), index=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id", ondelete="CASCADE"), index=True)
    chunk_index: Mapped[int] = mapped_column(Integer)  # reading order within the whole book
    page: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text)
    sentences: Mapped[list[str]] = mapped_column(JSON)
    # Sentence indices at which a paragraph begins. NULL for books ingested before this was recorded.
    paragraph_starts: Mapped[list[int] | None] = mapped_column(JSON(none_as_null=True), nullable=True)
    embedding_text: Mapped[str] = mapped_column(Text)  # heading + overlap + text, what was embedded

    section: Mapped[Section] = relationship(back_populates="chunks")
    chapter: Mapped[Chapter] = relationship()


class ReadingSession(Base):
    __tablename__ = "reading_sessions"
    __table_args__ = (UniqueConstraint("user_id", "book_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    current_chunk_id: Mapped[int | None] = mapped_column(
        ForeignKey("document_chunks.id", ondelete="SET NULL"), nullable=True)
    sentence_index: Mapped[int] = mapped_column(Integer, default=0)
    character_offset: Mapped[int] = mapped_column(Integer, default=0)
    audio_time: Mapped[float] = mapped_column(Float, default=0.0)  # estimated seconds into the chapter at 1x
    playback_speed: Mapped[float] = mapped_column(Float, default=1.0)
    status: Mapped[str] = mapped_column(String(20), default="paused")
    started: Mapped[bool] = mapped_column(Boolean, default=False)
    last_updated: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class PlaybackState(Base):
    """Checkpoint of the exact position at an interruption (or other notable moment)."""
    __tablename__ = "playback_states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("reading_sessions.id", ondelete="CASCADE"), index=True)
    chapter_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chunk_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sentence_index: Mapped[int] = mapped_column(Integer, default=0)
    character_offset: Mapped[int] = mapped_column(Integer, default=0)
    audio_time: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(20), default="paused")
    reason: Mapped[str] = mapped_column(String(20), default="interrupt")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    messages: Mapped[list[ConversationMessage]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="ConversationMessage.id")


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(12))  # student | assistant
    text: Mapped[str] = mapped_column(Text)
    intent: Mapped[str] = mapped_column(String(20), default="")
    context: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # reading position when asked
    sources: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class Bookmark(Base):
    __tablename__ = "bookmarks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    chunk_id: Mapped[int] = mapped_column(ForeignKey("document_chunks.id", ondelete="CASCADE"))
    sentence_index: Mapped[int] = mapped_column(Integer, default=0)
    label: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Note(Base):
    """A study note the student dictated or typed, pinned to the sentence they were hearing."""
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    chunk_id: Mapped[int] = mapped_column(ForeignKey("document_chunks.id", ondelete="CASCADE"))
    sentence_index: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


# --- HCI evaluation -------------------------------------------------------

class EvalParticipant(Base):
    __tablename__ = "eval_participants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)  # anonymous, e.g. "P03"
    profile: Mapped[dict] = mapped_column(JSON, default=dict)
    condition_order: Mapped[str] = mapped_column(String(2), default="AB")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    trials: Mapped[list[EvalTrial]] = relationship(back_populates="participant", cascade="all, delete-orphan")
    questionnaires: Mapped[list[EvalQuestionnaire]] = relationship(
        back_populates="participant", cascade="all, delete-orphan")


class EvalTrial(Base):
    __tablename__ = "eval_trials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    participant_id: Mapped[int] = mapped_column(ForeignKey("eval_participants.id", ondelete="CASCADE"), index=True)
    condition: Mapped[str] = mapped_column(String(1))  # A = traditional audiobook, B = RAG audiobook
    task_id: Mapped[str] = mapped_column(String(20))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished: Mapped[bool] = mapped_column(Boolean, default=False)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)  # did the participant reach an answer?
    comprehension: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0, 0.5 or 1
    notes: Mapped[str] = mapped_column(Text, default="")
    events: Mapped[list] = mapped_column(JSON, default=list)  # [{t, type, data}]
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)

    participant: Mapped[EvalParticipant] = relationship(back_populates="trials")


class EvalQuestionnaire(Base):
    __tablename__ = "eval_questionnaires"
    __table_args__ = (UniqueConstraint("participant_id", "condition", "kind"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    participant_id: Mapped[int] = mapped_column(ForeignKey("eval_participants.id", ondelete="CASCADE"), index=True)
    condition: Mapped[str] = mapped_column(String(1))
    kind: Mapped[str] = mapped_column(String(20))  # tlx | sus | satisfaction
    responses: Mapped[list] = mapped_column(JSON, default=list)
    score: Mapped[float] = mapped_column(Float, default=0.0)

    participant: Mapped[EvalParticipant] = relationship(back_populates="questionnaires")
