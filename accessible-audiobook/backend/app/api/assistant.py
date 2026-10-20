"""Conversational routing: turn a free-form spoken request into something the app can do.

The frontend understands many phrasings by itself. Anything it does not
recognise is sent here, where the language model maps it onto one of the app's
commands, treats it as a question about the book, answers small talk, or
decides it was not addressed to the app at all.
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends

from ..models import User
from ..models.schemas import InterpretRequest
from ..rag.types import LLMError
from ..services.providers import get_providers
from .deps import current_user

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

# Each line is a phrase the frontend's own grammar is guaranteed to understand.
COMMANDS = """\
start reading | pause | continue reading | stop | repeat that | stay paused | cancel
ask a question | explain that | explain this simply | give me an example | define this | define <term>
summarize this section | summarize this chapter | tell me more | quiz me | repeat the answer
go back <N> seconds | go forward <N> seconds | next sentence | previous sentence | next paragraph
next section | previous section | next chapter | previous chapter | go to chapter <N> | restart chapter
faster | slower | set speed to <0.75-2> | louder | quieter
where am i | bookmark this | go to my bookmark | list bookmarks | spell <word>
read the contents | what sections are in this chapter | go to the section on <topic> | go to page <N>
find <topic> | return to my place
take a note | note that <text> | read my notes | export my notes | review my questions
skim | read normally | sleep timer <N> minutes | stop at the end of this chapter | cancel the sleep timer
help | go to my books | go to settings | go to help | open <book title> | list my books
what are my settings | reset settings | male voice | female voice | indian voice | change the voice
i speak indian english | i speak hindi | i speak marathi | i speak american english
dark theme | yellow theme | light theme | bigger text | smaller text | reduce motion | allow motion
full feedback | short feedback | sounds only | sound cues on | sound cues off | vibration on | vibration off
screen reader mode on | screen reader mode off | microphone off
pause when i speak on | pause when i speak off | auto resume on | auto resume off
resume from the exact word | resume from the start of the sentence | resume from the previous sentence
follow up off | follow up 4 seconds | follow up 8 seconds | short answers | detailed answers
cite sources on | cite sources off | highlight words on | highlight words off | natural voice | device voice"""

SYSTEM = f"""You are the voice interface of an audiobook app used by blind students. The student said something \
the app did not recognise. Decide what they want and reply with JSON only, in one of these forms:

{{"kind": "command", "command": "<phrase>"}}   the request maps to an app command. Use exactly one phrase from \
the list below, filling in <...> parts.
{{"kind": "question", "question": "<text>"}}   they are asking about the content of the book (a concept, a term, \
why something is so). Rewrite it as a clear question.
{{"kind": "reply", "text": "<one short spoken sentence>"}}   small talk, thanks, or a question about the app \
itself that no command covers. Be warm and brief. Never claim to have changed something.
{{"kind": "ignore"}}   the words were not addressed to the app (background talk, fragments, noise).

Commands:
{COMMANDS}

Prefer "command" when one fits, even loosely ("my eyes hurt, it's too bright" -> dark theme; "you talk too much" \
-> short feedback; "I lost track" -> repeat that; "let's get back to it" or "okay I'm ready" -> continue reading; \
"I need a minute" -> pause). People phrase things indirectly and are misheard by the speech recogniser: go by \
what they most plausibly mean, not by the exact words.

Many students are Indian. Expect Indian English ("kindly start the reading", "do one thing, go back a little", \
"what is the meaning of this only", "I am having one doubt" -> ask a question, "repeat once more", "prepone to \
chapter two", "switch off the mic"), and Hindi, Marathi or Hinglish in either script ("padhna shuru karo" / \
"पढ़ना शुरू करो" -> start reading; "ruko", "ek minute", "थांबा" -> pause; "aage badho", "पुढे वाचा" -> continue \
reading; "phir se bolo" -> repeat that; "thoda dheere" -> slower; "tez karo" -> faster; "iska matlab samjhao" -> \
explain that; "ek example do" -> give me an example; "agla chapter" -> next chapter; "awaaz badhao" -> louder; \
"meri kitabein dikhao" -> go to my books). The command you return is always one of the English phrases from the \
list. A "question" is rewritten clearly in the language the student used. A "reply" is in the student's language.

Use "question" only when the student actually states what they want to know. If they only announce that they \
have a question or a doubt ("I have a doubt", "ek sawal hai", "can I ask something"), return the command \
"ask a question" - never invent a question for them.

The microphone is open while the app reads aloud through loudspeakers, so it often hears the app itself, \
sometimes with a word or two misheard. If what the microphone heard repeats or closely resembles what the app was \
just saying, or reads like a sentence from a textbook or story rather than something a person would say to an app, \
reply "ignore". A word such as "wait", "stop", "back" or "next" inside such a sentence is not a command. When \
unsure between "question" and "ignore", choose "ignore" if the app is reading aloud and the words do not form a \
request."""


@router.post("/interpret")
def interpret(body: InterpretRequest, _: User = Depends(current_user)) -> dict:
    answerer = get_providers().answerer
    if answerer.is_local:
        return {"kind": "ignore"}  # no language model configured: the built-in grammar is all there is
    prompt = (f"Screen: {body.page}\nApp state: {body.state or 'idle'}\n"
              f"Books available: {', '.join(body.books) or 'unknown'}\n")
    if body.reading:
        prompt += f"The app itself was just saying aloud: \"\"\"{body.reading}\"\"\"\n"
    prompt += f"The microphone heard: \"{body.utterance}\""
    try:
        raw = answerer.complete(SYSTEM, prompt)
        match = re.search(r"\{.*\}", raw, re.S)
        data = json.loads(match.group(0)) if match else {}
    except (LLMError, json.JSONDecodeError):
        # "failed" tells the app to fall back on its own keyword grammar rather than treat this as "not for us".
        return {"kind": "ignore", "failed": True}

    kind = data.get("kind")
    if kind == "command" and isinstance(data.get("command"), str):
        return {"kind": "command", "command": data["command"][:200]}
    if kind == "question" and isinstance(data.get("question"), str):
        return {"kind": "question", "question": data["question"][:500]}
    if kind == "reply" and isinstance(data.get("text"), str):
        return {"kind": "reply", "text": data["text"][:300]}
    return {"kind": "ignore"}
