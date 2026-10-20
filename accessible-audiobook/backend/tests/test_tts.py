"""Voice choice and fallback for the server text-to-speech. No network: the speech call itself is faked."""
import pytest

from app.api import speech as speech_api
from app.services.providers import get_providers
from app.speech.tts import EDGE_VOICES, NATIVE_VOICES, EdgeTTS, SpeechClip, TTSError, dominant_script

NARRATOR = "en-US-AvaMultilingualNeural"
ASSISTANT = "en-US-AndrewMultilingualNeural"


@pytest.mark.parametrize("text, script", [
    ("Stacks are last in, first out.", None),
    ("La pila es el último en entrar, el primero en salir.", None),  # Latin script: the multilingual voices cope
    ("स्टैक में आखिरी आया तत्व सबसे पहले बाहर निकलता है।", "devanagari"),
    ("The word नमस्ते means hello.", None),  # mostly English: keep the English voice
    ("栈是后进先出的数据结构。", "han"),
    ("スタックは後入れ先出しです。", "kana"),  # kana wins over the Chinese characters mixed in
    ("스택은 후입선출 구조입니다.", "hangul"),
    ("المكدس هو هيكل بيانات.", "arabic"),
    ("Стек — это структура данных.", "cyrillic"),
    ("1234 ... !!!", None),
])
def test_dominant_script(text, script):
    assert dominant_script(text) == script


def test_every_script_has_a_distinct_voice_for_each_role():
    for narrator, assistant in NATIVE_VOICES.values():
        assert narrator != assistant


def _tts(monkeypatch, failing=()):
    tts = EdgeTTS(NARRATOR, ASSISTANT)
    spoken = []

    async def run(text, voice):
        spoken.append(voice)
        if voice in failing:
            raise TTSError("boom")
        return SpeechClip(b"audio", "audio/mpeg", [(0, 0)])

    monkeypatch.setattr(tts, "_run", run)
    return tts, spoken


def test_roles_use_their_default_voice(monkeypatch):
    tts, spoken = _tts(monkeypatch)
    tts.synthesize("Hello there.", "narrator")
    tts.synthesize("Hello there.", "assistant")
    assert spoken == [NARRATOR, ASSISTANT]


def test_a_listed_voice_overrides_the_default_and_an_unknown_one_is_ignored(monkeypatch):
    tts, spoken = _tts(monkeypatch)
    tts.synthesize("Hello there.", "narrator", "en-US-BrianMultilingualNeural")
    tts.synthesize("Hello there.", "narrator", "not-a-real-voice")
    assert spoken == ["en-US-BrianMultilingualNeural", NARRATOR]


def test_non_latin_text_goes_to_the_native_voice(monkeypatch):
    tts, spoken = _tts(monkeypatch)
    tts.synthesize("स्टैक में आखिरी आया तत्व सबसे पहले बाहर निकलता है।", "narrator")
    tts.synthesize("स्टैक में आखिरी आया तत्व सबसे पहले बाहर निकलता है।", "assistant")
    assert spoken == ["hi-IN-SwaraNeural", "hi-IN-MadhurNeural"]


def test_falls_back_to_the_plain_neural_voice_when_the_multilingual_one_fails(monkeypatch):
    tts, spoken = _tts(monkeypatch, failing={NARRATOR})
    assert tts.synthesize("Hello there.", "narrator").audio == b"audio"
    assert spoken == [NARRATOR, "en-US-AvaNeural"]


def test_reports_failure_when_every_voice_fails(monkeypatch):
    tts, spoken = _tts(monkeypatch, failing={NARRATOR, "en-US-AvaNeural"})
    with pytest.raises(TTSError):
        tts.synthesize("Hello there.", "narrator")
    assert len(spoken) == 2  # does not keep the listener waiting through a third attempt


def test_voices_endpoint_and_synthesize_pass_the_chosen_voice_through(client, monkeypatch):
    tts, spoken = _tts(monkeypatch)
    real = get_providers()
    monkeypatch.setattr(type(real), "tts", property(lambda self: tts))
    speech_api._clip.cache_clear()
    try:
        listing = client.get("/api/speech/voices").json()
        assert {v["id"] for v in listing["voices"]} == {v.id for v in EDGE_VOICES}
        assert listing["defaults"] == {"narrator": NARRATOR, "assistant": ASSISTANT}

        reply = client.post("/api/speech/synthesize",
                            json={"text": "Hello there.", "role": "narrator", "voice": "en-US-EmmaMultilingualNeural"})
        assert reply.status_code == 200 and reply.content == b"audio"
        assert spoken == ["en-US-EmmaMultilingualNeural"]
    finally:
        speech_api._clip.cache_clear()  # do not leave the fake's clip cached for other tests
