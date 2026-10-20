"""Builds the configured providers once and shares them across requests."""
from __future__ import annotations

import threading
from functools import cached_property

from ingestion.embeddings import Embedder, create_embedder
from ingestion.vector_store import QdrantVectorStore

from ..config import Settings, get_settings
from ..rag.answerers import Answerer, GeminiAnswerer, LocalExtractiveAnswerer, OpenAIAnswerer
from ..rag.retriever import Retriever
from ..speech.stt import GeminiSTT, OpenAISTT, STTProvider
from ..speech.tts import EdgeTTS, OpenAITTS, TTSProvider
from .vision import GeminiVision, OpenAIVision, PictureDescriber


class Providers:
    def __init__(self, settings: Settings, *, in_memory_vectors: bool = False) -> None:
        self.settings = settings
        self._in_memory_vectors = in_memory_vectors

    @cached_property
    def embedder(self) -> Embedder:
        s = self.settings
        return create_embedder(
            s.embedding_provider, gemini_api_key=s.gemini_api_key, openai_api_key=s.openai_api_key,
            gemini_model=s.gemini_embedding_model, gemini_dim=s.gemini_embedding_dim,
            openai_model=s.openai_embedding_model,
        )

    @cached_property
    def store(self) -> QdrantVectorStore:
        s = self.settings
        embedded_path = None if (s.qdrant_url or self._in_memory_vectors) else s.data_dir / "qdrant"
        return QdrantVectorStore(
            collection=s.qdrant_collection, dim=self.embedder.dim, embedder_name=self.embedder.name,
            url=s.qdrant_url, api_key=s.qdrant_api_key, path=embedded_path,
        )

    @cached_property
    def retriever(self) -> Retriever:
        return Retriever(self.embedder, self.store, self.settings.retrieval_top_k)

    @cached_property
    def answerer(self) -> Answerer:
        s = self.settings
        provider = s.resolve_provider(s.llm_provider)
        if provider == "groq" and s.groq_api_key:
            return OpenAIAnswerer(s.groq_api_key, s.groq_llm_model, base_url=s.groq_base_url, label="groq")
        if provider == "xai" and s.xai_api_key:
            return OpenAIAnswerer(s.xai_api_key, s.xai_llm_model, base_url=s.xai_base_url, label="xai")
        if provider == "gemini" and s.gemini_api_key:
            return GeminiAnswerer(s.gemini_api_key, s.gemini_llm_model, s.gemini_thinking_budget)
        if provider == "openai" and s.openai_api_key:
            return OpenAIAnswerer(s.openai_api_key, s.openai_llm_model)
        return LocalExtractiveAnswerer()

    @cached_property
    def stt(self) -> STTProvider | None:
        s = self.settings
        provider = s.stt_provider
        if provider == "auto":  # Whisper first: it accepts every browser recording format
            provider = ("groq" if s.groq_api_key else "openai" if s.openai_api_key
                        else "gemini" if s.gemini_api_key else "browser")
        if provider == "groq" and s.groq_api_key:
            return OpenAISTT(s.groq_api_key, s.groq_stt_model, base_url=s.groq_base_url, label="groq")
        if provider == "openai" and s.openai_api_key:
            return OpenAISTT(s.openai_api_key, s.openai_stt_model)
        if provider == "gemini" and s.gemini_api_key:
            return GeminiSTT(s.gemini_api_key, s.gemini_llm_model)
        return None

    @cached_property
    def tts(self) -> TTSProvider | None:
        s = self.settings
        if s.tts_provider == "openai" and s.openai_api_key:
            return OpenAITTS(s.openai_api_key, s.openai_tts_model, s.openai_tts_voice, s.openai_tts_assistant_voice)
        if s.tts_provider in ("auto", "edge"):
            try:
                return EdgeTTS(s.edge_tts_narrator_voice, s.edge_tts_assistant_voice)
            except ImportError:
                return None  # edge-tts not installed: the browser's own voices are used
        return None

    @cached_property
    def describer(self) -> PictureDescriber | None:
        """The vision model that puts a book's pictures into words; None means pictures are passed over."""
        s = self.settings
        if not s.describe_pictures or s.llm_provider == "local":
            return None
        if s.groq_api_key and s.groq_vision_model:
            return OpenAIVision(s.groq_api_key, s.groq_vision_model, base_url=s.groq_base_url, label="groq")
        if s.gemini_api_key:
            return GeminiVision(s.gemini_api_key, s.gemini_llm_model)
        if s.openai_api_key:
            return OpenAIVision(s.openai_api_key, s.openai_llm_model)
        if s.xai_api_key:
            return OpenAIVision(s.xai_api_key, s.xai_llm_model, base_url=s.xai_base_url, label="xai")
        return None

    def capabilities(self) -> dict:
        """What the frontend needs to know to choose its speech engines and label answers honestly."""
        return {
            "llm": self.answerer.name,
            "llm_is_local_fallback": self.answerer.is_local,
            "embeddings": self.embedder.name,
            "vector_store": "qdrant-server" if self.settings.qdrant_url else "qdrant-embedded",
            "server_stt": self.stt.name if self.stt else None,
            "server_tts": self.tts.name if self.tts else None,
            "picture_descriptions": self.describer.name if self.describer else None,
            "max_upload_mb": self.settings.max_upload_mb,
            "evaluation_requires_passcode": bool(self.settings.researcher_passcode),
        }


_providers: Providers | None = None
_lock = threading.Lock()


def get_providers() -> Providers:
    global _providers
    with _lock:
        if _providers is None:
            _providers = Providers(get_settings())
        return _providers


def set_providers(providers: Providers | None) -> None:
    """Swap the provider set (used by tests)."""
    global _providers
    with _lock:
        _providers = providers
