"""Preloads the sample textbooks.

The sample text is typeset into a real PDF first and then ingested through the
same PDF pipeline as an uploaded book, so the demo exercises the genuine path:
PDF -> text extraction -> heading detection -> chunking -> embeddings -> Qdrant.
"""
from __future__ import annotations

import html
import logging
import re
from pathlib import Path

from ..config import BACKEND_DIR, get_settings
from ..db import SessionLocal
from ..models import Book
from .ingest import backfill_paragraphs, ensure_indexed, ingest_file, resume_interrupted

logger = logging.getLogger(__name__)
SAMPLE_DIR = BACKEND_DIR / "sample_data"
SAMPLES = {"operating-systems": "operating_systems.md", "data-structures": "data_structures.md"}

_CSS = """
body { font-family: serif; font-size: 11pt; line-height: 1.4; }
.title { font-size: 28pt; font-weight: bold; margin-bottom: 30pt; }
h1 { font-size: 20pt; margin-top: 24pt; margin-bottom: 10pt; }
h2 { font-size: 14pt; margin-top: 16pt; margin-bottom: 6pt; }
p { margin-top: 0; margin-bottom: 9pt; }
"""


def read_sample(path: Path) -> tuple[dict[str, str], str]:
    """Split a sample file into its 'key: value' front matter and Markdown body."""
    meta: dict[str, str] = {}
    lines = path.read_text(encoding="utf-8").splitlines()
    while lines and (match := re.match(r"^(title|author|description):\s*(.+)$", lines[0])):
        meta[match.group(1)] = match.group(2).strip()
        lines.pop(0)
    return meta, "\n".join(lines)


def build_sample_pdf(source: Path, target: Path) -> dict[str, str]:
    import fitz  # PyMuPDF

    meta, body = read_sample(source)
    parts = [f'<p class="title">{html.escape(meta.get("title", source.stem))}</p>']
    for block in re.split(r"\n\s*\n", body.strip()):
        block = " ".join(block.split())
        if block.startswith("## "):
            parts.append(f"<h2>{html.escape(block[3:])}</h2>")
        elif block.startswith("# "):
            parts.append(f"<h1>{html.escape(block[2:])}</h1>")
        elif block:
            parts.append(f"<p>{html.escape(block)}</p>")

    target.parent.mkdir(parents=True, exist_ok=True)
    story = fitz.Story(html="".join(parts), user_css=_CSS)
    page_box = fitz.paper_rect("a4")
    content_box = page_box + (72, 72, -72, -72)
    writer = fitz.DocumentWriter(str(target))
    more = True
    while more:
        device = writer.begin_page(page_box)
        more, _ = story.place(content_box)
        story.draw(device)
        writer.end_page()
    writer.close()
    return meta


def seed_sample_books() -> None:
    """Runs at startup (in a background thread). Idempotent."""
    settings = get_settings()
    try:
        if settings.seed_sample_books:
            for book_id, filename in SAMPLES.items():
                with SessionLocal() as db:
                    if db.get(Book, book_id) is not None:
                        continue
                    pdf_path = settings.data_dir / "samples" / f"{book_id}.pdf"
                    meta = build_sample_pdf(SAMPLE_DIR / filename, pdf_path)
                    db.add(Book(id=book_id, owner_id=None, title=meta.get("title", book_id),
                                author=meta.get("author", ""), description=meta.get("description", ""),
                                source_filename=pdf_path.name, status="processing",
                                status_detail="Preparing sample book"))
                    db.commit()
                ingest_file(book_id, pdf_path)
        backfill_paragraphs()
        ensure_indexed()
        resume_interrupted()  # last: describing a big book's pictures can take a long while
    except Exception:
        logger.exception("seeding sample books failed")
