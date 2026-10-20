"""Prompts for grounded answers that are meant to be *heard*, not read."""
from __future__ import annotations

import re

from .types import AnswerRequest

NOT_IN_BOOK = "Your textbook doesn't cover that in the parts I can find."

SYSTEM_PROMPT = """\
You are a reading companion for a blind student who is listening to a textbook as an audiobook. \
The student has paused the audiobook to ask you something. Your reply will be converted to speech \
and heard, not read.

Grounding rules:
1. Answer from the textbook excerpts provided. They are the source of truth.
2. Never invent facts, names, dates, numbers or quotations that the excerpts do not support.
3. If the excerpts do not contain the answer, your first sentence must be exactly: "{not_in_book}" {general_rule}
4. Words such as "this", "that" or "it" refer to what the student was just listening to, given under "Just heard".
5. Use the earlier conversation to understand follow-up questions, but the textbook remains the authority.

Speaking rules:
6. Use plain spoken language, in the language the student used: English by default; if they asked in Hindi, \
Marathi or another language, answer in that language and its own script; if they mixed Hindi and English, answer \
the same way. No markdown, bullet points, headings, emoji, or symbols that cannot be read aloud.
7. Use short sentences. Begin with the direct answer. Do not repeat the question or add a preamble.
8. Never refer to anything visual, such as "as shown above" or "see the figure". If a figure or table matters, \
describe in words what it conveys.
9. Say formulas, symbols and abbreviations the way a person would say them aloud.
10. Do not mention "excerpts", "context" or "chunks". Say "your textbook" or "the book".
11. Do not say that you are resuming the audiobook and do not ask whether the student has more questions. \
The audiobook player does that.
12. {length_rule}"""

_GENERAL_ALLOWED = ("You may then add at most two sentences of well-established general knowledge, "
                    "introduced with the words \"Speaking generally,\".")
_GENERAL_FORBIDDEN = "Then stop. Do not answer from outside the textbook."

_LENGTH = {
    "brief": "Keep the answer to two to four sentences, about sixty words.",
    "detailed": "Give a fuller answer of up to about one hundred and fifty words, still in short sentences.",
}

_INTENT = {
    "question": "Answer the student's question.",
    "explain": "Explain the idea in the sentence the student was hearing when they interrupted.",
    "simplify": ("Explain the idea the student was just hearing again in much simpler words, as you would to a "
                 "beginner. An everyday comparison is welcome."),
    "example": ("Give one concrete example of the idea the student was just hearing. Prefer an example from the "
                "textbook. If you must make one up, begin with \"Here is an example of my own.\""),
    "define": "Define the key term in one or two sentences.",
    "summarize": "Summarize the section the student is reading in three or four sentences, covering its main points.",
    "elaborate": "Give more detail on your previous answer, using the textbook.",
}

_RELATION = {"current": "being read now", "heard": "already heard", "ahead": "comes later in the book"}


def system_prompt(req: AnswerRequest) -> str:
    return SYSTEM_PROMPT.format(
        not_in_book=NOT_IN_BOOK,
        general_rule=_GENERAL_ALLOWED if req.allow_general_knowledge else _GENERAL_FORBIDDEN,
        length_rule=_LENGTH.get(req.answer_length, _LENGTH["brief"]),
    )


def user_prompt(req: AnswerRequest) -> str:
    r = req.reading
    where = " > ".join(p for p in (r.chapter, r.section) if p) or "unknown position"
    lines = [f"Book: {req.book_title}", f"The student is in: {where}" + (f", page {r.page}" if r.page else ""), ""]
    if r.recent_context:
        lines += ["Just heard (most recent last):", f'"""{r.recent_context}"""']
    if r.current_sentence:
        lines += ["Sentence in progress when the student interrupted:", f'"""{r.current_sentence}"""']
    lines += ["", "Textbook excerpts:"]
    if not req.chunks:
        lines.append("(nothing relevant was found)")
    for i, c in enumerate(req.chunks, 1):
        label = ", ".join(p for p in (c.chapter, c.section, f"page {c.page}" if c.page else "") if p)
        lines += [f"[{i}] ({label} - {_RELATION[c.relation]})", c.text, ""]
    if req.history:
        lines.append("Earlier in this conversation:")
        lines += [f"{'Student' if role == 'student' else 'You'}: {text}" for role, text in req.history]
        lines.append("")
    instruction = _INTENT.get(req.intent, _INTENT["question"])
    if req.intent == "define" and req.term:
        instruction = f'Define the term "{req.term}" in one or two sentences.'
    lines += [f"Task: {instruction}", f"The student said: {req.question}"]
    return "\n".join(lines)


_MD_PATTERNS = [
    (re.compile(r"```.*?```", re.S), " "),
    (re.compile(r"^\s{0,3}#{1,6}\s*", re.M), ""),
    (re.compile(r"^\s*([-*•]|\d+[.)])\s+", re.M), ""),
    (re.compile(r"[*_`~]{1,3}"), ""),
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),
    (re.compile(r"\s+"), " "),
]


def clean_for_speech(text: str) -> str:
    """Strip any markdown the model produced despite instructions."""
    for pattern, replacement in _MD_PATTERNS:
        text = pattern.sub(replacement, text)
    return text.strip()
