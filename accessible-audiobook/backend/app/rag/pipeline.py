"""The question-answering pipeline: retrieve -> generate -> stream sentences.

``answer_events`` yields small dict events so the frontend can narrate progress
("Searching your textbook") and start speaking the first sentence of the answer
while the rest is still being generated.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Iterator

from ingestion.chunker import split_sentences

from ..config import get_settings
from ..db import SessionLocal
from ..models import Book, Conversation, ConversationMessage
from ..models.schemas import AskRequest
from ..services.providers import get_providers
from .prompts import NOT_IN_BOOK, clean_for_speech
from .types import AnswerRequest, LLMError, RAGError, ReadingContext

logger = logging.getLogger(__name__)
HISTORY_MESSAGES = 6  # three question/answer turns

SPOKEN_ERRORS = {
    "RAG_FAILED": "I couldn't search your textbook just now. Please try again.",
    "LLM_FAILED": "I found the right part of your textbook, but I couldn't put an answer together. Please try again.",
}


def _history(conversation: Conversation) -> list[tuple[str, str]]:
    return [(m.role, m.text) for m in conversation.messages[-HISTORY_MESSAGES:]]


def _pop_complete_sentences(buffer: str) -> tuple[list[str], str]:
    """Split off the sentences that are certainly finished; the last one may still be growing."""
    sentences = split_sentences(buffer)
    if len(sentences) < 2:
        return [], buffer
    return sentences[:-1], buffer[buffer.rfind(sentences[-1]):]


def answer_events(user_id: str, book_id: str, payload: AskRequest) -> Iterator[dict]:
    """Yield stage / sources / sentence / done / error events for one question."""
    settings = get_settings()
    providers = get_providers()
    started = time.perf_counter()

    def elapsed_ms() -> int:
        return int((time.perf_counter() - started) * 1000)

    # A dedicated session: this generator outlives the request's dependency scope.
    with SessionLocal() as db:
        book = db.get(Book, book_id)
        conversation = db.get(Conversation, payload.conversation_id) if payload.conversation_id else None
        if conversation is None or conversation.user_id != user_id or conversation.book_id != book_id:
            conversation = Conversation(user_id=user_id, book_id=book_id)
            db.add(conversation)
            db.flush()
        history = _history(conversation)

        ctx = payload.context
        reading = ReadingContext(
            chapter=ctx.chapter, section=ctx.section, page=ctx.page, chunk_id=ctx.chunk_id,
            sentence_index=ctx.sentence_index, current_sentence=ctx.current_sentence,
            recent_context=ctx.recent_context,
        )

        yield {"type": "stage", "stage": "retrieving"}
        try:
            retriever = providers.retriever
            if payload.intent == "summarize":
                chunks = retriever.section_chunks(db, book_id, reading, payload.scope)
                query = f"summary of current {payload.scope}"
            else:
                chunks, query = [], ""
            if not chunks:
                chunks, query = retriever.retrieve(
                    db, book_id, payload.question, payload.intent, payload.term, reading, history)
        except RAGError:
            logger.exception("retrieval failed")
            yield {"type": "error", "code": "RAG_FAILED", "message": SPOKEN_ERRORS["RAG_FAILED"]}
            return
        retrieval_ms = elapsed_ms()
        sources = [c.source() for c in chunks]
        yield {"type": "sources", "sources": sources, "query": query}

        yield {"type": "stage", "stage": "generating"}
        request = AnswerRequest(
            book_title=book.title, question=payload.question, intent=payload.intent, term=payload.term,
            reading=reading, chunks=chunks, history=history, answer_length=payload.answer_length,
            allow_general_knowledge=settings.allow_general_knowledge,
        )
        spoken: list[str] = []
        first_sentence_ms = 0
        buffer = ""
        try:
            for delta in providers.answerer.stream(request):
                complete, buffer = _pop_complete_sentences(buffer + delta.replace("\n", " "))
                for sentence in complete:
                    sentence = clean_for_speech(sentence)
                    if sentence:
                        first_sentence_ms = first_sentence_ms or elapsed_ms()
                        spoken.append(sentence)
                        yield {"type": "sentence", "text": sentence}
            tail = clean_for_speech(buffer)
            if tail:
                first_sentence_ms = first_sentence_ms or elapsed_ms()
                spoken.append(tail)
                yield {"type": "sentence", "text": tail}
        except LLMError:
            logger.exception("answer generation failed")
            if not spoken:
                yield {"type": "error", "code": "LLM_FAILED", "message": SPOKEN_ERRORS["LLM_FAILED"]}
                return
            # Part of the answer was already spoken; finish gracefully with what we have.
        if not spoken:
            yield {"type": "error", "code": "LLM_FAILED", "message": SPOKEN_ERRORS["LLM_FAILED"]}
            return

        answer = " ".join(spoken)
        db.add(ConversationMessage(conversation_id=conversation.id, role="student", text=payload.question,
                                   intent=payload.intent, context=ctx.model_dump()))
        reply = ConversationMessage(conversation_id=conversation.id, role="assistant", text=answer,
                                    intent=payload.intent, sources=sources)
        db.add(reply)
        db.commit()

        yield {
            "type": "done",
            "answer": answer,
            "conversation_id": conversation.id,
            "message_id": reply.id,
            "grounded": not answer.startswith(NOT_IN_BOOK),
            "provider": providers.answerer.name,
            "sources": sources,
            "timings": {"retrieval_ms": retrieval_ms, "first_sentence_ms": first_sentence_ms,
                        "total_ms": elapsed_ms()},
        }
