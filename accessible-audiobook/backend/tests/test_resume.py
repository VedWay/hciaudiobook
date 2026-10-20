"""A book whose preparation was cut short by a restart is picked up again, and finished work is not redone."""
import json

import fitz

from app.config import get_settings
from app.db import SessionLocal
from app.models import Book
from app.services import ingest
from app.services.ingest import _PictureCache, resume_interrupted

TEXT = ("Paging divides memory into fixed-size frames. Each process sees its own pages. The page table maps pages to "
        "frames. A page fault happens when a page is not in memory. The operating system then loads it from disk. ") * 3


def _pdf(path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 80), "Chapter 1 Paging", fontsize=22, fontname="hebo")
    page.insert_textbox(fitz.Rect(60, 110, 535, 500), TEXT, fontsize=12, fontname="helv")
    doc.save(path)


def _status(book_id):
    with SessionLocal() as db:
        book = db.get(Book, book_id)
        return book.status, book.status_detail, book.total_chunks


def test_a_book_left_processing_by_a_restart_is_finished_at_startup(client):
    uploads = get_settings().data_dir / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    _pdf(uploads / "interrupted-book.pdf")
    with SessionLocal() as db:
        # Exactly what a restart leaves behind: the row says "processing" and nothing is working on it.
        db.add(Book(id="interrupted-book", owner_id=None, title="Interrupted", source_filename="interrupted-book.pdf",
                    status="processing", status_detail="Reading the text and describing the pictures", progress=0.1))
        db.add(Book(id="lost-book", owner_id=None, title="Lost", source_filename="lost.pdf", status="processing"))
        db.commit()

    resume_interrupted()

    status, _, chunks = _status("interrupted-book")
    assert status == "ready" and chunks > 0
    status, detail, _ = _status("lost-book")
    assert status == "failed" and "add it again" in detail  # no file to resume from: say so instead of spinning for ever
    assert client.get("/api/books/interrupted-book/chapters/0").status_code == 200


def test_a_book_being_prepared_right_now_is_not_started_twice(client, monkeypatch):
    with SessionLocal() as db:
        db.add(Book(id="busy-book", owner_id=None, title="Busy", status="processing"))
        db.commit()
    started = []
    monkeypatch.setattr(ingest, "_ingest_file", lambda book_id, path: started.append(book_id))
    with ingest._ingesting_lock:
        ingest._ingesting.add("busy-book")
    try:
        resume_interrupted()
        ingest.ingest_file("busy-book", get_settings().data_dir / "uploads" / "busy-book.pdf")
    finally:
        ingest._ingesting.discard("busy-book")
        with SessionLocal() as db:
            db.delete(db.get(Book, "busy-book"))
            db.commit()
    assert "busy-book" not in started


def _picture(colour) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=300, height=200)
    page.draw_rect(page.rect, color=None, fill=colour)
    page.draw_circle((150, 100), 60, color=(0, 0, 0), fill=(1, 0.6, 0.1), width=3)
    png = page.get_pixmap(dpi=72).tobytes("png")
    doc.close()
    return png


def _illustrated_pdf(path):
    doc = fitz.open()
    for number, colours in enumerate([[(0.6, 0.85, 1), (0.9, 0.9, 0.5)], [(0.45, 0.48, 0.55)]], 1):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), f"Chapter {number} Paging", fontsize=22, fontname="hebo")
        page.insert_textbox(fitz.Rect(60, 110, 535, 330), TEXT[:520], fontsize=12, fontname="helv")
        for i, colour in enumerate(colours):
            page.insert_image(fitz.Rect(100, 340 + 190 * i, 400, 520 + 190 * i), stream=_picture(colour))
        page.insert_textbox(fitz.Rect(60, 740, 535, 800), "And after the picture the chapter carries on for a little while longer.", fontsize=12, fontname="helv")
    doc.save(path)


class _Vision:
    name = "test:vision"

    def __init__(self, fail_from=None):
        self.calls, self.fail_from = 0, fail_from

    def describe(self, image, context):
        self.calls += 1
        if self.fail_from is not None and self.calls >= self.fail_from:
            raise RuntimeError("rate limited")
        return f"Diagram number {self.calls} shows pages mapped to frames. Arrows run left to right."


def _sentences(client, book_id):
    out = []
    for chapter in client.get(f"/api/books/{book_id}").json()["chapters"]:
        content = client.get(f"/api/books/{book_id}/chapters/{chapter['index']}").json()
        out.append([s for section in content["sections"] for chunk in section["chunks"] for s in chunk["sentences"]])
    return out


def test_a_book_is_readable_from_its_text_at_once_and_its_pictures_are_added_as_they_are_described(client, monkeypatch):
    from app.services.providers import get_providers

    uploads = get_settings().data_dir / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    _illustrated_pdf(uploads / "illustrated.pdf")
    with SessionLocal() as db:
        db.add(Book(id="illustrated", owner_id=None, title="Illustrated", status="processing"))
        db.commit()

    vision = _Vision(fail_from=2)  # the allowance runs out after one picture
    monkeypatch.setattr(type(get_providers()), "describer", property(lambda self: vision))
    ingest.ingest_file("illustrated", uploads / "illustrated.pdf")

    # Readable straight away, with the text complete and in order - and one picture in so far.
    status, detail, chunks_then = _status("illustrated")
    assert status == "ready" and "1 of 3" in detail
    first, second = _sentences(client, "illustrated")
    assert first.count("Picture.") == 1 and second.count("Picture.") == 0
    assert "Diagram number 1 shows pages mapped to frames." in first
    assert "PICTUREMARK" not in " ".join(first + second)
    token = client.post("/api/auth/guest", json={}).json()["access_token"]
    session = client.get("/api/books/illustrated/session", headers={"Authorization": f"Bearer {token}"}).json()

    # A restart later, with the allowance back: the remaining pictures are described and slotted in.
    vision.fail_from = None
    resume_interrupted()
    status, detail, chunks_now = _status("illustrated")
    assert (status, detail) == ("ready", "") and chunks_now == chunks_then + 2
    first, second = _sentences(client, "illustrated")
    assert first.count("Picture.") == 2 and second.count("Picture.") == 1
    # Both of the first page's pictures come after its text and before the text that follows them, in order.
    order = [first.index(s) for s in first if s.startswith("Diagram number")]
    assert order == sorted(order) and first.index("And after the picture the chapter carries on for a little while longer.") > order[-1]
    assert not (get_settings().data_dir / "pictures" / "illustrated.pending.json").exists()
    # Nothing that existed before was renumbered: a reading position saved earlier still points at the same place.
    again = client.get("/api/books/illustrated/session", headers={"Authorization": f"Bearer {token}"}).json()
    assert again["chunk_id"] == session["chunk_id"]
    # And the pictures can be found by asking about them.
    found = client.post("/api/books/illustrated/find", json={"query": "diagram arrows frames"}).json()["matches"]
    assert found


def test_picture_descriptions_survive_a_restart(tmp_path):
    calls = []

    class Describer:
        def describe(self, image, context):
            calls.append(image)
            if image == b"broken":
                raise RuntimeError("vision service busy")
            return f"A picture of {image.decode()}."

    path = tmp_path / "pictures" / "book.json"
    first = _PictureCache(path, Describer())
    assert first.describe(b"a cat", "") == "A picture of a cat."
    try:
        first.describe(b"broken", "")
    except RuntimeError:
        pass
    assert json.loads(path.read_text(encoding="utf-8")) == {next(iter(json.loads(path.read_text(encoding="utf-8")))): "A picture of a cat."}

    after_restart = _PictureCache(path, Describer())
    assert after_restart.describe(b"a cat", "") == "A picture of a cat."  # not asked for again
    assert after_restart.describe(b"a dog", "") == "A picture of a dog."
    assert calls == [b"a cat", b"broken", b"a dog"]
