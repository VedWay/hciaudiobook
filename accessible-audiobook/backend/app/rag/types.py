"""Plain data types shared by the retriever, the prompts and the answerers."""
from __future__ import annotations

from dataclasses import dataclass, field

# Requests that are about "whatever I was just listening to" rather than a named topic.
CONTEXT_INTENTS = {"explain", "simplify", "example", "define", "elaborate"}


class RAGError(RuntimeError):
    """Retrieval failed (vector store or embedding provider)."""


class LLMError(RuntimeError):
    """Answer generation failed."""


@dataclass
class ReadingContext:
    """Where the student was in the audiobook when they interrupted."""
    chapter: str = ""
    section: str = ""
    page: int = 0
    chunk_id: int | None = None
    sentence_index: int = 0
    current_sentence: str = ""
    recent_context: str = ""  # the last few sentences heard, oldest first


@dataclass
class RetrievedChunk:
    chunk_id: int
    chunk_index: int
    chapter: str
    section: str
    page: int
    text: str
    sentences: list[str]
    score: float
    relation: str  # "current" | "heard" | "ahead"  (relative to the reading position)

    def source(self) -> dict:
        return {"chunk_id": self.chunk_id, "chapter": self.chapter, "section": self.section,
                "page": self.page, "relation": self.relation, "score": round(self.score, 3)}


@dataclass
class AnswerRequest:
    book_title: str
    question: str
    intent: str = "question"
    term: str = ""  # for "define <term>"
    reading: ReadingContext = field(default_factory=ReadingContext)
    chunks: list[RetrievedChunk] = field(default_factory=list)
    history: list[tuple[str, str]] = field(default_factory=list)  # (role, text), oldest first
    answer_length: str = "brief"  # brief | detailed
    allow_general_knowledge: bool = True
