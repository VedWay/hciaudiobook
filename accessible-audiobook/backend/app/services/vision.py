"""Describing a book's pictures in words, for a listener who cannot see them.

A sighted child reading a picture book gets half the story from the pictures:
who looks frightened, how soft the rabbit is, how dark the forest has become.
Each picture is therefore described once, when the book is added, and the
description is read aloud at the place where the picture sits on the page.
"""
from __future__ import annotations

import base64
import time
from typing import Protocol

PROMPT = """\
You are describing a picture from a book to a blind listener, who will HEAR your words read aloud at the point \
where the picture appears. Make them feel the picture, not just know what is in it.

First decide what kind of picture it is.

A story illustration (children's book, novel, comic): describe it the way a warm storyteller would, in four to \
six short sentences.
- Who or what is there, and what they are doing.
- Faces and bodies: the expression, and the feeling behind it (wide worried eyes, a proud little grin, drooping \
whiskers, shoulders hunched against the cold).
- Touch: what things would feel like under the fingers (soft fluffy fur, rough bark, cool smooth pebbles, sticky mud).
- The mood of the colours and the light, tied to a feeling or a temperature rather than only named (a warm \
butter-yellow sun, a cold grey sky pressing down).
- The sounds, smells or weather the scene suggests (rain pattering on leaves, the smell of wet earth).
- Where things are: left, right, in front, far behind, high above.

A diagram, chart, graph, map, table or photograph in a textbook: say plainly and precisely what it shows, in three \
to five short sentences - the parts, how they connect, the direction of any flow, the main trend or numbers, and \
the point it makes.

Rules:
- Plain spoken sentences only. No markdown, lists, headings or emoji.
- Do not begin with "The image shows", "This picture" or "In this image". Start with the scene itself.
- Do not invent names. Use names only if they appear in the text from the page, given below.
- If the picture contains printed words that are part of the story and are not in the page text, read them out first.
- Describe only what is there. Do not guess what happens next.
- If it is only decoration - a logo, a border, a blank or plain shape, a page ornament - reply with the single word SKIP.

Text on the same page, for context (may be empty):
\"\"\"{context}\"\"\""""


class PictureDescriber(Protocol):
    name: str

    def describe(self, image_jpeg: bytes, context: str) -> str:
        """A spoken description of the picture, or '' if it is decoration or could not be described."""
        ...


def _clean(text: str) -> str:
    text = " ".join((text or "").replace("*", "").replace("#", "").split())
    return "" if not text or text.upper().strip(". ") == "SKIP" else text


def _wait_asked_for(exc: Exception) -> float:
    """Seconds the service asked us to wait (its Retry-After header), within reason."""
    try:
        asked = float(exc.response.headers.get("retry-after", ""))  # type: ignore[attr-defined]
    except (AttributeError, TypeError, ValueError):
        asked = 20.0
    return min(90.0, max(2.0, asked + 1.0))


class OpenAIVision:
    """OpenAI, and services with the same chat API that accept images (Groq's vision models, xAI Grok)."""

    def __init__(self, api_key: str, model: str, *, base_url: str | None = None, label: str = "openai") -> None:
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=45, max_retries=0)  # waits are handled below
        self._model = model
        self.name = f"{label}:{model}"

    def describe(self, image_jpeg: bytes, context: str) -> str:
        uri = "data:image/jpeg;base64," + base64.b64encode(image_jpeg).decode()
        for attempt in range(8):
            try:
                response = self._client.chat.completions.create(
                    model=self._model, temperature=0.4, max_completion_tokens=600,
                    messages=[{"role": "user", "content": [
                        {"type": "text", "text": PROMPT.format(context=context[:500])},
                        {"type": "image_url", "image_url": {"url": uri}},
                    ]}],
                )
                return _clean(response.choices[0].message.content or "")
            except Exception as exc:
                # A book has many pictures and a free allowance covers only two or three a minute.
                # Being told to slow down is a reason to wait as long as asked, not to skip the picture.
                busy = getattr(exc, "status_code", None) == 429 or "rate limit" in str(exc).lower()
                if not busy or attempt == 7:
                    raise
                time.sleep(_wait_asked_for(exc))
        return ""


class GeminiVision:
    def __init__(self, api_key: str, model: str) -> None:
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._model = model
        self.name = f"gemini:{model}"

    def describe(self, image_jpeg: bytes, context: str) -> str:
        from google.genai import types

        response = self._client.models.generate_content(
            model=self._model,
            contents=[types.Part.from_bytes(data=image_jpeg, mime_type="image/jpeg"), PROMPT.format(context=context[:1200])],
            config=types.GenerateContentConfig(temperature=0.4, max_output_tokens=600),
        )
        return _clean(response.text or "")
