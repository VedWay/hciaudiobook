"""Qdrant wrapper.

Connects to a Qdrant server when a URL is given (docker-compose), otherwise uses
Qdrant's embedded on-disk mode - the same engine and API, no server required.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client import models as qm


@dataclass
class SearchHit:
    chunk_id: int
    score: float
    payload: dict


class QdrantVectorStore:
    def __init__(self, *, collection: str, dim: int, embedder_name: str = "",
                 url: str = "", api_key: str = "", path: str | Path | None = None) -> None:
        self._is_server = bool(url)
        if url:
            self._client = QdrantClient(url=url, api_key=api_key or None, timeout=30)
            self.location = url
        elif path is not None:
            Path(path).mkdir(parents=True, exist_ok=True)
            self._client = QdrantClient(path=str(path))
            self.location = f"embedded:{path}"
        else:
            self._client = QdrantClient(location=":memory:")
            self.location = "memory"
        # One collection per embedding space: vectors from different models are not comparable.
        suffix = re.sub(r"[^a-z0-9]+", "_", embedder_name.lower()).strip("_")
        self.collection = f"{collection}__{suffix}_{dim}" if suffix else collection
        self.dim = dim
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        if self._client.collection_exists(self.collection):
            return
        self._client.create_collection(
            self.collection,
            vectors_config=qm.VectorParams(size=self.dim, distance=qm.Distance.COSINE),
        )
        if self._is_server:  # speeds up the per-book filter; embedded mode has no payload indexes
            self._client.create_payload_index(self.collection, "book_id", qm.PayloadSchemaType.KEYWORD)

    @staticmethod
    def _book_filter(book_id: str) -> qm.Filter:
        return qm.Filter(must=[qm.FieldCondition(key="book_id", match=qm.MatchValue(value=book_id))])

    def upsert(self, ids: list[int], vectors: list[list[float]], payloads: list[dict]) -> None:
        for i in range(0, len(ids), 128):
            self._client.upsert(self.collection, points=[
                qm.PointStruct(id=pid, vector=vec, payload=payload)
                for pid, vec, payload in zip(ids[i:i + 128], vectors[i:i + 128], payloads[i:i + 128])
            ])

    def search(self, vector: list[float], book_id: str, limit: int = 10) -> list[SearchHit]:
        result = self._client.query_points(
            self.collection, query=vector, query_filter=self._book_filter(book_id),
            limit=limit, with_payload=True,
        )
        return [SearchHit(chunk_id=int(p.id), score=float(p.score), payload=p.payload or {}) for p in result.points]

    def count(self, book_id: str) -> int:
        return self._client.count(self.collection, count_filter=self._book_filter(book_id), exact=True).count

    def delete_book(self, book_id: str) -> None:
        self._client.delete(self.collection, points_selector=qm.FilterSelector(filter=self._book_filter(book_id)))

    def close(self) -> None:
        self._client.close()
