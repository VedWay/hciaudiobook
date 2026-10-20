"""Server-side text-to-speech providers.

The default is Microsoft's neural voices through the ``edge-tts`` package: they
sound natural, need no API key, and report when each word is spoken - which
keeps "resume on the exact word" working with a server voice. The default voices
are the *Multilingual* ones, which read English like a person and also cope with
Spanish, French, German, Italian, Portuguese and more inside the same sentence.
Text in a non-Latin script (Hindi, Arabic, Chinese...) is routed to a native
voice for that language. OpenAI TTS is available with a key. Add ElevenLabs or
Google Cloud TTS by implementing the same interface.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Protocol


class TTSError(RuntimeError):
    pass


@dataclass
class SpeechClip:
    audio: bytes
    mime_type: str = "audio/mpeg"
    # (milliseconds into the clip, character index in the text) for each word; empty if unknown
    words: list[tuple[int, int]] = field(default_factory=list)


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    label: str
    locale: str
    gender: str


class TTSProvider(Protocol):
    name: str

    def synthesize(self, text: str, role: str = "narrator", voice: str | None = None) -> SpeechClip:
        """``role`` is "narrator" (the book) or "assistant" (answers); they use different voices.
        ``voice`` is one of ``voices()`` and overrides the role's default; unknown ids are ignored."""
        ...

    def voices(self) -> list[VoiceInfo]: ...

    def default_voice(self, role: str) -> str: ...


# --- Microsoft neural voices ------------------------------------------------

# Voices that read any supported language naturally. Offered in the settings screen.
EDGE_VOICES = [
    VoiceInfo("en-US-AvaMultilingualNeural", "Ava - warm, clear (US)", "en-US", "Female"),
    VoiceInfo("en-US-EmmaMultilingualNeural", "Emma - bright, friendly (US)", "en-US", "Female"),
    VoiceInfo("en-US-AndrewMultilingualNeural", "Andrew - calm, conversational (US)", "en-US", "Male"),
    VoiceInfo("en-US-BrianMultilingualNeural", "Brian - steady, authoritative (US)", "en-US", "Male"),
    VoiceInfo("en-IN-NeerjaExpressiveNeural", "Neerja - expressive (Indian English)", "en-IN", "Female"),
    VoiceInfo("en-IN-NeerjaNeural", "Neerja - clear (Indian English)", "en-IN", "Female"),
    VoiceInfo("en-IN-PrabhatNeural", "Prabhat - steady (Indian English)", "en-IN", "Male"),
    VoiceInfo("en-AU-WilliamMultilingualNeural", "William - relaxed (Australian)", "en-AU", "Male"),
    VoiceInfo("fr-FR-VivienneMultilingualNeural", "Vivienne (French, reads English too)", "fr-FR", "Female"),
    VoiceInfo("fr-FR-RemyMultilingualNeural", "Remy (French, reads English too)", "fr-FR", "Male"),
    VoiceInfo("de-DE-SeraphinaMultilingualNeural", "Seraphina (German, reads English too)", "de-DE", "Female"),
    VoiceInfo("de-DE-FlorianMultilingualNeural", "Florian (German, reads English too)", "de-DE", "Male"),
    VoiceInfo("it-IT-GiuseppeMultilingualNeural", "Giuseppe (Italian, reads English too)", "it-IT", "Male"),
    VoiceInfo("pt-BR-ThalitaMultilingualNeural", "Thalita (Portuguese, reads English too)", "pt-BR", "Female"),
    VoiceInfo("ko-KR-HyunsuMultilingualNeural", "Hyunsu (Korean, reads English too)", "ko-KR", "Male"),
]

# Native voices for scripts that the multilingual voices would read with a foreign accent:
# script -> (narrator, assistant).
NATIVE_VOICES: dict[str, tuple[str, str]] = {
    "devanagari": ("hi-IN-SwaraNeural", "hi-IN-MadhurNeural"),
    "marathi": ("mr-IN-AarohiNeural", "mr-IN-ManoharNeural"),
    "bengali": ("bn-IN-TanishaaNeural", "bn-IN-BashkarNeural"),
    "tamil": ("ta-IN-PallaviNeural", "ta-IN-ValluvarNeural"),
    "telugu": ("te-IN-ShrutiNeural", "te-IN-MohanNeural"),
    "gujarati": ("gu-IN-DhwaniNeural", "gu-IN-NiranjanNeural"),
    "kannada": ("kn-IN-SapnaNeural", "kn-IN-GaganNeural"),
    "malayalam": ("ml-IN-SobhanaNeural", "ml-IN-MidhunNeural"),
    "arabic": ("ar-SA-ZariyahNeural", "ar-SA-HamedNeural"),
    "cyrillic": ("ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"),
    "han": ("zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"),
    "kana": ("ja-JP-NanamiNeural", "ja-JP-KeitaNeural"),
    "hangul": ("ko-KR-SunHiNeural", "ko-KR-InJoonNeural"),
    "greek": ("el-GR-AthinaNeural", "el-GR-NestorasNeural"),
    "hebrew": ("he-IL-HilaNeural", "he-IL-AvriNeural"),
    "thai": ("th-TH-PremwadeeNeural", "th-TH-NiwatNeural"),
}

_SCRIPTS = [
    ("kana", r"[぀-ヿ]"),  # before "han": Japanese mixes kana with Chinese characters
    ("han", r"[一-鿿]"),
    ("hangul", r"[가-힯ᄀ-ᇿ]"),
    ("devanagari", r"[ऀ-ॿ]"),
    ("bengali", r"[ঀ-৿]"),
    ("gujarati", r"[઀-૿]"),
    ("tamil", r"[஀-௿]"),
    ("telugu", r"[ఀ-౿]"),
    ("kannada", r"[ಀ-೿]"),
    ("malayalam", r"[ഀ-ൿ]"),
    ("arabic", r"[؀-ۿݐ-ݿ]"),
    ("cyrillic", r"[Ѐ-ӿ]"),
    ("greek", r"[Ͱ-Ͽ]"),
    ("hebrew", r"[֐-׿]"),
    ("thai", r"[฀-๿]"),
]
_SCRIPT_PATTERNS = [(name, re.compile(pattern)) for name, pattern in _SCRIPTS]
_LETTER = re.compile(r"[^\W\d_]")


# Hindi and Marathi share a script. These everyday words exist in only one of the two.
_MARATHI_WORDS = re.compile(r"(?<![ऀ-ॿ])(आहे|आहेत|आणि|नाही|मध्ये|काय|ती|ते|त्या|त्याने|तिने|मला|तुला|"
                            r"म्हणजे|म्हणून|झाले|झाला|झाली|साठी|पण|हे|खूप|होय|कसे|कुठे)(?![ऀ-ॿ])")
_HINDI_WORDS = re.compile(r"(?<![ऀ-ॿ])(है|हैं|और|नहीं|था|थी|थे|में|क्या|वह|यह|उस|उसने|मुझे|तुम|हम|यानी|इसलिए|"
                          r"हुआ|किया|लेकिन|को|से|बहुत|कैसे|कहाँ)(?![ऀ-ॿ])")


def dominant_script(text: str) -> str | None:
    """The non-Latin script that most of the text is written in, or None for Latin-script text.
    Devanagari text that reads as Marathi rather than Hindi is reported as "marathi"."""
    letters = len(_LETTER.findall(text))
    if not letters:
        return None
    for name, pattern in _SCRIPT_PATTERNS:
        if len(pattern.findall(text)) * 3 >= letters:  # a third or more of the letters
            if name == "devanagari" and len(_MARATHI_WORDS.findall(text)) > len(_HINDI_WORDS.findall(text)):
                return "marathi"
            return name
    return None


class EdgeTTS:
    """Microsoft Edge's online neural voices. Needs internet access; no key. Unofficial service."""

    def __init__(self, narrator_voice: str, assistant_voice: str) -> None:
        import edge_tts  # noqa: F401  (fail at start-up, not mid-sentence, if the package is missing)

        self._voices = {"narrator": narrator_voice, "assistant": assistant_voice}
        self._allowed = {v.id for v in EDGE_VOICES} | {narrator_voice, assistant_voice}
        self.name = f"edge-neural:{narrator_voice}"

    def voices(self) -> list[VoiceInfo]:
        return list(EDGE_VOICES)

    def default_voice(self, role: str) -> str:
        return self._voices.get(role, self._voices["narrator"])

    def _choose(self, text: str, role: str, voice: str | None) -> list[str]:
        """Voices to try, best first: the native voice for the script, else the chosen voice, then a safe default."""
        script = dominant_script(text)
        if script in NATIVE_VOICES:
            native = NATIVE_VOICES[script][0 if role != "assistant" else 1]
            return [native, self.default_voice(role)]
        preferred = voice if voice in self._allowed else self.default_voice(role)
        plain = preferred.replace("Multilingual", "")  # en-US-AvaMultilingualNeural -> en-US-AvaNeural
        return list(dict.fromkeys([preferred, plain, "en-US-AvaNeural"]))  # in order, without repeats

    async def _run(self, text: str, voice: str) -> SpeechClip:
        import edge_tts

        audio = bytearray()
        words: list[tuple[int, int]] = []
        cursor = 0
        # Short timeouts: if the service is unreachable the player must find out quickly and switch
        # to the device's own voice, rather than leave the listener in silence.
        communicate = edge_tts.Communicate(text, voice, boundary="WordBoundary", connect_timeout=5, receive_timeout=15)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                index = text.find(chunk["text"], cursor)
                if index >= 0:
                    words.append((chunk["offset"] // 10_000, index))  # offsets arrive in 100 ns units
                    cursor = index + len(chunk["text"])
        if not audio:
            raise TTSError("The voice service returned no audio.")
        return SpeechClip(bytes(audio), "audio/mpeg", words)

    def synthesize(self, text: str, role: str = "narrator", voice: str | None = None) -> SpeechClip:
        failure: Exception | None = None
        for candidate in self._choose(text, role, voice)[:2]:  # the preferred voice, then one alternative
            try:
                return asyncio.run(self._run(text, candidate))
            except Exception as exc:
                failure = exc
        raise TTSError(str(failure)) from failure


# --- OpenAI -----------------------------------------------------------------

OPENAI_VOICES = [
    VoiceInfo("alloy", "Alloy - neutral", "en", "Neutral"),
    VoiceInfo("nova", "Nova - bright", "en", "Female"),
    VoiceInfo("shimmer", "Shimmer - soft", "en", "Female"),
    VoiceInfo("coral", "Coral - warm", "en", "Female"),
    VoiceInfo("sage", "Sage - calm", "en", "Female"),
    VoiceInfo("onyx", "Onyx - deep", "en", "Male"),
    VoiceInfo("echo", "Echo - clear", "en", "Male"),
    VoiceInfo("fable", "Fable - expressive", "en", "Male"),
]

# gpt-4o-mini-tts takes free-text direction; this is what makes it read like an audiobook, not a screen reader.
_STYLE = {
    "narrator": "Read as a warm, engaging audiobook narrator: natural pacing, gentle emphasis on key terms, "
                "a short pause at the end of each sentence. Speak the language of the text.",
    "assistant": "Speak as a friendly, patient tutor answering a student: conversational and clear.",
}


class OpenAITTS:
    def __init__(self, api_key: str, model: str, narrator_voice: str, assistant_voice: str) -> None:
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key)
        self._model = model
        self._voices = {"narrator": narrator_voice, "assistant": assistant_voice}
        self._allowed = {v.id for v in OPENAI_VOICES} | {narrator_voice, assistant_voice}
        self.name = f"openai:{model}"

    def voices(self) -> list[VoiceInfo]:
        return list(OPENAI_VOICES)

    def default_voice(self, role: str) -> str:
        return self._voices.get(role, self._voices["narrator"])

    def synthesize(self, text: str, role: str = "narrator", voice: str | None = None) -> SpeechClip:
        options = {"instructions": _STYLE.get(role, _STYLE["narrator"])} if "gpt-4o" in self._model else {}
        try:
            response = self._client.audio.speech.create(
                model=self._model, voice=voice if voice in self._allowed else self.default_voice(role),
                input=text, response_format="mp3", **options)
        except Exception as exc:
            raise TTSError(str(exc)) from exc
        return SpeechClip(response.content)
