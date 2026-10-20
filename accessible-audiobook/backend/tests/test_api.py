"""End-to-end API tests using the offline providers."""
import json

from app.services import evaluation as ev

from conftest import BOOK, find_chunk


def context_at(chapters, phrase: str, offset: int = 0) -> dict:
    chapter, section, chunk, i = find_chunk(chapters, phrase)
    return {"chapter": chapter["title"], "section": section["title"], "page": chunk["page"],
            "chunk_id": chunk["id"], "sentence_index": i, "character_offset": offset,
            "current_sentence": chunk["sentences"][i], "recent_context": " ".join(chunk["sentences"][max(0, i - 2):i])}


def test_requires_authentication(client):
    assert client.get("/api/books", headers={"Authorization": ""}).status_code == 401
    assert client.get("/api/books", headers={"Authorization": "Bearer not-a-token"}).status_code == 401


def test_library_lists_sample_books_with_structure(client, chapters):
    books = {b["id"]: b for b in client.get("/api/books").json()}
    assert books[BOOK]["title"] == "Operating Systems" and books[BOOK]["chapter_count"] == 3
    assert books["data-structures"]["status"] == "ready"
    assert [c["title"] for c in chapters][2] == "Chapter 3: Virtual Memory"
    assert [s["title"] for s in chapters[2]["sections"]][:2] == ["", "What Is Virtual Memory?"]


def test_demo_question_is_answered_from_the_textbook(client, chapters):
    """The headline demo: interrupt in the virtual-memory section and ask what it is."""
    ctx = context_at(chapters, "Virtual memory allows a process", offset=40)
    response = client.post(f"/api/books/{BOOK}/ask", json={"question": "What is virtual memory?", "context": ctx})
    assert response.status_code == 200, response.text
    body = response.json()
    assert "more memory than is physically available" in body["answer"]
    assert body["grounded"] is True
    assert any(s["relation"] == "current" for s in body["sources"])


def test_contextual_question_uses_reading_position(client, chapters):
    """'Why is this necessary?' means nothing without knowing what was being read."""
    ctx = context_at(chapters, "Virtual memory allows a process")
    events = _stream(client, {"question": "Why is this necessary?", "context": ctx})
    sources = next(e for e in events if e["type"] == "sources")
    assert ctx["chunk_id"] in [s["chunk_id"] for s in sources["sources"]]
    assert "virtual memory" in sources["query"].lower()  # the heard text was folded into the search query

    # The same words asked while reading about the TLB retrieve a different part of the book.
    other = context_at(chapters, "translation lookaside buffer, or TLB")
    other_sources = next(e for e in _stream(client, {"question": "Why is this necessary?", "context": other})
                         if e["type"] == "sources")
    assert other["chunk_id"] in [s["chunk_id"] for s in other_sources["sources"]]
    assert ctx["chunk_id"] not in [s["chunk_id"] for s in other_sources["sources"]]


def test_question_about_another_chapter_is_still_found(client, chapters):
    ctx = context_at(chapters, "A page fault is the event")
    body = client.post(f"/api/books/{BOOK}/ask", json={"question": "What is external fragmentation?", "context": ctx}).json()
    assert "no single hole is large enough" in body["answer"]
    assert any(s["relation"] == "heard" and s["chapter"].startswith("Chapter 1") for s in body["sources"])


def test_unanswerable_question_says_so(client, chapters):
    ctx = context_at(chapters, "A page fault is the event")
    body = client.post(f"/api/books/{BOOK}/ask", json={"question": "Who won the football world cup?", "context": ctx}).json()
    assert body["grounded"] is False
    assert body["answer"].startswith("Your textbook doesn't cover that")


def test_stream_emits_stages_then_sentences_and_keeps_conversation(client, chapters):
    ctx = context_at(chapters, "Virtual memory allows a process")
    events = _stream(client, {"question": "What is virtual memory?", "context": ctx})
    types = [e["type"] for e in events]
    assert types[:3] == ["stage", "sources", "stage"] and types[-1] == "done"
    assert "sentence" in types
    conversation_id = events[-1]["conversation_id"]

    follow_up = _stream(client, {"question": "Give me an example", "intent": "example", "context": ctx,
                                 "conversation_id": conversation_id})
    assert follow_up[-1]["conversation_id"] == conversation_id
    history = client.get(f"/api/books/{BOOK}/questions").json()
    assert [m["role"] for m in history[-4:]] == ["student", "assistant", "student", "assistant"]


def test_summarize_uses_the_whole_current_section(client, chapters):
    ctx = context_at(chapters, "A page fault is the event")
    events = _stream(client, {"question": "Summarize this section", "intent": "summarize", "context": ctx})
    sources = next(e for e in events if e["type"] == "sources")["sources"]
    assert {s["section"] for s in sources} == {"Page Faults"}


def test_playback_state_round_trips_exactly_and_checkpoints_interrupts(client, chapters):
    _, _, chunk, i = find_chunk(chapters, "It does this by keeping only the parts")
    position = {"chunk_id": chunk["id"], "sentence_index": i, "character_offset": 57, "audio_time": 37.4,
                "playback_speed": 1.25, "status": "interrupted", "reason": "interrupt"}
    assert client.put(f"/api/books/{BOOK}/session", json=position).status_code == 200

    restored = client.get(f"/api/books/{BOOK}/session").json()
    for key in ("chunk_id", "sentence_index", "character_offset", "audio_time", "playback_speed", "status"):
        assert restored[key] == position[key]
    assert restored["chapter_index"] == 2 and 0 < restored["progress"] < 1 and restored["started"] is True

    # A position from a different book is rejected rather than silently stored.
    other = client.get("/api/books/data-structures/chapters/0").json()["sections"][0]["chunks"][0]["id"]
    assert client.put(f"/api/books/{BOOK}/session", json={**position, "chunk_id": other}).status_code == 422

    assert client.delete(f"/api/books/{BOOK}/session").json()["started"] is False


def test_bookmarks(client, chapters):
    _, _, chunk, i = find_chunk(chapters, "A system in this state is said to be thrashing")
    created = client.post(f"/api/books/{BOOK}/bookmarks", json={"chunk_id": chunk["id"], "sentence_index": i, "label": "thrashing"})
    assert created.status_code == 201 and created.json()["section"] == "Thrashing and the Working Set"
    assert len(client.get(f"/api/books/{BOOK}/bookmarks").json()) == 1
    assert client.delete(f"/api/books/{BOOK}/bookmarks/{created.json()['id']}").status_code == 204


def test_upload_validation_and_ingestion(client):
    assert client.post("/api/books", files={"file": ("virus.exe", b"MZ...", "application/octet-stream")}).status_code == 415
    assert client.post("/api/books", files={"file": ("fake.pdf", b"this is not a pdf", "application/pdf")}).status_code == 415

    text = "# Chapter 1: Tides\n\n## Causes\n\n" + "The tide is caused by the gravity of the moon pulling on the sea. " * 12
    response = client.post("/api/books", files={"file": ("../../tides.md", text.encode(), "text/markdown")},
                           data={"title": "Tides"})
    assert response.status_code == 202
    book_id = response.json()["id"]
    assert "/" not in book_id and ".." not in book_id

    import time
    for _ in range(100):
        book = client.get(f"/api/books/{book_id}").json()
        if book["status"] != "processing":
            break
        time.sleep(0.1)
    assert book["status"] == "ready" and book["chapters"][0]["sections"][0]["title"] == "Causes"
    answer = client.post(f"/api/books/{book_id}/ask", json={"question": "What causes the tide?"}).json()
    assert "gravity of the moon" in answer["answer"]
    assert client.delete(f"/api/books/{book_id}").status_code == 204
    assert client.delete(f"/api/books/{BOOK}").status_code == 403  # sample books are protected


def test_quiz_offline_fallback(client, chapters):
    ctx = context_at(chapters, "A page fault is the event")
    question = client.post(f"/api/books/{BOOK}/quiz", json={"context": ctx}).json()
    assert question["question"].endswith("?") and question["expected"]
    marked = client.post(f"/api/books/{BOOK}/quiz/check", json={**question, "answer": question["expected"]}).json()
    assert marked["verdict"] == "correct"


def test_evaluation_flow_and_metrics(client):
    participant = client.post("/api/eval/participants", json={"profile": {"vision": "blind"}}).json()
    assert participant["code"] == "P01" and participant["condition_order"] == "AB"
    trial = client.post("/api/eval/trials", json={"participant_id": participant["id"], "condition": "B", "task_id": "T1"}).json()
    events = [
        {"t": 4000, "type": "interaction", "data": {"action": "ask"}},
        {"t": 4000, "type": "search_start"},
        {"t": 6500, "type": "question", "data": {"text": "what is the valid bit"}},
        {"t": 15000, "type": "answer_found"},
        {"t": 17500, "type": "resumed", "data": {"offset_sentences": 0}},
    ]
    finished = client.post(f"/api/eval/trials/{trial['id']}/finish",
                           json={"duration_ms": 30000, "events": events, "comprehension": 1}).json()
    assert finished["metrics"] == {"task_time_s": 30.0, "interactions": 1, "questions": 1, "errors": 0,
                                   "time_to_answer_s": 11.0, "time_to_resume_s": 2.5, "resume_error_sentences": 0}

    sus = client.post("/api/eval/questionnaires", json={"participant_id": participant["id"], "condition": "B",
                                                        "kind": "sus", "responses": [5, 1, 5, 1, 5, 1, 5, 1, 5, 1]}).json()
    assert sus["score"] == 100
    summary = client.get("/api/eval/summary").json()
    assert summary["conditions"]["B"]["time_to_answer_s"]["mean"] == 11.0
    assert summary["conditions"]["A"]["trials"] == 0
    assert "P01" in client.get("/api/eval/export.csv").text


def test_counterbalancing_covers_all_orders():
    assert {ev.assignment(n) for n in range(1, 5)} == set(ev.ORDERS)
    assert ev.score_questionnaire("tlx", [50, 10, 30, 20, 60, 10]) == 30.0


def test_chapter_content_marks_paragraph_starts_for_skimming(client, chapters):
    section = next(s for s in chapters[2]["sections"] if s["title"] == "What Is Virtual Memory?")
    starts = [chunk["sentences"][i] for chunk in section["chunks"] for i in chunk["paragraph_starts"]]
    # The four paragraphs of that section in the sample text, by their opening sentences.
    assert [s.split()[0:3] for s in starts] == [
        ["Virtual", "memory", "allows"], ["Virtual", "memory", "is"], ["Virtual", "memory", "also"], ["The", "idea", "is"]]
    assert sum(len(chunk["sentences"]) for chunk in section["chunks"]) > len(starts)


def test_find_locates_the_passage_and_its_best_sentence(client):
    def find(query: str) -> list[dict]:
        response = client.post(f"/api/books/{BOOK}/find", json={"query": query})
        assert response.status_code == 200, response.text
        return response.json()["matches"]

    belady = find("Belady's anomaly")[0]
    assert belady["section"] == "Page Replacement Algorithms" and belady["chapter_index"] == 2
    assert "Belady's anomaly" in belady["snippet"]

    dirty = find("the dirty bit")
    assert all("dirty bit" in match["snippet"] for match in dirty[:2])
    assert {match["section"] for match in dirty[:2]} == {"The Page Table", "Page Replacement Algorithms"}

    assert find("working set")[0]["section"] == "Thrashing and the Working Set"
    assert find("photosynthesis in green plants") == []  # nothing relevant: say so rather than jump somewhere random


def test_notes_and_study_sheet(client, chapters):
    _, _, chunk, i = find_chunk(chapters, "A page fault is not an error")
    url = f"/api/books/{BOOK}/notes"
    created = client.post(url, json={"chunk_id": chunk["id"], "sentence_index": i, "text": "  Page faults are normal, not errors.  "})
    assert created.status_code == 201, created.text
    note = created.json()
    assert note["text"] == "Page faults are normal, not errors."
    assert note["section"] == "Page Faults" and note["quote"].startswith("A page fault is not an error")
    assert client.post(url, json={"chunk_id": chunk["id"], "text": "   "}).status_code == 422
    other = client.get("/api/books/data-structures/chapters/0").json()["sections"][0]["chunks"][0]["id"]
    assert client.post(url, json={"chunk_id": other, "text": "wrong book"}).status_code == 422

    ctx = context_at(chapters, "A page fault is the event")
    client.post(f"/api/books/{BOOK}/ask", json={"question": "What is a page fault?", "context": ctx})
    sheet = client.get(f"/api/books/{BOOK}/study-notes")
    assert sheet.status_code == 200 and "attachment" in sheet.headers["content-disposition"]
    assert sheet.headers["content-type"].startswith("text/markdown")
    text = sheet.text
    assert text.startswith("# Study notes: Operating Systems")
    assert "1. Page faults are normal, not errors." in text and 'The book was saying: "A page fault is not an error' in text
    assert "Question: What is a page fault?" in text and "Asked while reading: Chapter 3: Virtual Memory, Page Faults" in text
    assert "   - Answer: " in text

    assert client.delete(f"{url}/{note['id']}").status_code == 204
    assert client.get(url).json() == []


def test_older_database_gains_new_columns(tmp_path):
    from sqlalchemy import create_engine, inspect, text

    from app.db import add_missing_columns

    engine = create_engine(f"sqlite:///{(tmp_path / 'old.db').as_posix()}")
    with engine.begin() as connection:  # the table as it was before paragraph boundaries were recorded
        connection.execute(text("CREATE TABLE document_chunks (id INTEGER PRIMARY KEY, sentences JSON)"))
        connection.execute(text("INSERT INTO document_chunks (id, sentences) VALUES (1, '[\"One.\"]')"))
    assert add_missing_columns(engine) == ["document_chunks.paragraph_starts"]
    assert add_missing_columns(engine) == []  # safe to run on every start
    assert "paragraph_starts" in {c["name"] for c in inspect(engine).get_columns("document_chunks")}
    with engine.connect() as connection:
        assert connection.execute(text("SELECT paragraph_starts FROM document_chunks")).scalar() is None
    engine.dispose()


def test_paragraph_boundaries_are_recovered_for_books_ingested_earlier(client):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DocumentChunk
    from app.services.ingest import backfill_paragraphs

    def chunks(db):
        return list(db.scalars(select(DocumentChunk).where(DocumentChunk.book_id == BOOK).order_by(DocumentChunk.chunk_index)))

    with SessionLocal() as db:
        rows = chunks(db)
        original = [(row.id, row.paragraph_starts) for row in rows]
        for row in rows:  # as if the book had been ingested by the earlier version
            row.paragraph_starts = None
        db.commit()
    first = client.get(f"/api/books/{BOOK}/chapters/0").json()["sections"][0]["chunks"][0]
    assert first["paragraph_starts"] == [0]  # the coarse fallback

    backfill_paragraphs()
    with SessionLocal() as db:
        assert [(row.id, row.paragraph_starts) for row in chunks(db)] == original  # same rows, same ids
    assert any(len(starts) > 1 for _, starts in original)


def _stream(client, body: dict) -> list[dict]:
    response = client.post(f"/api/books/{BOOK}/ask/stream", json=body)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line]
