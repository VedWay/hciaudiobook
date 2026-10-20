"""What comes back from Whisper is cleaned before the app acts on it. The service itself is faked: no network."""
from types import SimpleNamespace

import pytest

from app.speech.stt import OpenAISTT, _collapse, _is_noise


def _stt(segments, calls=None):
    stt = OpenAISTT.__new__(OpenAISTT)
    stt._model, stt.name = "whisper", "test:whisper"

    def create(**options):
        if calls is not None:
            calls.append(options)
        return SimpleNamespace(text=" ".join(s["text"] for s in segments), segments=segments)

    stt._client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    return stt


def _segment(text, confidence=-0.3):
    return {"text": text, "avg_logprob": confidence, "compression_ratio": 0.8, "no_speech_prob": 0.0}


def test_a_command_is_returned_as_spoken():
    assert _stt([_segment(" pause.")]).transcribe(b"audio", "audio/wav", "en") == "pause."
    assert _stt([_segment(" What is virtual memory?", -0.32)]).transcribe(b"audio", "audio/wav") == "What is virtual memory?"


@pytest.mark.parametrize("invented, confidence", [
    (" is a good question.", -1.59), (" you", -1.23), (" the textbook.", -1.02),  # what noise comes back as: low confidence
    (" Thank you.", -0.29), (" .", -0.55), (" you", -0.4),  # ...or as one of Whisper's stock phrases for silence
])
def test_noise_and_silence_come_back_empty(invented, confidence):
    assert _stt([_segment(invented, confidence)]).transcribe(b"audio", "audio/wav", "en") == ""


def test_a_command_whisper_repeated_is_said_once_but_a_repeated_sentence_is_noise():
    assert _collapse("pause. pause. pause. pause.") == ("pause.", True)
    assert _collapse("pause pause. pause. pa pause.")[0].startswith("pause")
    assert _collapse("रुको। रुको। रुको।") == ("रुको।", True)
    assert _collapse("What is paging? Why is it used?") == ("What is paging? Why is it used?", False)
    assert _stt([_segment(" pause. pause. pause. pause. pause.", -0.12)]).transcribe(b"a", "audio/wav") == "pause."
    looping = " I'm going to ask you a question. I'm going to ask you a question."
    assert _stt([_segment(looping, -0.5)]).transcribe(b"a", "audio/wav") == ""
    assert not _is_noise("go back thirty seconds") and _is_noise("Thank you.") and _is_noise("")


def test_a_known_command_is_believed_on_weaker_evidence_than_anything_else():
    # Identical speech scored "continue" anywhere from -0.4 to -1.0; noise never came back as a command.
    for command in (" continue.", " pause.", " Next chapter.", " रुको।", " पढ़ना शुरू करो।", " pause. pause. pause."):
        assert _stt([_segment(command, -1.2)]).transcribe(b"a", "audio/wav") != ""
    assert _stt([_segment(" continue.", -2.5)]).transcribe(b"a", "audio/wav") == ""  # but not on no evidence at all
    assert _stt([_segment(" you can see.", -1.2)]).transcribe(b"a", "audio/wav") == ""


def test_the_language_is_always_given_with_a_hint_in_that_language():
    calls = []
    stt = _stt([_segment(" रुको।")], calls)
    assert stt.transcribe(b"a", "audio/wav", "hi") == "रुको।"
    stt.transcribe(b"a", "audio/wav", "en")
    stt.transcribe(b"a", "audio/wav", "auto")  # never left to guess: it takes Hindi for Urdu and Marathi for Korean
    stt.transcribe(b"a", "audio/wav", "ta")
    assert [c["language"] for c in calls] == ["hi", "en", "en", "ta"]
    assert "रुको" in calls[0]["prompt"] and "pause" in calls[1]["prompt"] and "prompt" not in calls[3]
    assert all(c["temperature"] == 0 for c in calls)
