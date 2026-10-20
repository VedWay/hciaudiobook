"""Preview how a document will be parsed and chunked:  python -m ingestion path/to/book.pdf"""
import sys

from .chunker import build_chunks
from .pdf_parser import parse_document

if len(sys.argv) != 2:
    sys.exit(__doc__)
doc = parse_document(sys.argv[1])
chunks = build_chunks(doc)
print(f"{doc.title!r} by {doc.author or 'unknown'} - {doc.page_count} pages, {len(chunks)} chunks")
last = None
for i, c in enumerate(chunks):
    if (c.chapter_title, c.section_title) != last:
        last = (c.chapter_title, c.section_title)
        print(f"\n{c.chapter_title}  >  {c.section_title or '(lead-in)'}")
    print(f"  [{i}] p.{c.page} {len(c.sentences)} sentences, {len(c.text)} chars: {c.text[:70]}...")
