"""Answer generation: Gemini, OpenAI, or an offline extractive fallback."""
from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Protocol

from ingestion.embeddings import tokenize

from .prompts import NOT_IN_BOOK, system_prompt, user_prompt
from .types import AnswerRequest, LLMError, RetrievedChunk


class Answerer(Protocol):
    name: str
    is_local: bool

    def stream(self, req: AnswerRequest) -> Iterator[str]:
        """Yield the answer text incrementally."""
        ...

    def complete(self, system: str, prompt: str) -> str:
        """One-shot completion for auxiliary tasks (quiz generation and marking)."""
        ...


class GeminiAnswerer:
    is_local = False

    def __init__(self, api_key: str, model: str, thinking_budget: int = 0) -> None:
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._model = model
        self._thinking_budget = thinking_budget
        self.name = f"gemini:{model}"

    def _config(self, system: str, max_tokens: int):
        from google.genai import types

        kwargs = dict(system_instruction=system, temperature=0.3, max_output_tokens=max_tokens)
        if self._thinking_budget >= 0:
            # Spoken answers must start quickly; skip extended thinking unless configured otherwise.
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=self._thinking_budget)
        return types.GenerateContentConfig(**kwargs)

    def stream(self, req: AnswerRequest) -> Iterator[str]:
        try:
            for part in self._client.models.generate_content_stream(
                model=self._model, contents=user_prompt(req),
                config=self._config(system_prompt(req), 400 if req.answer_length == "brief" else 800),
            ):
                if part.text:
                    yield part.text
        except Exception as exc:
            raise LLMError(str(exc)) from exc

    def complete(self, system: str, prompt: str) -> str:
        try:
            response = self._client.models.generate_content(
                model=self._model, contents=prompt, config=self._config(system, 400))
            return response.text or ""
        except Exception as exc:
            raise LLMError(str(exc)) from exc


class OpenAIAnswerer:
    """OpenAI, and any service that speaks the same chat-completions API (Groq, xAI Grok)."""

    is_local = False

    def __init__(self, api_key: str, model: str, *, base_url: str | None = None, label: str = "openai") -> None:
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url)
        self._model = model
        self.name = f"{label}:{model}"
        # GPT-OSS reasons before it answers. Keep that short (speech must start quickly), keep the
        # reasoning out of the reply, and leave room for it in the token budget.
        self._reasoning = "gpt-oss" in model
        self._extra = {"reasoning_effort": "low", "include_reasoning": False} if self._reasoning else None

    def _create(self, system: str, prompt: str, max_tokens: int, stream: bool):
        return self._client.chat.completions.create(
            model=self._model, stream=stream, temperature=0.3,
            max_completion_tokens=max_tokens + (1200 if self._reasoning else 0), extra_body=self._extra,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        )

    def stream(self, req: AnswerRequest) -> Iterator[str]:
        try:
            max_tokens = 400 if req.answer_length == "brief" else 800
            for event in self._create(system_prompt(req), user_prompt(req), max_tokens, stream=True):
                if event.choices and event.choices[0].delta.content:
                    yield event.choices[0].delta.content
        except Exception as exc:
            raise LLMError(str(exc)) from exc

    def complete(self, system: str, prompt: str) -> str:
        try:
            return self._create(system, prompt, 400, stream=False).choices[0].message.content or ""
        except Exception as exc:
            raise LLMError(str(exc)) from exc


_EXAMPLE_CUE = re.compile(r"\b(for example|for instance|suppose|consider|imagine|such as|a good everyday picture)\b", re.I)
_DEFINITION_CUE = r"\b(is|are|means|refers to|allows|happens when)\b"


class LocalExtractiveAnswerer:
    """LOCAL FALLBACK - no language model.

    Answers by quoting the most relevant sentences of the retrieved textbook
    passages. It cannot paraphrase or reason, but it is always grounded. Used
    only when no LLM API key is configured.
    """

    name = "local-extractive"
    is_local = True

    def stream(self, req: AnswerRequest) -> Iterator[str]:
        yield self._answer(req)

    def complete(self, system: str, prompt: str) -> str:
        raise LLMError("The offline answerer cannot generate free text.")

    @staticmethod
    def _topic_terms(req: AnswerRequest) -> list[str]:
        if req.intent == "define" and req.term:
            return tokenize(req.term)
        terms = tokenize(req.question) if req.intent in ("question", "elaborate") else []
        return terms or tokenize(req.reading.current_sentence) or tokenize(req.reading.recent_context)

    def _answer(self, req: AnswerRequest) -> str:
        if not req.chunks:
            return NOT_IN_BOOK
        if req.intent == "summarize":
            return self._summarize(req.chunks)

        terms = set(self._topic_terms(req))
        if not terms:
            return NOT_IN_BOOK
        limit = 2 if req.answer_length == "brief" else 4
        wants_definition = (req.intent in ("define", "explain", "simplify")
                            or re.match(r"^\s*(what|who)\b", req.question, re.I))
        interrupted = req.reading.current_sentence.strip()

        best: tuple[float, RetrievedChunk, int] | None = None
        for chunk in req.chunks:
            for i, sentence in enumerate(chunk.sentences):
                if req.intent == "example" and not _EXAMPLE_CUE.search(sentence):
                    continue
                tokens = set(tokenize(sentence))
                score = len(terms & tokens) / len(terms)
                if wants_definition and re.search(_DEFINITION_CUE, sentence):
                    # Reward sentences shaped like "<topic> is ...": the topic appears before the verb.
                    head = set(tokenize(re.split(_DEFINITION_CUE, sentence, maxsplit=1)[0]))
                    score += 0.4 * len(terms & head) / len(terms)
                if req.intent in ("explain", "simplify") and sentence.strip() == interrupted:
                    continue  # re-reading the sentence they did not understand explains nothing
                if best is None or score > best[0]:
                    best = (score, chunk, i)

        if best is None:
            return "Your textbook does not give an example of this in the part I can find."
        if best[0] < 0.34:
            return NOT_IN_BOOK
        _, chunk, index = best
        quoted = " ".join(chunk.sentences[index:index + limit])
        lead = "The book gives this example." if req.intent == "example" else "Here is what your textbook says."
        return f"{lead} {quoted}"

    @staticmethod
    def _summarize(chunks: list[RetrievedChunk]) -> str:
        # The first sentence of each passage is usually its topic sentence.
        picks = [c.sentences[0] for c in chunks if c.sentences][:5]
        return "Here are the main points of this section, in the book's own words. " + " ".join(picks)
