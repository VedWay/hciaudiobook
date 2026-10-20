"""Test setup: an isolated data directory and the offline providers (no API keys, no network)."""
import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

_TMP = tempfile.mkdtemp(prefix="audiobook-tests-")
os.environ.update({
    "DATA_DIR": _TMP, "DATABASE_URL": "", "QDRANT_URL": "", "LLM_PROVIDER": "local",
    "EMBEDDING_PROVIDER": "local", "STT_PROVIDER": "browser", "TTS_PROVIDER": "browser",
    "RESEARCHER_PASSCODE": "", "JWT_SECRET": "test-secret-test-secret-test-secret-123",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

BOOK = "operating-systems"


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:
        token = test_client.post("/api/auth/guest", json={}).json()["access_token"]
        test_client.headers["Authorization"] = f"Bearer {token}"
        deadline = time.time() + 60
        while time.time() < deadline:  # sample books are ingested in a background thread
            books = {b["id"]: b for b in test_client.get("/api/books").json()}
            if len(books) >= 2 and all(b["status"] == "ready" for b in books.values()):
                break
            time.sleep(0.2)
        else:
            pytest.fail(f"sample books were not ingested: {books}")
        yield test_client


@pytest.fixture(scope="session")
def chapters(client):
    """The sample book's chapters with full content, keyed by index."""
    outline = client.get(f"/api/books/{BOOK}").json()["chapters"]
    return [client.get(f"/api/books/{BOOK}/chapters/{c['index']}").json() for c in outline]


def find_chunk(chapters, phrase: str) -> tuple[dict, dict, dict, int]:
    """Locate (chapter, section, chunk, sentence index) of the sentence containing a phrase."""
    for chapter in chapters:
        for section in chapter["sections"]:
            for chunk in section["chunks"]:
                for i, sentence in enumerate(chunk["sentences"]):
                    if phrase in sentence:
                        return chapter, section, chunk, i
    raise AssertionError(f"phrase not found in sample book: {phrase}")
