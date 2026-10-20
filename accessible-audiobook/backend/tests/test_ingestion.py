from ingestion.chunker import MAX_CHARS, build_chunks, split_sentences
from ingestion.embeddings import LocalHashingEmbedder
from ingestion.pdf_parser import Block, ParsedDocument, parse_pdf
from ingestion.vector_store import QdrantVectorStore

from app.services.seed import SAMPLE_DIR, build_sample_pdf


def test_split_sentences_keeps_abbreviations_and_decimals_together():
    text = "Paging, e.g. with 4.5 kilobyte pages, is common. Dr. Denning proposed it! Is it used? Yes"
    assert split_sentences(text) == [
        "Paging, e.g. with 4.5 kilobyte pages, is common.", "Dr. Denning proposed it!", "Is it used?", "Yes"]


def test_chunks_respect_sections_and_never_repeat_reading_text():
    doc = ParsedDocument("Book", "", 1, [
        Block("heading", "Chapter 1: One", 1, 1),
        Block("paragraph", "Lead in sentence. " * 3, 1),
        Block("heading", "First", 1, 2),
        Block("paragraph", "Alpha sentence here. " * 30, 1),
        Block("paragraph", "Beta sentence here. " * 30, 2),
        Block("heading", "Second", 2, 2),
        Block("paragraph", "Gamma sentence here. " * 100, 2),  # longer than MAX_CHARS: split on sentences
    ])
    chunks = build_chunks(doc)

    assert [c.section_title for c in chunks[:2]] == ["", "First"]
    assert all(len(c.text) <= MAX_CHARS for c in chunks)
    for c in chunks:  # a chunk holds text from exactly one section
        words = {s.split()[0] for s in c.sentences}
        assert len(words) == 1 or c.section_title == "First"
        assert not (c.section_title == "Second" and words != {"Gamma"})
    # Reading text is a partition of the source: nothing is duplicated by the overlap.
    assert sum(len(c.sentences) for c in chunks) == 3 + 30 + 30 + 100
    # ...while the overlap still reaches the embedding text.
    later = [c for c in chunks if c.section_title == "Second"][1]
    assert later.overlap == "Gamma sentence here." and later.embedding_text.count("Gamma") == len(later.sentences) + 1
    assert chunks[1].overlap == ""  # overlap never leaks across a section boundary


def test_chunks_record_where_each_paragraph_starts():
    doc = ParsedDocument("Book", "", 1, [
        Block("heading", "Chapter 1: One", 1, 1),
        Block("paragraph", "First one. First two.", 1),
        Block("paragraph", "Second one. Second two. Second three.", 1),
        Block("paragraph", "Long sentence here. " * 100, 1),  # one paragraph spread over several chunks
    ])
    chunks = build_chunks(doc)

    assert chunks[0].sentences[:3] == ["First one.", "First two.", "Second one."]
    assert chunks[0].paragraph_starts == [0, 2]
    assert chunks[1].paragraph_starts == [0]
    assert len(chunks) > 3 and all(c.paragraph_starts == [] for c in chunks[2:])  # continuations start no paragraph


def test_sample_pdf_round_trip_detects_title_chapters_and_sections(tmp_path):
    pdf = tmp_path / "os.pdf"
    build_sample_pdf(SAMPLE_DIR / "operating_systems.md", pdf)
    doc = parse_pdf(pdf)

    assert doc.title == "Operating Systems"
    assert doc.page_count >= 3
    chapters = [b.text for b in doc.blocks if b.kind == "heading" and b.level == 1]
    assert chapters == ["Chapter 1: Memory Management Basics", "Chapter 2: Paging", "Chapter 3: Virtual Memory"]
    sections = [b.text for b in doc.blocks if b.kind == "heading" and b.level == 2]
    assert "What Is Virtual Memory?" in sections and "The Translation Lookaside Buffer" in sections
    assert len(sections) == 11

    chunks = build_chunks(doc)
    target = next(c for c in chunks if c.section_title == "What Is Virtual Memory?")
    assert target.chapter_title == "Chapter 3: Virtual Memory" and target.page > 0
    assert target.sentences[0].startswith("Virtual memory allows a process to use more memory")


def test_qdrant_store_filters_by_book():
    embedder = LocalHashingEmbedder()
    store = QdrantVectorStore(collection="test", dim=embedder.dim, embedder_name=embedder.name)
    texts = ["A page fault happens when a page is not in memory.", "A stack is last in, first out."]
    store.upsert([1, 2], embedder.embed_documents(texts), [{"book_id": "os"}, {"book_id": "ds"}])

    hits = store.search(embedder.embed_query("what is a page fault"), "os")
    assert [h.chunk_id for h in hits] == [1]
    assert store.count("ds") == 1
    store.delete_book("ds")
    assert store.count("ds") == 0
