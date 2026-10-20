"""Structure-aware chunking.

Chunks never cross a section boundary and are built from whole paragraphs
(falling back to whole sentences for very long paragraphs), so each chunk is a
coherent unit of meaning rather than an arbitrary N-character slice.

The *reading* text of a chunk has no overlap - otherwise the audiobook would
read sentences twice. Overlap is kept separately in ``overlap`` and is only
used when building the text that gets embedded.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .pdf_parser import ParsedDocument

TARGET_CHARS = 900
MAX_CHARS = 1300

_ABBREVIATIONS = {
    "e.g", "i.e", "etc", "vs", "fig", "figs", "dr", "mr", "mrs", "ms", "prof", "no", "eq",
    "sec", "ch", "approx", "inc", "ltd", "cf", "al", "st", "vol", "pp", "ed",
}
_TERMINATOR = re.compile(r"[.!?]+[\"'”’)\]]*\s+")


def split_sentences(text: str) -> list[str]:
    """Split text into sentences without breaking on abbreviations or initials."""
    sentences: list[str] = []
    start = 0
    for match in _TERMINATOR.finditer(text):
        if text[match.start()] == ".":
            before = text[start:match.start()].split()
            last_word = before[-1].lower().strip("(\"'") if before else ""
            if last_word in _ABBREVIATIONS or (len(last_word) == 1 and last_word.isalpha()):
                continue
            if text[match.end():match.end() + 1].islower():
                continue
        sentence = text[start:match.end()].strip()
        if sentence:
            sentences.append(sentence)
        start = match.end()
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


@dataclass
class Chunk:
    chapter_index: int
    chapter_title: str
    section_index: int
    section_title: str
    page: int
    sentences: list[str] = field(default_factory=list)
    # Index (into `sentences`) of the first sentence of each paragraph that starts in this chunk.
    # Lets the audiobook "skim": read only the opening sentence of every paragraph.
    paragraph_starts: list[int] = field(default_factory=list)
    overlap: str = ""  # trailing sentence of the previous chunk in the same section

    @property
    def text(self) -> str:
        return " ".join(self.sentences)

    @property
    def embedding_text(self) -> str:
        heading = " - ".join(t for t in (self.chapter_title, self.section_title) if t)
        body = f"{self.overlap} {self.text}".strip()
        return f"{heading}\n{body}" if heading else body


def build_chunks(doc: ParsedDocument, target_chars: int = TARGET_CHARS, max_chars: int = MAX_CHARS) -> list[Chunk]:
    chunks: list[Chunk] = []
    chapter_index, section_index = -1, 0
    chapter_title, section_title = "", ""
    current: Chunk | None = None
    last_sentence = ""  # last sentence emitted in the current section

    def close() -> None:
        nonlocal current
        if current and current.sentences:
            chunks.append(current)
        current = None

    def open_chunk(page: int) -> Chunk:
        return Chunk(chapter_index, chapter_title, section_index, section_title, page, overlap=last_sentence)

    for block in doc.blocks:
        if block.kind == "heading":
            close()
            last_sentence = ""
            if block.level == 1:
                chapter_index += 1
                chapter_title, section_index, section_title = block.text, 0, ""
            else:
                if chapter_index < 0:
                    chapter_index, chapter_title = 0, doc.title
                # Section 0 is the untitled lead-in before a chapter's first section heading.
                used = section_title or any(c.chapter_index == chapter_index for c in chunks)
                section_index = section_index + 1 if used else 0
                section_title = block.text
            continue

        if chapter_index < 0:
            chapter_index, chapter_title = 0, doc.title
        sentences = split_sentences(block.text)
        if not sentences:
            continue
        paragraph_len = sum(len(s) + 1 for s in sentences)

        if paragraph_len <= max_chars:
            # Keep the paragraph whole; start a new chunk if it would overflow.
            if current and len(current.text) + paragraph_len > max_chars:
                close()
            if current is None:
                current = open_chunk(block.page)
            current.paragraph_starts.append(len(current.sentences))
            current.sentences.extend(sentences)
            last_sentence = sentences[-1]
            if len(current.text) >= target_chars:
                close()
        else:
            # Oversized paragraph: split on sentence boundaries. Only its first piece starts a paragraph.
            close()
            for position, sentence in enumerate(sentences):
                if current and len(current.text) + len(sentence) > target_chars:
                    close()
                if current is None:
                    current = open_chunk(block.page)
                if position == 0:
                    current.paragraph_starts.append(len(current.sentences))
                current.sentences.append(sentence)
                last_sentence = sentence
            close()
    close()
    return chunks
