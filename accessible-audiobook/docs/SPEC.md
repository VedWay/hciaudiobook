# Project brief (optimized prompt)

This is the original brief, tightened and extended. It can be given to an AI coding assistant to rebuild or extend
the project, and it doubles as the requirements document. Additions to the original are marked **[added]**.

---

Build **"Accessible RAG Audiobook: an AI-powered interactive audiobook for blind students"**, a polished HCI
prototype for a university demonstration.

## 1. Goal

A student listens to a textbook read aloud. At any moment they can interrupt by voice and ask about what they are
hearing. The system pauses, answers from the textbook, and resumes **from the exact word** where it stopped.
The central innovation is context-aware interruption and seamless resumption. It must feel like a reading companion,
not a chatbot. Prioritise this flow above every other feature.

## 2. Users and constraints

- Primary: blind students. Secondary: low-vision students; students using braille displays; deaf-blind students.
- Never require the user to locate something visually. Every action is available by voice, by keyboard, by touch,
  and **[added]** by typed text.
- **[added]** Assume a screen reader may be running. The app's voice and the screen reader must never speak over
  each other: ask once at first run, and route status messages to ARIA live regions when a screen reader is in use.
- **[added]** Browsers block audio until a user gesture: the first screen accepts any key or tap.
- **[added]** Must run with no API keys (offline fallbacks, clearly labelled), so it can always be demonstrated.

## 3. Interaction state machine (implement exactly)

`PLAYING → PAUSING → CAPTURE_CONTEXT → LISTENING → TRANSCRIBING → RETRIEVING → GENERATING → SPEAKING_ANSWER →
RESUME_CONFIRMATION → PLAYING`, with failure states `STT_FAILED`, `RAG_FAILED`, `LLM_FAILED`, `TTS_FAILED`,
`NETWORK_ERROR`.

- Requests that need no spoken question ("explain that") skip `LISTENING`.
- Each failure speaks a plain-language message, then returns the student to the book at the saved position.
- **[added]** One automatic retry before `STT_FAILED`. A blocked microphone falls back to a typed question.
- **[added]** Optional `FOLLOW_UP` window after an answer.
- **[added]** Auto-resume only if the book was playing when interrupted; "stay paused" overrides it.
- **[added]** Any new user action cancels the flow in progress cleanly (no overlapping speech, no stale resumes).
- **[added]** Expose the recent transitions in the UI as an "interaction trace" for demonstrations.

## 4. Playback state (most important implementation requirement)

Position = `{bookId, chapterId, chunkId, sentenceIndex, characterOffset, audioTime, status}`. Track it continuously
from word-boundary events. Save on interrupt (as a checkpoint), on pause, periodically, and when the page is hidden.
- **[added]** Speak one sentence per utterance; implement pause as cancel-and-remember, not the browser's pause.
- **[added]** Estimate the offset from elapsed time for voices without boundary events; calibrate speaking rate.
- **[added]** Resume point is a preference: exact word (default), start of sentence, one sentence earlier.
- **[added]** "Go back 30 seconds" means 30 seconds of listening at the current speed and lands on a sentence start.

## 5. Voice, keyboard and typed commands

Start reading, pause, resume, stop, repeat that / what did you just say, ask a question, explain that, explain this
simply, give me an example, define this, summarize this section, go back / forward N seconds, continue reading.

**[added]** A spoken question with no preamble ("What is virtual memory?"); next / previous sentence, paragraph,
section, chapter; go to chapter N; faster / slower / louder / quieter; where am I; bookmark this / go to my
bookmark; tell me more; quiz me; repeat the answer; stay paused; never mind; help / what can I say; spell a word.
Phrasing must be flexible. Voice, keys, touch and typing all map to one `Intent` type handled in one place.

Shortcuts: Space/K play-pause, A ask, R repeat, ←/→ 10 s, Shift+←/→ 30 s, P/N section, [ ] speed, - = volume,
E explain, X example, U summarize, Q quiz, C continue, W where am I, B bookmark, M microphone, T or / type, S stop,
H or ? help, Esc cancel. Never fire while typing in a field.

**[added] Study tools, all by voice, keyboard and on screen:**
- Table of contents: "read the contents", "what sections are in this chapter", "go to the section on <topic>",
  "go to page N". A heading is matched by word stems; if no heading matches, fall back to searching the text.
- Find in book: "find where it talks about <topic>" uses the vector search without reading-position bias, lands on
  the best single sentence, and says plainly when nothing matches.
- "Return to my place" after any jump, to the exact word; a run of jumps keeps only the place originally left.
- Skim mode: headings and the first sentence of each paragraph, with an audible tick at each skip; "read this part"
  returns to the start of the paragraph in full. Requires paragraph boundaries from ingestion.
- Notes pinned to the sentence being read: "take a note" (dictate), "note that ...", "read my notes"; a downloadable
  study sheet of notes, bookmarks, questions and answers in plain Markdown.
- Sleep timer: "stop reading in 20 minutes", "stop at the end of this chapter"; always finishes the sentence.
- Commands that carry free text ("find ...", "note that ...") must pass the echo filter like questions do, since the
  narrator may say the same words.
- All of these are disabled during evaluation trials so that the two evaluated systems stay as defined.

**[added] Any setting and any screen by voice:** "yellow theme", "bigger text", "short answers", "sounds only",
"go to settings", "what are my settings". One voice layer on every screen, with a typed command box beside it.
When an LLM is configured, unrecognised phrases are sent to it and mapped to a command, a question, a short reply,
or ignored as background talk.

## 6. Open-microphone behaviour **[added]**

- Always-listening mode and push-to-ask mode; the microphone state is always visible and toggled with one key.
- Echo filter: ignore transcripts that match what the app is speaking now or finished within the recogniser's lag.
  Do not filter against older speech (a question may repeat a heading that was just read).
- Barge-in: stop the narrator when the student starts speaking; resume from the same word if it was not for the app.

## 7. Feedback

Always say what the system is doing: "Paused." "Listening." "Searching your textbook." "Continuing from where you
stopped." **[added]** Add earcons (mic open, heard, thinking tick, answer ready, error), optional vibration, and a
verbosity setting: full sentences, short words, or sounds only. **[added]** Narrator and assistant use different
voices. **[added]** Use a natural neural voice by default, with word timings so exact resume still works, and fall
back to the device voice (for a while, not per sentence) when the voice service is slow or unreachable.
**[added]** For users without a screen reader, name each control as the keyboard reaches it, with its state.
**[added]** Reopening a book later starts at the beginning of the sentence, after saying the chapter and section.

## 8. RAG

Ingestion: PDF → extract text → clean → detect chapters and sections → paragraph-based chunks → embeddings → Qdrant.
Chunk metadata: `book_id, chapter, section, page, chunk_id, text`. Do not split blindly every N characters.
- **[added]** Chunks never cross a section; overlap is kept out of the reading text and used only for embeddings.
- **[added]** Remove running headers, footers and page numbers; rejoin hyphenated words and cross-page paragraphs.

Retrieval query combines the question, chapter, section, the sentence in progress and recent context.
- **[added]** Score = semantic similarity + lexical overlap + proximity to the reading position; the current
  passage and its neighbours are always candidates. "Summarize this section" takes the whole section.
- **[added]** Label each passage for the model: already heard, being read now, or later in the book.

Answers: grounded in the retrieved text; say so plainly when the book does not cover it; short spoken sentences;
no markdown, lists or visual references. Keep a short conversation history so "it" resolves, with the book as the
authority. **[added]** Stream the answer sentence by sentence so speech starts early. **[added]** Show and
optionally speak the source section and page.

## 9. Stack

React + TypeScript + Tailwind; FastAPI; PyMuPDF; Qdrant (server, or embedded with no server); SQLite.
LLM and embeddings: Gemini or OpenAI, chosen by environment variable. STT: Web Speech API, with Whisper/Gemini on
the server as fallback. TTS: browser first, server providers behind the same interface.
No fake functionality: where an external API is unavailable, provide a clean interface and a clearly marked local
implementation.

## 10. Screens

1. **[added] Start**: any key begins; first run asks about screen-reader use.
2. **Library**: books with progress, Continue reading, Start from beginning, Book information; upload with spoken
   progress; **[added]** open by number key or by saying "open" and the title.
3. **Player**: status, reading position, large Play/Pause and Ask buttons, transport, speed and volume steppers,
   quick actions, text being read with word highlight, microphone status, typed command box.
4. **Question and answer** (within the player): "Listening", "You asked", the answer, sources, Replay answer,
   Continue reading, Stay paused.
5. **Settings**: speed 0.75× to 2×, volume, voices, microphone mode, barge-in, auto-resume, resume point, follow-up
   window, answer length, verbosity, screen-reader mode, earcons, vibration, three high-contrast themes, text size
   to 200%, reduced motion.
6. **Help**: commands, shortcuts, what the sounds mean; readable aloud.
7. **Evaluation dashboard** (researchers).

## 11. Accessibility

Semantic HTML, landmarks, ARIA labels and live regions, skip link, focus management on navigation, visible focus,
AAA contrast, large targets, state never shown by colour alone, reduced motion, forced-colours support, charts with
table alternatives.

## 12. Data model, security

Tables: User, Book, Chapter, Section, DocumentChunk (with paragraph boundaries), ReadingSession, PlaybackState,
Conversation, ConversationMessage, Bookmark, Note, and evaluation tables. **[added]** Schema changes must upgrade an
existing database in place without changing chunk ids, so positions, bookmarks and notes survive. API keys only in backend environment variables; JWT auth
(silent guest account, optional registration); input validation; upload type, signature and size checks.

## 13. Evaluation mode

Within-subjects comparison of System A (traditional audiobook) and System B (this system), counterbalanced, with
tasks that require looking up a term defined elsewhere in the book. Log automatically: completion time,
interactions, time to answer, time to resume, **[added]** distance from the original place on resuming. Record
comprehension, NASA-TLX, SUS and satisfaction. Record how each participant normally reads; do not assume blind
users interact identically. Dashboard with comparisons, a table view, and CSV export.

## 14. Deliverables and order of work

Explain the architecture → backend → ingestion → Qdrant RAG → playback state → STT → TTS → frontend →
accessibility → error handling → sample textbook (Operating Systems: memory management, paging, virtual memory) →
automated tests of the full interrupt → ask → answer → resume flow, including every failure state → README with
setup, diagrams, design decisions, testing, demo script and evaluation method.
