"""Turn a PDF (or plain-text / Markdown file) into an ordered list of blocks.

A block is either a heading (level 1 = chapter, level 2 = section) or a
paragraph. Headings are detected from typography (font size / weight relative
to the body text) and from common numbering patterns, so the reading order and
the chapter/section structure survive into the audiobook and the RAG metadata.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

CHAPTER_RE = re.compile(r"^(chapter|unit|module|part|lecture)\s+(\d+|[ivxlc]+)\b", re.I)
SECTION_RE = re.compile(r"^\d+\.\d+(\.\d+)*\s+\S")
PAGE_NUMBER_RE = re.compile(r"^(page\s+)?\d+(\s*(of|/)\s*\d+)?$", re.I)
SENTENCE_END = (".", "!", "?", ":", '"', "”", ")")

LIGATURES = {
    "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
    "­": "", "‐": "-", "‑": "-", " ": " ",
}


class DocumentParseError(ValueError):
    """Raised with a message that is safe to show (and speak) to the user."""


@dataclass
class Block:
    kind: str  # "heading" | "paragraph"
    text: str
    page: int  # 1-based; 0 when the source has no pages (plain text)
    level: int = 0  # headings only: 1 = chapter, 2 = section


@dataclass
class ParsedDocument:
    title: str
    author: str
    page_count: int
    blocks: list[Block]


def clean_text(text: str) -> str:
    for src, dst in LIGATURES.items():
        text = text.replace(src, dst)
    text = re.sub(r"[•●▪◦]\s*", "", text)  # bullet glyphs read badly aloud
    return re.sub(r"\s+", " ", text).strip()


@dataclass
class _Segment:
    text: str
    page: int
    size: float
    bold: bool
    y_ratio: float  # vertical centre as a fraction of page height
    image: bytes | None = None  # a picture (JPEG) waiting to be described; its text is filled in later


PICTURE_PREFIX = "Picture. "
_MIN_PICTURE_SIDE = 70  # points; smaller images are icons, bullets and rules
_MIN_PICTURE_AREA = 0.02  # of the page
_PICTURE_PIXELS = 640  # longest side sent to the vision model: enough to read a diagram, and a third fewer tokens than 900


def _page_pictures(page, page_index: int) -> list[tuple[float, _Segment]]:
    """The pictures on a page, each with the y position of its top edge, rendered as the reader would see them."""
    import fitz

    found: list[tuple[float, _Segment]] = []
    page_area = (page.rect.width * page.rect.height) or 1.0
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 1:
            continue
        rect = fitz.Rect(block["bbox"]) & page.rect
        if (rect.is_empty or min(rect.width, rect.height) < _MIN_PICTURE_SIDE
                or rect.width * rect.height < _MIN_PICTURE_AREA * page_area):
            continue
        scale = min(2.0, _PICTURE_PIXELS / max(rect.width, rect.height))
        try:
            jpeg = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rect, alpha=False).tobytes("jpeg")
        except Exception:
            continue  # an image the renderer cannot handle is skipped, never fatal
        y_ratio = (rect.y0 + rect.y1) / 2 / (page.rect.height or 1.0)
        found.append((rect.y0, _Segment(text="", page=page_index + 1, size=0.0, bold=False, y_ratio=y_ratio, image=jpeg)))
    return found


def _describe_pictures(segments: list[_Segment], describe, limit: int, on_progress=None) -> list[_Segment]:
    """Replace each picture with its spoken description; drop decoration and anything that fails.
    ``on_progress(done, total)`` is called from the calling thread as each picture is finished."""
    import hashlib
    from concurrent.futures import ThreadPoolExecutor

    pictures = [s for s in segments if s.image is not None]
    seen = Counter(hashlib.sha1(s.image).hexdigest() for s in pictures)
    page_text: dict[int, str] = {}
    for s in segments:
        if s.image is None:
            page_text[s.page] = f"{page_text.get(s.page, '')} {s.text}".strip()

    # The same image on several pages is a logo or a running ornament, not part of the story.
    wanted = [s for s in pictures if seen[hashlib.sha1(s.image).hexdigest()] < 3][:limit]

    def run(segment: _Segment) -> None:
        try:
            text = clean_text(describe(segment.image, page_text.get(segment.page, "")) or "")
        except Exception:
            text = ""  # one picture failing must not lose the book
        if text:
            segment.text = PICTURE_PREFIX + (text if text.endswith((".", "!", "?")) else f"{text}.")

    if wanted:
        # Few at a time: vision services allow only so many requests a minute.
        with ThreadPoolExecutor(max_workers=3) as pool:
            for done, _ in enumerate(pool.map(run, wanted), 1):
                if on_progress:
                    on_progress(done, len(wanted))
    for s in pictures:
        s.image = None  # free the pixels
    return [s for s in segments if s.text]


def _join_lines(lines: list[str]) -> str:
    out = ""
    for line in lines:
        if not out:
            out = line
        elif out.endswith("-") and line[:1].islower():
            out = out[:-1] + line  # re-join a word hyphenated across lines
        else:
            out = f"{out} {line}"
    return clean_text(out)


def _extract_segments(doc, with_pictures: bool = False) -> list[_Segment]:
    """One segment per run of lines that share a block and a font size/weight (plus the pictures, if wanted)."""
    segments: list[_Segment] = []
    for page_index, page in enumerate(doc):
        height = page.rect.height or 1.0
        page_start = len(segments)
        tops: list[float] = []  # top edge of each text segment added for this page
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue  # image block
            run_lines: list[str] = []
            run_y: list[float] = []
            run_key: tuple[float, bool] | None = None

            def flush() -> None:
                if run_lines and run_key is not None:
                    text = _join_lines(run_lines)
                    if text:
                        segments.append(_Segment(
                            text=text, page=page_index + 1, size=run_key[0], bold=run_key[1],
                            y_ratio=sum(run_y) / len(run_y) / height,
                        ))
                        tops.append(min(run_y))

            for line in block["lines"]:
                spans = [s for s in line["spans"] if s["text"].strip()]
                if not spans:
                    continue
                weights: Counter = Counter()
                bold_chars = 0
                for s in spans:
                    n = len(s["text"].strip())
                    weights[round(s["size"] * 2) / 2] += n
                    if s["flags"] & 16 or "bold" in s["font"].lower():
                        bold_chars += n
                key = (weights.most_common(1)[0][0], bold_chars > 0.6 * sum(weights.values()))
                if run_key is not None and key != run_key:
                    flush()
                    run_lines, run_y = [], []
                run_key = key
                run_lines.append("".join(s["text"] for s in line["spans"]).strip())
                run_y.append((line["bbox"][1] + line["bbox"][3]) / 2)
            flush()
        if with_pictures:
            # Each picture is read after the last piece of text that starts above it on the page.
            for top, picture in sorted(_page_pictures(page, page_index), key=lambda item: -item[0]):
                after = max((i for i, y in enumerate(tops) if y < top), default=-1)
                segments.insert(page_start + after + 1, picture)
    return segments


def _strip_running_headers(segments: list[_Segment], page_count: int) -> list[_Segment]:
    """Drop page numbers and headers/footers that repeat across pages."""
    def norm(text: str) -> str:
        return re.sub(r"\d+", "#", text.lower())

    def at_edge(s: _Segment) -> bool:
        return s.image is None and (s.y_ratio < 0.08 or s.y_ratio > 0.92)

    repeats = Counter(norm(s.text) for s in segments if at_edge(s))
    threshold = max(3, page_count // 2)
    return [
        s for s in segments
        if not (at_edge(s) and (PAGE_NUMBER_RE.match(s.text) or repeats[norm(s.text)] >= threshold))
    ]


def parse_pdf(path: str | Path, describe=None, max_pictures: int = 80, on_progress=None) -> ParsedDocument:
    """``describe(jpeg_bytes, text_on_the_page) -> str`` puts each picture into words; without it pictures are skipped.
    ``on_progress(done, total)`` reports how many pictures have been described."""
    import fitz  # PyMuPDF

    path = Path(path)
    try:
        doc = fitz.open(path)
    except Exception as exc:  # PyMuPDF raises several unrelated exception types
        raise DocumentParseError("This file could not be opened as a PDF.") from exc
    with doc:
        if doc.needs_pass:
            raise DocumentParseError("This PDF is password protected and cannot be read.")
        page_count = doc.page_count
        segments = _strip_running_headers(_extract_segments(doc, with_pictures=describe is not None), page_count)
        meta = doc.metadata or {}
    if describe is not None:
        segments = _describe_pictures(segments, describe, max_pictures, on_progress)

    # A picture book may have very little text of its own: the picture descriptions count too.
    if sum(len(s.text) for s in segments) < 200:
        raise DocumentParseError(
            "No readable text was found in this PDF. It may be a scanned document; "
            "scanned books need OCR before they can be used."
        )

    sizes: Counter = Counter()
    for s in segments:
        if s.size:  # pictures have no font size
            sizes[s.size] += len(s.text)
    body_size = sizes.most_common(1)[0][0] if sizes else 12.0

    def is_heading(s: _Segment) -> bool:
        if not s.size or len(s.text) > 140 or s.text.endswith((".", ",", ";")):
            return False
        if CHAPTER_RE.match(s.text) and len(s.text) < 100:
            return True
        if s.size >= body_size * 1.12:
            return True
        return s.bold and s.size >= body_size * 0.98 and len(s.text.split()) <= 12

    heading_sizes = sorted({s.size for s in segments if is_heading(s) and s.size > body_size * 1.05}, reverse=True)

    # A single, largest heading on the first page is the book title, not a chapter.
    title_text = ""
    if len(heading_sizes) >= 2:
        top = [s for s in segments if is_heading(s) and s.size == heading_sizes[0]]
        if len(top) == 1 and top[0].page == 1:
            title_text = top[0].text
            heading_sizes = heading_sizes[1:]

    def level_of(s: _Segment) -> int:
        if CHAPTER_RE.match(s.text):
            return 1
        if SECTION_RE.match(s.text):
            return 2
        if heading_sizes and s.size == heading_sizes[0]:
            return 1
        return 2

    blocks: list[Block] = []
    for s in segments:
        if title_text and s.text == title_text and s.page == 1:
            continue
        if is_heading(s):
            blocks.append(Block("heading", s.text, s.page, level_of(s)))
            continue
        prev = blocks[-1] if blocks else None
        if (s.size and prev is not None and prev.kind == "paragraph" and not prev.text.startswith(PICTURE_PREFIX)
                and not prev.text.endswith(SENTENCE_END) and s.text[:1].islower()):
            # paragraph broken by a page or column boundary
            joiner = "" if prev.text.endswith("-") else " "
            prev.text = clean_text(prev.text.rstrip("-") + joiner + s.text)
        else:
            blocks.append(Block("paragraph", s.text, s.page))

    if not any(b.kind == "heading" and b.level == 1 for b in blocks):
        for b in blocks:  # only one heading tier was found: treat it as chapters
            if b.kind == "heading":
                b.level = 1

    title = (clean_text(meta.get("title") or "") or title_text
             or path.stem.replace("_", " ").replace("-", " ").title())
    return ParsedDocument(title=title, author=clean_text(meta.get("author") or ""),
                          page_count=page_count, blocks=blocks)


def parse_text(path: str | Path) -> ParsedDocument:
    """Parse a .txt / .md file. ``#`` marks a chapter and ``##`` a section."""
    path = Path(path)
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise DocumentParseError("This text file is not valid UTF-8.") from exc

    blocks: list[Block] = []
    title = author = ""
    paragraph: list[str] = []

    def flush() -> None:
        if paragraph:
            blocks.append(Block("paragraph", clean_text(" ".join(paragraph)), 0))
            paragraph.clear()

    for line in raw.splitlines():
        stripped = line.strip()
        if not blocks and not paragraph:  # optional "key: value" front matter
            meta = re.match(r"^(title|author|description):\s*(.+)$", stripped, re.I)
            if meta:
                key = meta.group(1).lower()
                title = meta.group(2) if key == "title" else title
                author = meta.group(2) if key == "author" else author
                continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading:
            flush()
            blocks.append(Block("heading", clean_text(heading.group(2)), 0, 1 if len(heading.group(1)) == 1 else 2))
        elif CHAPTER_RE.match(stripped) and len(stripped) < 100:
            flush()
            blocks.append(Block("heading", clean_text(stripped), 0, 1))
        elif not stripped:
            flush()
        else:
            paragraph.append(stripped)
    flush()

    if sum(len(b.text) for b in blocks) < 200:
        raise DocumentParseError("This file does not contain enough text to make an audiobook.")
    return ParsedDocument(title=title or path.stem.replace("_", " ").replace("-", " ").title(),
                          author=author, page_count=0, blocks=blocks)


def parse_document(path: str | Path, describe=None, max_pictures: int = 80, on_progress=None) -> ParsedDocument:
    path = Path(path)
    return parse_pdf(path, describe, max_pictures, on_progress) if path.suffix.lower() == ".pdf" else parse_text(path)
