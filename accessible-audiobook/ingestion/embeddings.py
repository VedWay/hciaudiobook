"""Embedding providers behind one small interface.

``create_embedder`` picks Gemini or OpenAI when an API key is configured and
otherwise falls back to ``LocalHashingEmbedder`` - a real (if simple) lexical
embedding that needs no network, so the whole pipeline runs offline.
"""
from __future__ import annotations

import hashlib
import math
import re
import time
from collections import Counter
from typing import Protocol

STOPWORDS = frozenset("""
a an the and or but if then else of to in on at by for with from into onto over under about as is are was were be been
being am do does did doing have has had having it its this that these those there here he she they them their we us our
you your i me my not no nor so than too very can could should would will shall may might must also just only such both
each other some any all more most many much few which who whom whose what when where why how up down out off again
further once same own between through during before after above below because while until against
""".split())

_TOKEN = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    """Lower-cased content words with light suffix stripping (shared with the lexical re-ranker)."""
    tokens = []
    for tok in _TOKEN.findall(text.lower()):
        if tok in STOPWORDS:
            continue
        for suffix in ("ing", "es", "ed", "s"):
            if tok.endswith(suffix) and len(tok) - len(suffix) >= 4:
                tok = tok[: -len(suffix)]
                break
        tokens.append(tok)
    return tokens


class Embedder(Protocol):
    name: str
    dim: int

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


def normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec] if norm else vec


class LocalHashingEmbedder:
    """LOCAL FALLBACK - feature-hashed bag of words/bigrams, L2-normalised.

    Captures lexical overlap only (no synonyms). It exists so the project runs
    without an API key; set EMBEDDING_PROVIDER=gemini|openai for semantic search.
    """

    name = "local-hashing"

    def __init__(self, dim: int = 1024) -> None:
        self.dim = dim

    def _embed(self, text: str) -> list[float]:
        tokens = tokenize(text)
        features: Counter = Counter(tokens)
        for a, b in zip(tokens, tokens[1:]):
            features[f"{a}_{b}"] += 0.5
        vec = [0.0] * self.dim
        for feature, count in features.items():
            digest = int.from_bytes(hashlib.md5(feature.encode()).digest()[:8], "big")
            sign = 1.0 if digest & 1 else -1.0
            vec[(digest >> 1) % self.dim] += sign * (1.0 + math.log(count + 0.5))
        return normalize(vec)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


def _with_retry(call, attempts: int = 4):
    for attempt in range(attempts):
        try:
            return call()
        except Exception:  # rate limits / transient network errors
            if attempt == attempts - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


class GeminiEmbedder:
    def __init__(self, api_key: str, model: str = "gemini-embedding-001", dim: int = 768) -> None:
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._model = model
        self.dim = dim
        self.name = f"gemini:{model}"

    def _embed(self, texts: list[str], task_type: str) -> list[list[float]]:
        from google.genai import types

        out: list[list[float]] = []
        for i in range(0, len(texts), 20):
            batch = texts[i:i + 20]
            response = _with_retry(lambda: self._client.models.embed_content(
                model=self._model, contents=batch,
                config=types.EmbedContentConfig(task_type=task_type, output_dimensionality=self.dim),
            ))
            # Truncated Gemini embeddings are not unit length, so normalise them here.
            out.extend(normalize(list(e.values)) for e in response.embeddings)
        return out

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._embed(texts, "RETRIEVAL_DOCUMENT")

    def embed_query(self, text: str) -> list[float]:
        return self._embed([text], "RETRIEVAL_QUERY")[0]


class OpenAIEmbedder:
    _DIMS = {"text-embedding-3-small": 1536, "text-embedding-3-large": 3072, "text-embedding-ada-002": 1536}

    def __init__(self, api_key: str, model: str = "text-embedding-3-small") -> None:
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key)
        self._model = model
        self.name = f"openai:{model}"
        self.dim = self._DIMS.get(model) or len(self.embed_query("dimension probe"))

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), 64):
            batch = texts[i:i + 64]
            response = _with_retry(lambda: self._client.embeddings.create(model=self._model, input=batch))
            out.extend(d.embedding for d in response.data)
        return out

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


def create_embedder(provider: str, *, gemini_api_key: str = "", openai_api_key: str = "",
                    gemini_model: str = "gemini-embedding-001", gemini_dim: int = 768,
                    openai_model: str = "text-embedding-3-small") -> Embedder:
    provider = (provider or "auto").lower()
    if provider == "auto":
        provider = "gemini" if gemini_api_key else "openai" if openai_api_key else "local"
    if provider == "gemini":
        if not gemini_api_key:
            raise ValueError("EMBEDDING_PROVIDER=gemini but GEMINI_API_KEY is not set.")
        return GeminiEmbedder(gemini_api_key, gemini_model, gemini_dim)
    if provider == "openai":
        if not openai_api_key:
            raise ValueError("EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set.")
        return OpenAIEmbedder(openai_api_key, openai_model)
    if provider == "local":
        return LocalHashingEmbedder()
    raise ValueError(f"Unknown embedding provider: {provider!r}")
