"""Context-aware retrieval.

A question asked in the middle of an audiobook is rarely self-contained
("why is *this* necessary?"). Retrieval therefore combines three signals:

1. semantic similarity (Qdrant) between the chunks and a query built from the
   question *plus* what the student was just hearing when the question is
   contextual,
2. lexical overlap with that query, and
3. proximity to the reading position - the chunk being read, its neighbours
   and its section are boosted, and are always candidates even if the vector
   search misses them.
"""
from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from ingestion.embeddings import Embedder, tokenize
from ingestion.vector_store import QdrantVectorStore

from ..models import DocumentChunk
from .types import CONTEXT_INTENTS, RAGError, ReadingContext, RetrievedChunk

_DEICTIC = re.compile(
    r"\b(this|that|it|its|they|them|these|those|here|he|she|the (term|concept|idea|word|part|section|point))\b", re.I)
SUMMARY_CHAR_BUDGET = 7000


def is_contextual(question: str, intent: str) -> bool:
    """True when the question only makes sense together with the reading position."""
    if intent in CONTEXT_INTENTS:
        return True
    return bool(_DEICTIC.search(question)) or len(tokenize(question)) <= 1


def build_search_query(question: str, intent: str, term: str, reading: ReadingContext,
                       history: list[tuple[str, str]]) -> str:
    if intent == "define" and term:
        return f"{term} definition meaning"
    heard = f"{reading.recent_context} {reading.current_sentence}".strip()[-500:]
    if intent in CONTEXT_INTENTS and intent != "elaborate":
        return heard or question  # the "question" is just a command such as "explain that"
    if not is_contextual(question, intent):
        return question
    previous = next((text for role, text in reversed(history) if role == "student"), "")
    return " ".join(part for part in (question, previous, reading.section, heard) if part)


def _to_retrieved(chunk: DocumentChunk, score: float, current_index: int | None) -> RetrievedChunk:
    if current_index is None:
        relation = "heard"
    elif chunk.chunk_index == current_index:
        relation = "current"
    else:
        relation = "heard" if chunk.chunk_index < current_index else "ahead"
    return RetrievedChunk(
        chunk_id=chunk.id, chunk_index=chunk.chunk_index, chapter=chunk.chapter.title,
        section=chunk.section.title, page=chunk.page, text=chunk.text, sentences=list(chunk.sentences),
        score=score, relation=relation,
    )


class Retriever:
    def __init__(self, embedder: Embedder, store: QdrantVectorStore, top_k: int = 6) -> None:
        self.embedder = embedder
        self.store = store
        self.top_k = top_k

    def _load(self, db: Session, book_id: str, *conditions) -> list[DocumentChunk]:
        stmt = (select(DocumentChunk)
                .options(joinedload(DocumentChunk.chapter), joinedload(DocumentChunk.section))
                .where(DocumentChunk.book_id == book_id, *conditions)
                .order_by(DocumentChunk.chunk_index))
        return list(db.scalars(stmt))

    def section_chunks(self, db: Session, book_id: str, reading: ReadingContext,
                       scope: str = "section") -> list[RetrievedChunk]:
        """Everything in the current section (or chapter), for 'summarize this section'."""
        current = db.get(DocumentChunk, reading.chunk_id) if reading.chunk_id else None
        if current is None or current.book_id != book_id:
            return []
        condition = (DocumentChunk.chapter_id == current.chapter_id if scope == "chapter"
                     else DocumentChunk.section_id == current.section_id)
        out, used = [], 0
        for chunk in self._load(db, book_id, condition):
            if used + len(chunk.text) > SUMMARY_CHAR_BUDGET:
                break
            used += len(chunk.text)
            out.append(_to_retrieved(chunk, 1.0, current.chunk_index))
        return out

    def find(self, db: Session, book_id: str, query: str, limit: int = 3) -> list[dict]:
        """Where in the book is this talked about? Used to *navigate* ("find the part about X").

        Unlike `retrieve`, the reading position plays no part: the listener wants the best
        place in the whole book. Each match points at the single most relevant sentence, so
        reading can start exactly there. Returns nothing when no passage really matches.
        """
        try:
            hits = self.store.search(self.embedder.embed_query(query), book_id, limit=12)
        except Exception as exc:
            raise RAGError(str(exc)) from exc
        if not hits:
            return []
        top_score = max(h.score for h in hits) or 1.0
        terms = set(tokenize(query))
        chunks = {c.id: c for c in self._load(db, book_id, DocumentChunk.id.in_([h.chunk_id for h in hits]))}
        lexical_only = self.embedder.name == "local-hashing"

        scored: list[tuple[float, DocumentChunk]] = []
        for hit in hits:
            chunk = chunks.get(hit.chunk_id)
            if chunk is None:
                continue
            in_text = len(terms & set(tokenize(chunk.text))) / len(terms) if terms else 0.0
            in_title = len(terms & set(tokenize(chunk.section.title))) / len(terms) if terms else 0.0
            # A passage counts as a match if it shares the query's words, or (with a semantic
            # embedding model) if it is close in meaning even though the wording differs.
            if in_text == 0 and in_title == 0 and (lexical_only or hit.score < 0.5):
                continue
            scored.append((0.5 * hit.score / top_score + 0.35 * in_text + 0.15 * in_title, chunk))
        scored.sort(key=lambda pair: pair[0], reverse=True)

        matches = []
        for score, chunk in scored[:limit]:
            overlaps = [len(terms & set(tokenize(sentence))) for sentence in chunk.sentences]
            best = overlaps.index(max(overlaps)) if any(overlaps) else 0
            matches.append({
                "chunk_id": chunk.id, "sentence_index": best, "chapter_index": chunk.chapter.index,
                "chapter": chunk.chapter.title, "section": chunk.section.title, "page": chunk.page,
                "snippet": chunk.sentences[best], "score": round(score, 3),
            })
        return matches

    def retrieve(self, db: Session, book_id: str, question: str, intent: str, term: str,
                 reading: ReadingContext, history: list[tuple[str, str]]) -> tuple[list[RetrievedChunk], str]:
        current = db.get(DocumentChunk, reading.chunk_id) if reading.chunk_id else None
        if current is not None and current.book_id != book_id:
            current = None
        contextual = is_contextual(question, intent) and not (intent == "define" and term)
        query = build_search_query(question, intent, term, reading, history)

        try:
            hits = self.store.search(self.embedder.embed_query(query), book_id, limit=self.top_k * 3)
        except Exception as exc:
            raise RAGError(str(exc)) from exc

        semantic = {h.chunk_id: h.score for h in hits}
        top_score = max(semantic.values(), default=0.0) or 1.0
        candidate_ids = set(semantic)
        if current is not None:
            neighbours = self._load(db, book_id, DocumentChunk.chunk_index.between(
                current.chunk_index - 1, current.chunk_index + 1))
            candidate_ids.update(c.id for c in neighbours)
        if not candidate_ids:
            return [], query

        query_terms = set(tokenize(query))
        near, far = (0.35, 0.20) if contextual else (0.10, 0.05)
        scored: list[tuple[float, DocumentChunk]] = []
        for chunk in self._load(db, book_id, DocumentChunk.id.in_(candidate_ids)):
            lexical = len(query_terms & set(tokenize(chunk.text))) / len(query_terms) if query_terms else 0.0
            score = 0.7 * semantic.get(chunk.id, 0.0) / top_score + 0.3 * lexical
            if current is not None:
                distance = abs(chunk.chunk_index - current.chunk_index)
                if distance == 0:
                    score += near
                elif distance == 1:
                    score += far
                elif chunk.section_id == current.section_id:
                    score += far * 0.6
                elif chunk.chapter_id == current.chapter_id:
                    score += far * 0.25
            scored.append((score, chunk))

        scored.sort(key=lambda pair: pair[0], reverse=True)
        selected = scored[: self.top_k]
        if contextual and current is not None and all(c.id != current.id for _, c in selected):
            selected[-1] = next(pair for pair in scored if pair[1].id == current.id)
        current_index = current.chunk_index if current is not None else None
        chunks = [_to_retrieved(chunk, score, current_index) for score, chunk in selected]
        chunks.sort(key=lambda c: c.chunk_index)  # reading order keeps the prompt coherent
        return chunks, query
