"""Server-side speech-to-text providers.

The browser's own speech recognition is the default (lowest latency, nothing to
upload). These providers are used when the browser has none (e.g. Firefox) or
when the user prefers server transcription.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Protocol


class STTError(RuntimeError):
    pass


class STTProvider(Protocol):
    name: str

    def transcribe(self, audio: bytes, mime_type: str, language: str = "en") -> str: ...


_EXTENSIONS = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3",
               "audio/wav": "wav", "audio/x-wav": "wav"}

# Whisper spells what it hears the way its prompt is spelled. This makes the short commands - which
# have no sentence around them to help - come out as the words the app knows.
VOCABULARY = ("Voice commands for an audiobook app: pause. continue. continue reading. resume. start reading. stop. "
              "repeat that. go back. go forward. next chapter. previous section. faster. slower. louder. "
              "ask a question. explain that. give me an example. summarize. bookmark this. where am I. help. cancel.")

# What Whisper writes when handed silence, breath or room noise.
_HALLUCINATIONS = {
    "", "you", "thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching",
    "bye", "bye bye", "okay", "ok", "so", "uh", "um", "hmm", "mm", "the", "i", "oh", "ah", "yeah",
    "subtitles by the amara org community", "please subscribe", "music", "applause", "silence", "foreign",
}


# The same hint in the listener's own language: an English hint makes Whisper translate Hindi instead of writing it down.
_VOCABULARY_BY_LANGUAGE = {
    "hi": ("ऑडियोबुक के लिए बोले गए आदेश: रुको। पढ़ना शुरू करो। आगे बढ़ो। जारी रखो। फिर से बोलो। अगला अध्याय। धीरे। तेज़। "
           "समझाओ। एक सवाल है।"),
    "mr": ("ऑडिओबुकसाठी बोललेल्या आज्ञा: थांबा। वाचा। पुढे वाचा। पुन्हा सांगा। पुढचा धडा। हळू। समजावून सांगा। "
           "एक प्रश्न आहे।"),
}
_LANGUAGES = {"en", "hi", "mr", "bn", "ta", "te", "gu", "kn", "ml", "ur", "pa", "es", "fr", "de", "it", "pt", "ar", "zh", "ja", "ko", "ru"}

# Measured on Groq's Whisper with the hint above: real speech scores -0.9 or better (usually -0.1 to
# -0.6); silence, hum, clicks and room noise score -1.2 or worse. Its "no speech" figure is always 0.
_MIN_CONFIDENCE = -1.0
# The same word, spoken the same way, scores anywhere from -0.3 to about -1.0 ("continue" did). Noise
# never came back as one of the app's own commands, so those are believed on weaker evidence -
# otherwise the filter that keeps noise out would throw away the very words it is there to protect.
_MIN_COMMAND_CONFIDENCE = -1.6


def _words(text: str) -> str:
    # Combining marks are kept: without them Hindi words fall apart into separate letters.
    return " ".join("".join(c.lower() if c.isalnum() or c.isspace() or unicodedata.category(c).startswith("M") else " "
                            for c in text).split())


def _phrases(hint: str) -> set[str]:
    return {phrase for phrase in (_words(part) for part in re.split(r"[.।]", hint.split(":", 1)[-1])) if phrase}


def _collapse(text: str) -> tuple[str, bool]:
    """Whisper sometimes gets stuck and writes the same thing over and over ("pause. pause. pause.").
    Returns the text said once, and whether anything had been repeated."""
    kept: list[str] = []
    repeated = False
    for sentence in re.split(r"(?<=[.?!।])\s+", text.strip()):
        words = _words(sentence).split()
        if not words:
            continue
        if len(set(words)) == 1 and len(words) > 1:  # "pause pause pause."
            sentence, words, repeated = words[0], words[:1], True
        if kept and _words(kept[-1]).split() == words:
            repeated = True
            continue
        kept.append(sentence)
    return " ".join(kept), repeated


def _is_noise(text: str, repeated: bool = False) -> bool:
    plain = _words(text)
    # A whole sentence written out again and again is Whisper inventing speech for a noise;
    # a short command that got repeated was really said (once).
    return plain in _HALLUCINATIONS or (repeated and len(plain.split()) > 3)


_COMMANDS = _phrases(VOCABULARY) | {p for hint in _VOCABULARY_BY_LANGUAGE.values() for p in _phrases(hint)}


class OpenAISTT:
    def __init__(self, api_key: str, model: str = "whisper-1", *, base_url: str | None = None,
                 label: str = "openai") -> None:
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=20)  # Groq hosts Whisper behind the same API
        self._model = model
        self.name = f"{label}:{model}"

    def transcribe(self, audio: bytes, mime_type: str, language: str = "en") -> str:
        """Returns '' for silence and noise. The language is always given: left to guess from one
        or two words, Whisper takes Hindi for Urdu and Marathi for Korean."""
        base_type = mime_type.split(";")[0].strip().lower()
        filename = f"question.{_EXTENSIONS.get(base_type, 'webm')}"
        language = language.lower()[:2] if language.lower()[:2] in _LANGUAGES else "en"
        options = {"prompt": _VOCABULARY_BY_LANGUAGE.get(language, VOCABULARY)} if language in ("en", "hi", "mr") else {}
        try:
            result = self._client.audio.transcriptions.create(
                model=self._model, file=(filename, audio, base_type), language=language, temperature=0,
                response_format="verbose_json", **options)
        except Exception as exc:
            raise STTError(str(exc)) from exc
        # Keep only the stretches Whisper is reasonably sure of: noise comes back as low-confidence invention.
        segments = getattr(result, "segments", None) or []
        spoken = []
        for segment in segments:
            get = segment.get if isinstance(segment, dict) else lambda key, default=None, s=segment: getattr(s, key, default)
            confidence = get("avg_logprob")
            said = (get("text", "") or "").strip()
            needed = _MIN_COMMAND_CONFIDENCE if _words(_collapse(said)[0]) in _COMMANDS else _MIN_CONFIDENCE
            if confidence is not None and confidence < needed:
                continue
            spoken.append(said)
        text = " ".join(part for part in spoken if part) if segments else (getattr(result, "text", "") or "").strip()
        text, repeated = _collapse(text)
        return "" if _is_noise(text, repeated) else text


class GeminiSTT:
    def __init__(self, api_key: str, model: str) -> None:
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._model = model
        self.name = f"gemini:{model}"

    def transcribe(self, audio: bytes, mime_type: str, language: str = "en") -> str:
        from google.genai import types

        try:
            response = self._client.models.generate_content(
                model=self._model,
                contents=[
                    types.Part.from_bytes(data=audio, mime_type=mime_type.split(";")[0].strip().lower()),
                    f"Transcribe the speech in this recording (language: {language}). Reply with the transcript "
                    "only, with no commentary. If there is no intelligible speech, reply with nothing.",
                ],
            )
        except Exception as exc:
            raise STTError(str(exc)) from exc
        return (response.text or "").strip()
