"""Request / response models (validation happens here)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Intent = Literal["question", "explain", "simplify", "example", "define", "summarize", "elaborate"]


# --- auth -----------------------------------------------------------------

class GuestRequest(BaseModel):
    display_name: str = Field(default="Guest", max_length=80)


class RegisterRequest(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=80)


class LoginRequest(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


class UserOut(BaseModel):
    id: str
    display_name: str
    email: str | None
    is_guest: bool


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# --- playback -------------------------------------------------------------

class PlaybackUpdate(BaseModel):
    """The precise reading position. Sent on every pause/interrupt and periodically while playing."""
    chunk_id: int
    sentence_index: int = Field(ge=0)
    character_offset: int = Field(default=0, ge=0)
    audio_time: float = Field(default=0.0, ge=0)
    playback_speed: float = Field(default=1.0, ge=0.5, le=3.0)
    status: Literal["playing", "paused", "interrupted", "stopped", "finished"] = "paused"
    reason: Literal["autosave", "interrupt", "manual"] = "autosave"


class PlaybackOut(BaseModel):
    book_id: str
    chapter_id: int | None
    chapter_index: int
    chunk_id: int | None
    sentence_index: int
    character_offset: int
    audio_time: float
    playback_speed: float
    status: str
    started: bool
    progress: float  # 0..1 through the whole book
    last_updated: str = ""  # ISO time of the last saved position: lets "continue" pick the book last read


class BookmarkCreate(BaseModel):
    chunk_id: int
    sentence_index: int = Field(default=0, ge=0)
    label: str = Field(default="", max_length=300)


class NoteCreate(BaseModel):
    chunk_id: int
    sentence_index: int = Field(default=0, ge=0)
    text: str = Field(min_length=1, max_length=2000)


class FindRequest(BaseModel):
    """'Find where it talks about ...'"""
    query: str = Field(min_length=1, max_length=300)


# --- question answering ---------------------------------------------------

class AskContext(BaseModel):
    """What the student was listening to at the moment of interruption."""
    chapter: str = Field(default="", max_length=300)
    section: str = Field(default="", max_length=300)
    page: int = Field(default=0, ge=0)
    chunk_id: int | None = None
    sentence_index: int = Field(default=0, ge=0)
    character_offset: int = Field(default=0, ge=0)
    current_sentence: str = Field(default="", max_length=2000)
    recent_context: str = Field(default="", max_length=4000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    intent: Intent = "question"
    term: str = Field(default="", max_length=120)
    scope: Literal["section", "chapter"] = "section"
    answer_length: Literal["brief", "detailed"] = "brief"
    conversation_id: str | None = Field(default=None, max_length=32)
    context: AskContext = Field(default_factory=AskContext)


class QuizRequest(BaseModel):
    context: AskContext


class QuizCheckRequest(BaseModel):
    question: str = Field(max_length=1000)
    expected: str = Field(max_length=2000)
    answer: str = Field(min_length=1, max_length=1000)


class InterpretRequest(BaseModel):
    """A spoken request the frontend's own grammar did not recognise."""
    utterance: str = Field(min_length=1, max_length=500)
    page: str = Field(default="", max_length=40)
    state: str = Field(default="", max_length=40)
    books: list[str] = Field(default_factory=list, max_length=50)
    reading: str = Field(default="", max_length=1500)  # what the app itself was just saying aloud


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    role: Literal["narrator", "assistant"] = "narrator"
    voice: str | None = Field(default=None, max_length=80)  # one of GET /api/speech/voices; otherwise the role's default


# --- evaluation -----------------------------------------------------------

class ParticipantCreate(BaseModel):
    profile: dict = Field(default_factory=dict)


class TrialCreate(BaseModel):
    participant_id: int
    condition: Literal["A", "B"]
    task_id: str = Field(max_length=20)


class TrialEvent(BaseModel):
    t: int = Field(ge=0)  # milliseconds since the trial started
    type: str = Field(max_length=40)
    data: dict = Field(default_factory=dict)


class TrialFinish(BaseModel):
    duration_ms: int = Field(ge=0)
    events: list[TrialEvent] = Field(default_factory=list, max_length=5000)
    completed: bool = True
    comprehension: float | None = Field(default=None, ge=0, le=1)
    notes: str = Field(default="", max_length=2000)


class QuestionnaireSubmit(BaseModel):
    participant_id: int
    condition: Literal["A", "B"]
    kind: Literal["tlx", "sus", "satisfaction"]
    responses: list[float] = Field(min_length=1, max_length=10)
