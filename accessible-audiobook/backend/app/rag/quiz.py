"""'Quiz me': one spoken comprehension question about the section being read."""
from __future__ import annotations

import json
import random
import re

from ingestion.embeddings import tokenize

from .answerers import Answerer
from .types import LLMError, RetrievedChunk

_DEFINITION = re.compile(
    r"^(?:An? |The )?(?P<term>[A-Za-z][A-Za-z -]{2,40}?) (?:is|are|means|refers to) (?!not\b)(?P<rest>.{20,})$")

_QUIZ_SYSTEM = ("You write one short comprehension question for a blind student, based only on the textbook "
                "passage given. The question will be spoken aloud. Reply with JSON only: "
                '{"question": "...", "answer": "..."} where answer is the ideal one-sentence answer.')
_MARK_SYSTEM = ("You mark a blind student's spoken answer against the textbook's answer. Be encouraging and brief; "
                "the feedback is spoken aloud. Accept answers that are right in substance even if worded "
                'differently. Reply with JSON only: {"verdict": "correct" | "partly" | "incorrect", '
                '"feedback": "one or two short spoken sentences that include the right answer"}')


def _parse_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise LLMError("The model did not return JSON.")
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise LLMError("The model returned invalid JSON.") from exc


def make_question(answerer: Answerer, chunks: list[RetrievedChunk]) -> dict | None:
    """Return {"question", "expected"} or None when the section has nothing to ask about."""
    if not chunks:
        return None
    if not answerer.is_local:
        passage = "\n".join(c.text for c in chunks)[:5000]
        data = _parse_json(answerer.complete(_QUIZ_SYSTEM, f"Textbook passage:\n{passage}"))
        if data.get("question") and data.get("answer"):
            return {"question": str(data["question"]), "expected": str(data["answer"])}
        return None

    # LOCAL FALLBACK: turn a definition sentence ("A page fault is ...") into "What is a page fault?"
    candidates = []
    for chunk in chunks:
        for sentence in chunk.sentences:
            match = _DEFINITION.match(sentence)
            if match and len(match.group("term").split()) <= 5:
                candidates.append((match.group("term").strip(), sentence))
    if not candidates:
        return None
    term, sentence = random.choice(candidates)
    return {"question": f"According to your textbook, what is meant by {term[0].lower() + term[1:]}?",
            "expected": sentence}


def mark_answer(answerer: Answerer, question: str, expected: str, given: str) -> dict:
    """Return {"verdict": correct|partly|incorrect, "feedback": spoken text}."""
    if not answerer.is_local:
        data = _parse_json(answerer.complete(
            _MARK_SYSTEM, f"Question: {question}\nTextbook answer: {expected}\nStudent said: {given}"))
        verdict = data.get("verdict") if data.get("verdict") in ("correct", "partly", "incorrect") else "partly"
        return {"verdict": verdict, "feedback": str(data.get("feedback") or f"The book says: {expected}")}

    # LOCAL FALLBACK: compare key words. Crude, so the feedback always states the book's answer.
    want = set(tokenize(expected)) - set(tokenize(question))
    overlap = len(want & set(tokenize(given))) / len(want) if want else 0.0
    if overlap >= 0.5:
        return {"verdict": "correct", "feedback": f"That matches the book. {expected}"}
    if overlap >= 0.2:
        return {"verdict": "partly", "feedback": f"You have part of it. The book says: {expected}"}
    return {"verdict": "incorrect", "feedback": f"Not quite. The book says: {expected}"}
