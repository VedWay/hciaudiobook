"""Application settings, loaded from environment variables / backend/.env."""
from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    environment: str = "development"
    data_dir: Path = BACKEND_DIR / "data"
    database_url: str = ""  # defaults to SQLite inside data_dir
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Auth
    jwt_secret: str = ""  # generated and stored in data_dir when empty
    jwt_expire_minutes: int = 60 * 24 * 30
    researcher_passcode: str = ""  # when set, the evaluation API requires it

    # Providers: "auto" = the first of Groq, xAI, Gemini, OpenAI that has an API key, else the local fallback
    llm_provider: str = "auto"  # auto | groq | xai | gemini | openai | local
    embedding_provider: str = "auto"  # auto | gemini | openai | local
    stt_provider: str = "auto"  # auto | groq | openai | gemini | browser
    tts_provider: str = "auto"  # auto | edge | openai | browser   (auto = edge neural voices if installed)

    # Groq: fast hosting for open models, including OpenAI's open-weight GPT-OSS, and Whisper for speech
    groq_api_key: str = ""
    groq_llm_model: str = "openai/gpt-oss-120b"
    groq_stt_model: str = "whisper-large-v3-turbo"
    groq_vision_model: str = "qwen/qwen3.8-27b"  # describes the pictures in a book
    groq_base_url: str = "https://api.groq.com/openai/v1"

    # xAI Grok
    xai_api_key: str = ""
    xai_llm_model: str = "grok-4"
    xai_base_url: str = "https://api.x.ai/v1"

    gemini_api_key: str = ""
    gemini_llm_model: str = "gemini-2.5-flash"
    gemini_thinking_budget: int = 0  # 0 = fastest replies; -1 = leave the model default
    gemini_embedding_model: str = "gemini-embedding-001"
    gemini_embedding_dim: int = 768

    openai_api_key: str = ""
    openai_llm_model: str = "gpt-4.1-mini"
    openai_embedding_model: str = "text-embedding-3-small"
    openai_stt_model: str = "whisper-1"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "alloy"
    openai_tts_assistant_voice: str = "nova"

    # The Multilingual voices sound the most natural and also read other languages
    edge_tts_narrator_voice: str = "en-US-AvaMultilingualNeural"
    edge_tts_assistant_voice: str = "en-US-AndrewMultilingualNeural"

    # Qdrant: leave QDRANT_URL empty to use the embedded on-disk engine
    qdrant_url: str = ""
    qdrant_api_key: str = ""
    qdrant_collection: str = "book_chunks"

    # RAG
    retrieval_top_k: int = 6
    allow_general_knowledge: bool = True  # may add a clearly-labelled hint when the book lacks the answer

    # Pictures: each one is described in words (and read aloud in its place) when a vision model is available
    describe_pictures: bool = True
    max_pictures_per_book: int = 80

    # Uploads
    max_upload_mb: int = 40
    max_audio_upload_mb: int = 15

    seed_sample_books: bool = True

    @property
    def sqlalchemy_url(self) -> str:
        return self.database_url or f"sqlite:///{(self.data_dir / 'app.db').as_posix()}"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def resolve_provider(self, requested: str) -> str:
        if requested != "auto":
            return requested
        for name, key in (("groq", self.groq_api_key), ("xai", self.xai_api_key),
                          ("gemini", self.gemini_api_key), ("openai", self.openai_api_key)):
            if key:
                return name
        return "local"

    def signing_secret(self) -> str:
        """JWT secret: from the environment, else a random one persisted on first run."""
        if self.jwt_secret:
            return self.jwt_secret
        path = self.data_dir / ".jwt_secret"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(secrets.token_urlsafe(48), encoding="utf-8")
        return path.read_text(encoding="utf-8").strip()


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings
