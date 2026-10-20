"""Server-side speech endpoints (used when the browser's own speech engines are not)."""
from __future__ import annotations

import json
from functools import lru_cache

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status

from ..config import get_settings
from ..models import User
from ..models.schemas import SynthesizeRequest
from ..services.providers import get_providers
from ..speech.stt import STTError
from ..speech.tts import SpeechClip, TTSError
from .deps import current_user

router = APIRouter(prefix="/api/speech", tags=["speech"])


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form(default="en", max_length=8),
                     _: User = Depends(current_user)) -> dict:
    stt = get_providers().stt
    if stt is None:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Server speech recognition is not configured.")
    mime_type = (audio.content_type or "").lower()
    if not mime_type.startswith("audio/"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Expected an audio recording.")
    limit = get_settings().max_audio_upload_mb * 1024 * 1024
    data = await audio.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "That recording is too long.")
    if not data:
        raise HTTPException(422, "The recording was empty.")
    try:
        return {"text": stt.transcribe(data, mime_type, language), "provider": stt.name}
    except STTError as exc:
        # A busy service is not a broken one: the app waits a moment instead of switching the microphone off.
        busy = "429" in str(exc) or "rate limit" in str(exc).lower()
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS if busy else status.HTTP_502_BAD_GATEWAY,
                            "Speech recognition is busy." if busy else "Speech recognition failed.") from None


@router.get("/voices")
def voices(_: User = Depends(current_user)) -> dict:
    """The natural voices the listener can choose between, and which ones are used by default."""
    tts = get_providers().tts
    if tts is None:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Server text-to-speech is not configured.")
    return {"voices": [vars(v) for v in tts.voices()],
            "defaults": {"narrator": tts.default_voice("narrator"), "assistant": tts.default_voice("assistant")}}


@router.post("/synthesize")
def synthesize(body: SynthesizeRequest, _: User = Depends(current_user)) -> Response:
    if get_providers().tts is None:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Server text-to-speech is not configured.")
    try:
        clip = _clip(body.text, body.role, body.voice)
    except TTSError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Speech synthesis failed.") from None
    # Word timings travel in a header so the body stays plain audio: [[milliseconds, character index], ...]
    return Response(content=clip.audio, media_type=clip.mime_type,
                    headers={"X-Word-Timings": json.dumps(clip.words, separators=(",", ":")),
                             "Access-Control-Expose-Headers": "X-Word-Timings"})


@lru_cache(maxsize=256)
def _clip(text: str, role: str, voice: str | None) -> SpeechClip:
    """Status phrases and re-read sentences recur constantly; synthesise each only once."""
    return get_providers().tts.synthesize(text, role, voice)
