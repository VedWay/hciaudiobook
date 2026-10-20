"""Pictures in a book are described in words and read in their place. The vision model is faked: no network."""
import fitz

from ingestion.chunker import build_chunks
from ingestion.pdf_parser import PICTURE_PREFIX, parse_pdf

from app.services.vision import _clean
from app.speech.tts import EDGE_VOICES, NATIVE_VOICES, dominant_script

STORY = ("Mango the cat woke up early. The garden was bright and warm. Mango stretched her paws and purred. "
         "She loved sunny mornings more than anything else in the whole wide world. Today she wanted to chase butterflies.")


def _drawing(colour, width=400, height=300) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.draw_rect(page.rect, color=None, fill=colour)
    page.draw_circle((width / 2, height / 2), min(width, height) / 3, color=(0, 0, 0), fill=(1, 0.6, 0.1), width=3)
    png = page.get_pixmap(dpi=72).tobytes("png")
    doc.close()
    return png


def _picture_book(path, pictures_per_page=1, logo=False):
    doc = fitz.open()
    for number, colour in enumerate([(0.6, 0.85, 1), (0.45, 0.48, 0.55), (0.9, 0.8, 0.6)], 1):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), f"Chapter {number} The Garden", fontsize=22, fontname="hebo")
        page.insert_textbox(fitz.Rect(60, 110, 535, 240), STORY, fontsize=13, fontname="helv")
        for i in range(pictures_per_page):
            page.insert_image(fitz.Rect(100, 260 + 250 * i, 400, 480 + 250 * i), stream=_drawing(tuple(c * (1 - 0.3 * i) for c in colour)))
        page.insert_textbox(fitz.Rect(60, 760, 535, 800), "and then the day went on quietly until the evening came.", fontsize=13, fontname="helv")
        if logo:
            page.insert_image(fitz.Rect(450, 600, 550, 700), stream=_drawing((0.2, 0.2, 0.8), 120, 120))  # same on every page
        page.insert_image(fitz.Rect(560, 20, 580, 40), stream=_drawing((1, 0, 0), 40, 40))  # a tiny icon
    doc.save(path)


def test_each_picture_is_described_once_and_read_where_it_sits(tmp_path):
    path = tmp_path / "book.pdf"
    _picture_book(path)
    seen = []

    def describe(image: bytes, context: str) -> str:
        seen.append((image[:3], context))
        return "A round orange cat with a proud little grin sits in soft warm grass"

    doc = parse_pdf(path, describe)
    assert len(seen) == 3  # one per page; the tiny icon is not sent at all
    assert all(image == b"\xff\xd8\xff" for image, _ in seen)  # JPEG
    assert all("Mango the cat" in context for _, context in seen)  # the page's own words go along as context

    kinds = [("picture" if b.text.startswith(PICTURE_PREFIX) else b.kind) for b in doc.blocks]
    assert kinds == ["heading", "paragraph", "picture", "paragraph"] * 3  # after the text above it, before the text below
    picture = next(b for b in doc.blocks if b.text.startswith(PICTURE_PREFIX))
    assert picture.text == "Picture. A round orange cat with a proud little grin sits in soft warm grass."

    # Read aloud as a paragraph of its own that opens with the one word "Picture." - which is what the
    # player listens for to sound its chime - followed by the description.
    chunk = build_chunks(doc)[0]
    start = chunk.sentences.index("Picture.")
    assert start in chunk.paragraph_starts
    assert chunk.sentences[start + 1] == "A round orange cat with a proud little grin sits in soft warm grass."


def test_decoration_failures_and_limits_never_lose_the_book(tmp_path):
    path = tmp_path / "book.pdf"
    _picture_book(path, pictures_per_page=2, logo=True)
    calls = []

    def describe(image: bytes, context: str) -> str:
        calls.append(image)
        if len(calls) == 1:
            raise RuntimeError("vision model unavailable")
        return "" if len(calls) == 2 else "A cat in a garden."

    doc = parse_pdf(path, describe, max_pictures=4)
    assert len(calls) == 4  # the limit holds, and the logo repeated on every page was never sent
    assert sum(b.text.startswith(PICTURE_PREFIX) for b in doc.blocks) == 2  # the failed and the "decoration" ones are dropped
    assert sum(b.kind == "heading" for b in doc.blocks) == 3  # the book itself is intact


def test_without_a_vision_model_pictures_are_passed_over(tmp_path):
    path = tmp_path / "book.pdf"
    _picture_book(path)
    doc = parse_pdf(path)
    assert not any(b.text.startswith(PICTURE_PREFIX) for b in doc.blocks)
    assert [b.kind for b in doc.blocks] == ["heading", "paragraph", "paragraph"] * 3


def test_a_picture_book_with_almost_no_text_still_becomes_an_audiobook(tmp_path):
    path = tmp_path / "wordless.pdf"
    doc = fitz.open()
    for colour in [(0.6, 0.85, 1), (0.45, 0.48, 0.55)]:
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), "Look!", fontsize=13, fontname="helv")
        page.insert_image(fitz.Rect(60, 120, 535, 700), stream=_drawing(colour))
    doc.save(path)
    parsed = parse_pdf(path, lambda image, context: "A small orange cat curls up, warm and sleepy, on a soft blue blanket. " * 3)
    assert sum(b.text.startswith(PICTURE_PREFIX) for b in parsed.blocks) == 2


def test_the_models_skip_and_markdown_are_cleaned():
    assert _clean("SKIP") == "" and _clean(" skip. ") == "" and _clean("") == ""
    assert _clean("**A cat**\n\nsits  in the *sun*.") == "A cat sits in the sun."


def test_marathi_and_hindi_are_told_apart_and_indian_voices_are_offered():
    assert dominant_script("कावळ्याने मडक्यात खडे टाकले आणि पाणी वर आले. तो खूप हुशार आहे.") == "marathi"
    assert dominant_script("कौए ने घड़े में कंकड़ डाले और पानी ऊपर आ गया। वह बहुत चतुर था।") == "devanagari"
    assert dominant_script("नमस्ते") == "devanagari"  # no telling: Hindi is the default
    assert NATIVE_VOICES["marathi"][0].startswith("mr-IN")
    assert {"en-IN-NeerjaExpressiveNeural", "en-IN-PrabhatNeural"} <= {v.id for v in EDGE_VOICES}
