"""Question answering over the book being read."""
from __future__ import annotations

import json
from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Book, User
from ..models.schemas import AskRequest, FindRequest, QuizCheckRequest, QuizRequest
from ..rag import quiz
from ..rag.pipeline import answer_events
from ..rag.types import LLMError, RAGError, ReadingContext
from ..services.providers import get_providers
from .deps import current_user, ready_book

router = APIRouter(prefix="/api/books/{book_id}", tags=["qa"])


@router.post("/ask/stream")
def ask_stream(body: AskRequest, book: Book = Depends(ready_book), user: User = Depends(current_user)):
    """Newline-delimited JSON events: stage, sources, sentence..., done | error."""
    def lines() -> Iterator[str]:
        for event in answer_events(user.id, book.id, body):
            yield json.dumps(event) + "\n"

    # X-Accel-Buffering stops nginx from holding sentences back until the answer is complete.
    return StreamingResponse(lines(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/ask")
def ask(body: AskRequest, book: Book = Depends(ready_book), user: User = Depends(current_user)) -> dict:
    """Non-streaming variant of the same pipeline (handy for scripts and tests)."""
    for event in answer_events(user.id, book.id, body):
        if event["type"] == "done":
            return event
        if event["type"] == "error":
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail={"code": event["code"], "message": event["message"]})
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail={"code": "LLM_FAILED", "message": "No answer was produced."})


@router.post("/find")
def find(body: FindRequest, book: Book = Depends(ready_book), db: Session = Depends(get_db)) -> dict:
    """The places in the book that best match a topic, best first, for 'find the part about ...'."""
    try:
        return {"matches": get_providers().retriever.find(db, book.id, body.query)}
    except RAGError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            detail={"code": "RAG_FAILED", "message": "I couldn't search your textbook just now."}) from None


@router.post("/quiz")
def quiz_question(body: QuizRequest, book: Book = Depends(ready_book), db: Session = Depends(get_db)) -> dict:
    providers = get_providers()
    ctx = body.context
    chunks = providers.retriever.section_chunks(db, book.id, ReadingContext(chunk_id=ctx.chunk_id))
    try:
        question = quiz.make_question(providers.answerer, chunks)
    except LLMError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            detail={"code": "LLM_FAILED", "message": "I couldn't make a quiz question just now."}) from None
    if question is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "NO_QUIZ", "message": "I couldn't find anything to quiz you on in this section."})
    return question


@router.post("/quiz/check")
def quiz_check(body: QuizCheckRequest, _: Book = Depends(ready_book)) -> dict:
    try:
        return quiz.mark_answer(get_providers().answerer, body.question, body.expected, body.answer)
    except LLMError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            detail={"code": "LLM_FAILED", "message": "I couldn't check your answer just now."}) from None
