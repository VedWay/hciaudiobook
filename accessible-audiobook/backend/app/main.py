"""FastAPI application entry point:  uvicorn app.main:app --reload  (run from backend/)."""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import assistant, auth, books, evaluation, qa, speech
from .config import get_settings
from .db import init_db
from .services.providers import get_providers
from .services.seed import seed_sample_books

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    # Sample books are prepared in the background so the API is reachable immediately.
    threading.Thread(target=seed_sample_books, daemon=True).start()
    yield


app = FastAPI(title="Accessible RAG Audiobook API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=get_settings().cors_origin_list,
    allow_methods=["*"], allow_headers=["*"],
)
for module in (auth, books, qa, speech, evaluation, assistant):
    app.include_router(module.router)


@app.get("/api/health", tags=["system"])
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/config", tags=["system"])
def config() -> dict:
    """Which providers are active, so the frontend can pick speech engines and label offline answers."""
    return get_providers().capabilities()
