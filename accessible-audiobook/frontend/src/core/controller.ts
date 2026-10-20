/**
 * The interaction state machine - the heart of the project.
 *
 *   PLAYING -> PAUSING -> CAPTURE_CONTEXT -> LISTENING -> TRANSCRIBING -> RETRIEVING
 *           -> GENERATING -> SPEAKING_ANSWER -> (FOLLOW_UP) -> RESUME_CONFIRMATION -> PLAYING
 *
 * with STT_FAILED / RAG_FAILED / LLM_FAILED / TTS_FAILED / NETWORK_ERROR as
 * recoverable error states that speak what went wrong and then return the
 * student to the book. It owns no UI: React subscribes to its state, and every
 * input (voice, keyboard, touch, typed text) arrives as the same Intent.
 */
import { ApiError, NetworkError, type Api, type Interpretation } from '../services/api'
import type { AskContext, BookDetail, Bookmark, ChapterContent, FindMatch, Note, QAIntent, Source } from '../types'
import type { EarconName, EarconPlayer } from './earcons'
import { isLikelyEcho, isProbablyEcho, ownWords, stripEcho } from './echo'
import { hasNonLatinWords, isCommand, needsInterpreting, parseIntent, type Intent, type Page } from './intents'
import { buildItems, Reader, type ReadItem } from './reader'
import { RATES, step, type Settings } from './settings'
import { describeSettings } from './settingsVoice'
import type { STTEngine, STTErrorCode } from './stt'
import { closest } from './text'
import type { SpeakOptions, TTSEngine } from './tts'

export type ErrorCode = 'STT_FAILED' | 'RAG_FAILED' | 'LLM_FAILED' | 'TTS_FAILED' | 'NETWORK_ERROR'
export type Phase =
  | 'LOADING' | 'IDLE' | 'PLAYING' | 'PAUSED' | 'PAUSING' | 'CAPTURE_CONTEXT' | 'LISTENING' | 'TRANSCRIBING'
  | 'RETRIEVING' | 'GENERATING' | 'SPEAKING_ANSWER' | 'FOLLOW_UP' | 'RESUME_CONFIRMATION' | 'FINISHED' | ErrorCode

/** Phases in which a question is being handled (the book is interrupted). */
const IN_FLOW = new Set<Phase>([
  'PAUSING', 'CAPTURE_CONTEXT', 'LISTENING', 'TRANSCRIBING', 'RETRIEVING', 'GENERATING', 'SPEAKING_ANSWER',
  'FOLLOW_UP', 'RESUME_CONFIRMATION', 'STT_FAILED', 'RAG_FAILED', 'LLM_FAILED', 'TTS_FAILED', 'NETWORK_ERROR',
])
/** Actions that mean "I am now looking for something" in the traditional-audiobook condition. */
const SEARCH_ACTIONS = new Set(['pause', 'toggle', 'seek', 'nav', 'gotoChapter', 'repeat', 'restartChapter'])
/**
 * Study tools that go beyond reading and asking questions. They are switched off during
 * evaluation trials, so that System A stays a traditional audiobook and System B stays
 * the one interaction the study measures: interrupt, ask, answer, resume.
 */
const STUDY_TOOLS = new Set<Intent['type']>(['note', 'readNotes', 'exportNotes', 'reviewQuestions', 'find', 'gotoSection',
  'gotoPage', 'contents', 'sections', 'return', 'skim', 'sleep'])

const LISTEN_TIMEOUT_MS = 9000
/** The one-word sentence that opens the description of a picture (written by the server when the book is added). */
const PICTURE_CUE = 'Picture.'
const HOLD_TIMEOUT_MS = 5000
/** Longest the language model may take over a spoken request before the grammar's own reading is used. */
/** Longest the narrator waits, after making way for a voice, to be told what was said. */
const VOICE_HOLD_TIMEOUT_MS = 30_000
/** This many pauses for "speech" that was not for the app, within the memory below, and the narrator stops pausing. */
const MAX_FALSE_STARTS = 2
const FALSE_START_MEMORY_MS = 120_000
const INTERPRET_TIMEOUT_MS = 3000
/** After this long without the first sentence of an answer, say that it is still coming. */
const SLOW_ANSWER_MS = 5000
/**
 * How far back the book's own words are compared with what the microphone hears. Longer than the
 * recogniser's lag: one transcript can span several sentences, and takes a while to be finalised.
 */
const ECHO_WINDOW_MS = 9000
/** Phases in which an answer is on its way and nothing has been spoken yet. */
const WAITING = new Set<Phase>(['PAUSING', 'CAPTURE_CONTEXT', 'TRANSCRIBING', 'RETRIEVING', 'GENERATING'])
/** How long after words are spoken the recogniser may still report them (its finalisation lag). */
const ECHO_LAG_MS = 2500
const AUTOSAVE_MS = 8000

export type InputSource = 'voice' | 'key' | 'touch' | 'typed'
type QARequest = { intent: QAIntent; question: string; term?: string; scope?: 'section' | 'chapter' }
type Captured = { ok: true; text: string } | { ok: false; reason: STTErrorCode | 'cancelled' | 'timeout' }
type SayResult = 'ended' | 'cancelled' | 'error'

export interface ControllerState {
  phase: Phase
  book: BookDetail | null
  loadError: string | null
  chapterIndex: number
  chapterTitle: string
  items: ReadItem[]
  index: number
  charOffset: number
  chapterProgress: number
  /** off: not listening - commands: listening for commands - question: listening for the question */
  mic: 'off' | 'commands' | 'question' | 'unavailable' | 'denied'
  /** The microphone cannot be used right now: the student types the question instead. */
  typedPrompt: boolean
  interim: string
  heard: string
  /** What was done with `heard` when it was not simply acted on ("ignored: that was the book itself"). */
  heardNote: string
  status: string
  question: string
  answer: string[]
  speakingSentence: number
  sources: Source[]
  grounded: boolean | null
  provider: string
  willResume: boolean
  error: { code: ErrorCode; message: string } | null
  history: { question: string; answer: string }[]
  bookmarks: Bookmark[]
  notes: Note[]
  /** What the microphone (or the typed box) is waiting for: a question, a note, a search, an answer. */
  listeningFor: string
  /** Reading only the first sentence of each paragraph. */
  skim: boolean
  /** There is an earlier place to go back to ("return to my place"). */
  canReturn: boolean
  /** Sleep timer: stop reading at this time (ms since epoch), or at the end of the section / chapter. */
  sleepUntil: number | null
  sleepAt: 'section' | 'chapter' | null
  /** Recent state-machine transitions, newest last (shown in the interaction trace). */
  trace: { phase: Phase; at: number }[]
}

export interface ControllerDeps {
  api: Pick<Api, 'getBook' | 'getChapter' | 'saveSession' | 'askStream' | 'quiz' | 'quizCheck' | 'bookmarks' | 'addBookmark'
    | 'notes' | 'addNote' | 'find'>
  tts: TTSEngine
  stt: STTEngine | null
  earcons: EarconPlayer
  settings: () => Settings
  updateSettings: (patch: Partial<Settings>) => void
  voice: (role: 'narrator' | 'assistant') => SpeakOptions
  /** Visual + screen-reader status channel. */
  announce: (text: string, urgent?: boolean) => void
  navigate?: (page: Page) => void
  /** The language model's reading of a request the built-in grammar did not recognise. Absent when offline. */
  /** `reading`: what the app itself has just been saying, so the model can tell a request from an echo. */
  interpret?: (utterance: string, state: string, bookTitle: string, reading?: string) => Promise<Interpretation>
  /** Save the study sheet (notes, bookmarks, questions) as a file on the user's device. */
  exportNotes?: () => Promise<void>
  /** Clock, replaceable in tests. */
  now?: () => number
  /** Evaluation event log. */
  log?: (type: string, data?: Record<string, unknown>) => void
  /**
   * assistant=false, voice=false is "System A", the traditional audiobook baseline.
   * studyTools (find, contents, notes, skim, sleep timer, return to my place) defaults to
   * the value of `assistant`; evaluation trials turn it off for both systems.
   */
  mode?: { assistant: boolean; voice: boolean; persist: boolean; studyTools?: boolean }
}

class FlowError extends Error {
  code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Status phrases said in almost every session; fetched in advance so a natural voice answers instantly. */
const COMMON_PHRASES = ['Paused.', 'Listening. Ask your question.', 'Listening.', 'Searching your textbook.', 'Searching.',
  'Continuing from where you stopped.', 'Continuing.', "I didn't catch that. Please say it again.", 'Note saved.',
  'Back at your place.']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A place in the book precise enough to come back to. */
interface Place {
  chapterIndex: number
  chunkId: number
  sentenceIndex: number
  charOffset: number
}

function describeDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours} hour${hours > 1 ? 's' : ''}${rest ? ` and ${rest} minutes` : ''}`
}

export class AudiobookController {
  private deps: ControllerDeps
  private mode: { assistant: boolean; voice: boolean; persist: boolean; studyTools: boolean }
  private reader: Reader
  private state: ControllerState
  private listeners = new Set<() => void>()

  /** Incremented whenever the user changes course; async steps compare against it to know they were superseded. */
  private flow = 0
  private interjection = 0
  private abort: AbortController | null = null
  private pending: { finish: (result: Captured) => void } | null = null
  private hold: ReturnType<typeof setTimeout> | null = null
  private chapters = new Map<number, ChapterContent>()
  private context: AskContext | null = null
  private conversationId: string | null = null
  private spoken: { text: string; until: number | null }[] = [] // until = null while still being spoken
  private now: () => number
  /** The narrator is paused because a voice was heard (not yet any words). */
  private heldForVoice = false
  /** When the narrator made way for a voice that turned out not to be for the app. */
  private falseStarts: number[] = []
  private lastSave = 0
  private searchOrigin: number | null = null
  private awaitingResumeLog = false
  private disposed = false
  /** How many assistant utterances are in progress (0 or 1): reading must not restart over one. */
  private activeSays = 0
  /** Places the listener jumped away from, most recent last ("return to my place"). */
  private returnStack: Place[] = []
  /** Where the last jump landed: further jumps from about there are browsing, not a new place to remember. */
  private landing: { chapterIndex: number; index: number } | null = null
  private hinted = new Set<string>()

  constructor(deps: ControllerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    const mode = deps.mode ?? { assistant: true, voice: true, persist: true }
    this.mode = { ...mode, studyTools: mode.studyTools ?? mode.assistant }
    this.reader = new Reader(deps.tts, () => deps.voice('narrator'), {
      onPosition: () => this.syncPosition(),
      onItemStart: (item) => this.onItemStart(item),
      onChapterEnd: () => void this.onChapterEnd(),
      onError: () => this.onNarrationError(),
      beforeItem: (next, previous) => this.mayReadOn(next, previous),
      onSkip: () => this.deps.earcons.play('tick'), // an audible "skipped ahead" while skimming
    })
    this.state = {
      phase: 'LOADING', book: null, loadError: null, chapterIndex: 0, chapterTitle: '', items: [], index: 0,
      charOffset: 0, chapterProgress: 0, mic: 'off', typedPrompt: false, interim: '', heard: '', heardNote: '', status: '',
      question: '', answer: [], speakingSentence: -1, sources: [], grounded: null, provider: '', willResume: false,
      error: null, history: [], bookmarks: [], notes: [], listeningFor: 'question', skim: false, canReturn: false,
      sleepUntil: null, sleepAt: null, trace: [],
    }
  }

  // --- state plumbing ------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): ControllerState => this.state

  private patch(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  private setPhase(phase: Phase): void {
    if (phase === this.state.phase) return
    this.patch({ phase, trace: [...this.state.trace.slice(-39), { phase, at: Date.now() }] })
  }

  private get phase(): Phase {
    return this.state.phase
  }

  private syncPosition(): void {
    if (!this.reader.playing) this.closeSpeech()
    this.patch({ index: this.reader.index, charOffset: this.reader.charOffset, chapterProgress: this.reader.progress })
  }

  private log(type: string, data?: Record<string, unknown>): void {
    this.deps.log?.(type, data)
  }

  // --- speech output -------------------------------------------------------

  /** Note that `text` is now being spoken aloud (it may come back through the microphone). */
  private remember(text: string): void {
    this.closeSpeech()
    this.spoken = [...this.spoken.slice(-5), { text, until: null }]
  }

  private closeSpeech(): void {
    const last = this.spoken[this.spoken.length - 1]
    if (last && last.until === null) last.until = this.now()
  }

  /**
   * What the microphone could be echoing right now: whatever is being spoken, plus
   * anything that finished within the recogniser's lag. Older speech is excluded on
   * purpose - a student may well ask "what is virtual memory?" moments after a
   * heading with those very words was read out.
   */
  private recentSpeech(withinMs = ECHO_LAG_MS): string {
    const cutoff = this.now() - withinMs
    return this.spoken.filter((s) => s.until === null || s.until > cutoff).map((s) => s.text).join(' ')
  }

  /** Speak in the assistant's voice. The narrator must already be paused. */
  private say(text: string): Promise<SayResult> {
    this.reader.pause()
    this.remember(text)
    return new Promise((resolve) => {
      let settled = false
      const done = (result: SayResult) => {
        if (settled) return
        settled = true
        this.activeSays--
        this.closeSpeech()
        resolve(result)
      }
      this.activeSays++
      this.deps.tts.speak(text, this.deps.voice('assistant'), {
        onEnd: () => done('ended'), onCancel: () => done('cancelled'), onError: () => done('error'),
      })
    })
  }

  /**
   * Speak a short aside without changing what the player is doing - used to voice the
   * button a keyboard user has just tabbed to, for people not running a screen reader.
   */
  async speakAside(text: string): Promise<void> {
    if (this.disposed || this.phase === 'LOADING' || IN_FLOW.has(this.phase)) return
    await this.interject(async () => { await this.say(text) })
  }

  /**
   * Tell the user what the system is doing. How much is said depends on the
   * verbosity preference; with a screen reader the message goes to the live
   * region only, so two voices never talk over each other.
   */
  private async feedback(full: string, brief = full, earcon?: EarconName): Promise<void> {
    const s = this.deps.settings()
    this.patch({ status: full })
    this.deps.announce(full)
    if (earcon) this.deps.earcons.play(earcon)
    if (s.screenReaderMode || s.verbosity === 'earcons') {
      if (earcon) await sleep(250) // let the tone be heard before anything else speaks
      return
    }
    await this.say(s.verbosity === 'brief' ? brief : full)
  }

  /** Information the user asked for, or an error: always delivered in words. */
  private async inform(text: string, urgent = false): Promise<void> {
    this.patch({ status: text })
    this.deps.announce(text, urgent)
    if (!this.deps.settings().screenReaderMode) await this.say(text)
  }

  private haptic(pattern: number | number[]): void {
    if (this.deps.settings().haptics && typeof navigator !== 'undefined') navigator.vibrate?.(pattern)
  }

  /** Say something while the book is playing, then carry on reading from the same word. */
  private async interject(body: () => Promise<void>): Promise<void> {
    const reading = this.phase === 'PLAYING'
    const flow = this.flow
    const mine = ++this.interjection
    if (reading) this.reader.pause()
    await body()
    if (reading && flow === this.flow && mine === this.interjection && this.phase === 'PLAYING') this.reader.play()
  }

  // --- loading and position ------------------------------------------------

  async load(bookId: string, start?: { chapterIndex: number; section?: string }): Promise<void> {
    try {
      const book = await this.deps.api.getBook(bookId)
      if (this.disposed) return
      if (book.status !== 'ready' || !book.chapters.length) {
        this.patch({ loadError: 'This book is not ready to read yet.' })
        return
      }
      this.patch({ book })
      const session = book.session
      await this.openChapter(start?.chapterIndex ?? session?.chapter_index ?? 0)
      if (start?.section) {
        const index = this.reader.items.findIndex((it) => it.kind === 'section' && it.text === start.section)
        this.reader.load(this.reader.items, Math.max(0, index))
      } else if (!start && session?.started && session.chunk_id !== null) {
        // Coming back to a book later, a sentence is picked up from its beginning: mid-sentence
        // is only the right place to restart seconds after an interruption, not days after.
        this.reader.load(this.reader.items, this.reader.indexOf(session.chunk_id, session.sentence_index))
      }
      if (this.mode.persist) {
        const [bookmarks, notes] = await Promise.all([
          this.deps.api.bookmarks(bookId).catch(() => []), this.deps.api.notes(bookId).catch(() => []),
        ])
        this.patch({ bookmarks, notes })
      }
      if (this.disposed) return
      this.setPhase(!start && session?.started ? 'PAUSED' : 'IDLE')
      for (const phrase of COMMON_PHRASES) this.deps.tts.prefetch?.(phrase, 'assistant')
      this.startCommandListening()
    } catch (error) {
      this.patch({ loadError: error instanceof NetworkError ? 'The server could not be reached.' : 'This book could not be opened.' })
    }
  }

  /** Spoken orientation when a book is opened without starting to read straight away. */
  async announceReady(): Promise<void> {
    const book = this.state.book
    if (this.disposed || !book || this.phase === 'PLAYING') return
    const where = this.phase === 'PAUSED' ? 'Paused in' : 'Ready at'
    await this.feedback(`${book.title}. ${where} ${this.state.chapterTitle}. Press Space, or say "start reading".`, book.title)
  }

  /**
   * Start reading when a book is opened. When returning to a book part-way through, first
   * say where we are, so the listener is not dropped into the middle of a chapter unannounced.
   */
  async begin(): Promise<void> {
    const item = this.reader.current
    if (this.disposed || !item) return
    if (this.phase === 'PAUSED' && this.reader.index > 0) {
      const flow = this.flow
      const place = [this.state.chapterTitle, item.sectionTitle].filter(Boolean).join('. ')
      await this.feedback(`Continuing ${this.state.book!.title}. ${place}.`, item.sectionTitle || this.state.chapterTitle)
      if (flow !== this.flow || this.phase !== 'PAUSED') return // the listener already did something else
    }
    this.play()
  }

  private async openChapter(index: number, at: 'start' | 'end' = 'start'): Promise<void> {
    const book = this.state.book!
    let content = this.chapters.get(index)
    if (!content) {
      content = await this.deps.api.getChapter(book.id, index)
      this.chapters.set(index, content)
    }
    const items = buildItems(content)
    this.patch({ chapterIndex: index, chapterTitle: content.title, items })
    this.reader.load(items, at === 'end' ? items.length - 1 : 0)
  }

  /** Sentence count from the start of the book: used to measure how far a listener ends up from their place. */
  private ordinal(): number {
    let total = 0
    for (const chapter of this.state.book?.chapters ?? []) {
      if (chapter.index >= this.state.chapterIndex) break
      const cached = this.chapters.get(chapter.index)
      total += cached ? buildItems(cached).length : Math.round(chapter.char_count / 85)
    }
    return total + this.reader.index
  }

  private savePosition(reason: 'autosave' | 'interrupt' | 'manual', status: 'playing' | 'paused' | 'interrupted' | 'finished', keepalive = false): void {
    const item = this.reader.current
    const book = this.state.book
    if (!this.mode.persist || !item || !book) return
    this.lastSave = Date.now()
    void this.deps.api.saveSession(book.id, {
      chunk_id: item.chunkId,
      sentence_index: item.sentenceIndex,
      character_offset: item.kind === 'sentence' ? this.reader.charOffset : 0,
      audio_time: Math.round(this.reader.audioTime * 10) / 10,
      playback_speed: this.deps.settings().rate,
      status, reason,
    }, keepalive).catch(() => undefined) // the next save will retry; never interrupt listening for this
  }

  private onItemStart(item: ReadItem): void {
    this.remember(item.text)
    // A chime where a sighted reader's eye would be caught by a picture: what follows describes it.
    if (item.paragraphStart && item.text === PICTURE_CUE) this.deps.earcons.play('bookmark')
    if (Date.now() - this.lastSave > AUTOSAVE_MS) this.savePosition('autosave', 'playing')
  }

  private async onChapterEnd(): Promise<void> {
    const book = this.state.book!
    const next = this.state.chapterIndex + 1
    if (next < book.chapters.length) {
      // The end of a chapter is also the end of its last section, so either "stop at the end of ..." applies.
      const asleep = this.state.sleepAt !== null || this.sleepIsDue()
      this.deps.earcons.play('chapter')
      try {
        await this.openChapter(next)
      } catch {
        return this.narrationStopped('NETWORK_ERROR', 'I could not load the next chapter. Check your connection, then press Space to try again.')
      }
      if (asleep) return this.fallAsleep()
      if (this.phase === 'PLAYING') this.reader.play()
      return
    }
    this.patch({ sleepUntil: null, sleepAt: null })
    this.setPhase('FINISHED')
    this.savePosition('manual', 'finished')
    await this.inform('You have reached the end of the book.')
  }

  // --- sleep timer ---------------------------------------------------------

  private sleepIsDue(): boolean {
    return this.state.sleepUntil !== null && this.now() >= this.state.sleepUntil
  }

  /** Asked by the narrator between sentences: is it time to stop for the sleep timer? */
  private mayReadOn(next: ReadItem, previous: ReadItem): boolean {
    const endOfSection = this.state.sleepAt === 'section' && next.sectionIndex !== previous.sectionIndex
    if (!endOfSection && !this.sleepIsDue()) return true
    setTimeout(() => void this.fallAsleep(), 0) // after the narrator has settled on the next sentence
    return false
  }

  /** The sleep timer ran out: stop between sentences, with the place saved. */
  private async fallAsleep(): Promise<void> {
    this.patch({ sleepUntil: null, sleepAt: null })
    if (this.phase !== 'PLAYING') return
    this.setPhase('PAUSED')
    this.savePosition('manual', 'paused')
    await this.feedback('Sleep timer. Paused. Your place is saved.', 'Sleep timer. Paused.', 'pause')
  }

  private async setSleep(intent: Extract<Intent, { type: 'sleep' }>, quiet: boolean): Promise<void> {
    let message: string
    if (intent.off) {
      message = this.state.sleepUntil !== null || this.state.sleepAt ? 'Sleep timer off.' : 'There is no sleep timer set.'
      this.patch({ sleepUntil: null, sleepAt: null })
    } else if (intent.at) {
      this.patch({ sleepUntil: null, sleepAt: intent.at })
      message = `I will stop at the end of this ${intent.at}.`
    } else {
      const seconds = Math.min(Math.max(intent.seconds ?? 900, 10), 6 * 3600)
      this.patch({ sleepAt: null, sleepUntil: this.now() + seconds * 1000 })
      message = `Sleep timer set for ${describeDuration(seconds)}.`
    }
    if (quiet) {
      this.deps.earcons.play('tick')
      this.deps.announce(message)
      return
    }
    await this.interject(() => this.feedback(message, message, 'tick'))
  }

  /** The sleep-timer button: off, 15, 30 and 60 minutes, end of this chapter, off again. */
  cycleSleep(source: InputSource): Promise<void> {
    const { sleepUntil, sleepAt } = this.state
    const left = sleepUntil === null ? 0 : (sleepUntil - this.now()) / 1000
    const next: Omit<Extract<Intent, { type: 'sleep' }>, 'type'> = sleepAt ? { off: true }
      : sleepUntil === null ? { seconds: 900 } : left <= 900 ? { seconds: 1800 } : left <= 1800 ? { seconds: 3600 } : { at: 'chapter' }
    return this.command({ type: 'sleep', ...next }, source)
  }

  private onNarrationError(): void {
    this.narrationStopped('TTS_FAILED', 'The reading voice stopped working. Press Space to try again.')
  }

  private narrationStopped(code: ErrorCode, message: string): void {
    this.setPhase(code)
    this.patch({ error: { code, message }, status: message })
    this.deps.earcons.play('error')
    this.deps.announce(message, true)
    this.log('error', { code })
    this.setPhase('PAUSED')
  }

  // --- microphone ----------------------------------------------------------

  private canListenContinuously(): boolean {
    const stt = this.deps.stt
    return !!stt && stt.continuous && this.mode.voice && this.deps.settings().micMode === 'always' && this.state.mic !== 'denied'
  }

  /** (Re)start or stop the always-on command listener to match the current settings. */
  startCommandListening(): void {
    if (this.disposed) return
    if (!this.deps.stt || !this.mode.voice) {
      this.patch({ mic: 'unavailable' })
      return
    }
    if (this.state.mic === 'denied') return
    if (!this.canListenContinuously()) {
      if (!this.pending) this.deps.stt.stop()
      this.patch({ mic: 'off' })
      return
    }
    this.deps.stt.start('continuous', {
      onInterim: (text) => this.onInterim(text),
      onFinal: (text, alternatives) => this.onFinal(text, alternatives),
      onSpeechStart: () => this.onSpeechStart(),
      onDismissed: () => this.onDismissed(),
      onError: (code) => this.onMicError(code),
    })
    this.patch({ mic: this.pending ? 'question' : 'commands' })
  }

  /**
   * Barge-in for a listener that hears the voice itself (echo-cancelled microphone + Whisper):
   * someone has started speaking, so the narrator makes way at once - before a single word is
   * known - and waits for what was said.
   */
  private onSpeechStart(): void {
    if (this.pending) {
      this.patch({ interim: 'Hearing you…' })
      return
    }
    if (this.phase !== 'PLAYING' || !this.deps.settings().bargeIn || this.hold || !this.reader.playing) return
    // If the microphone keeps "hearing speech" that turns out to be the book or a noise, the
    // narrator stops making way for it. Commands are still heard; they just do not pause it first.
    const recent = this.falseStarts.filter((at) => this.now() - at < FALSE_START_MEMORY_MS)
    this.falseStarts = recent
    if (recent.length >= MAX_FALSE_STARTS) return
    this.reader.pause()
    this.patch({ interim: 'Hearing you…' })
    this.heldForVoice = true
    // The engine always follows up with what was said, or with "nothing"; this is only a safety net.
    this.hold = setTimeout(() => this.resumeHeld(), VOICE_HOLD_TIMEOUT_MS)
  }

  /** What sounded like speech was not: carry on reading, and remember that it happened. */
  private onDismissed(): void {
    if (this.pending) {
      this.patch({ interim: '' })
      return
    }
    if (this.heldForVoice) this.falseStarts.push(this.now())
    if (this.hold) this.resumeHeld()
  }

  private onMicError(code: STTErrorCode): void {
    if (code === 'not-allowed') {
      this.patch({ mic: 'denied' })
      this.deps.announce('The microphone is blocked. You can still use the keyboard, and type your questions.', true)
    } else {
      this.patch({ mic: 'off' })
      this.deps.announce('Voice commands have stopped. Press M to turn the microphone back on.', true)
    }
    this.pending?.finish({ ok: false, reason: code })
  }

  /** M key / microphone button: switch between always listening and push-to-ask. */
  async toggleMic(): Promise<void> {
    if (!this.deps.stt || !this.mode.voice) return
    const on = this.state.mic === 'commands' || this.state.mic === 'question'
    this.deps.updateSettings({ micMode: on ? 'push' : 'always' })
    if (this.state.mic === 'denied') this.patch({ mic: 'off' }) // the user may have unblocked it; try again
    this.startCommandListening()
    await this.interject(() => this.feedback(
      on ? 'Microphone off. Press A when you want to ask a question.' : 'Microphone on. I am listening for commands.',
      on ? 'Microphone off.' : 'Microphone on.', 'tick'))
  }

  private releaseHold(): boolean {
    if (!this.hold) return false
    clearTimeout(this.hold)
    this.hold = null
    return true
  }

  private resumeHeld(): void {
    this.releaseHold()
    this.heldForVoice = false
    this.patch({ interim: '' })
    if (this.phase === 'PLAYING' && !this.reader.playing) this.reader.play()
  }

  /** Barge-in: the moment the student starts talking, stop the narrator so they are not talked over. */
  private onInterim(text: string): void {
    if (this.pending) {
      this.patch({ interim: text })
      return
    }
    const s = this.deps.settings()
    if (this.phase !== 'PLAYING' || !s.bargeIn || this.hold || !this.reader.playing) return
    // Through loudspeakers the microphone hears the book. Only words it is not saying right now stop it
    // (a first few words are too little to compare with anything said earlier) - or a command
    // spoken over it, which arrives in among the book's own words.
    const recent = this.recentSpeech()
    const added = ownWords(text, recent)
    const spokenOver = !!added && isCommand(parseIntent(added))
    if (!spokenOver && (text.split(/\s+/).length < 2 || isProbablyEcho(text, recent))) return
    this.reader.pause()
    this.patch({ interim: text })
    // If it turns out not to be a command or a question, pick up again from the same word.
    this.hold = setTimeout(() => this.resumeHeld(), HOLD_TIMEOUT_MS)
  }

  private onFinal(raw: string, alternatives: string[] = []): void {
    if (this.pending) {
      // The recogniser can still deliver the tail of our own prompt ("Listening..."). Only speech that
      // recent counts: a short answer may well reuse the words of the question it was asked.
      if (isLikelyEcho(raw, this.recentSpeech())) return
      this.patch({ heard: raw, heardNote: '', interim: '' })
      this.pending.finish({ ok: true, text: raw })
      return
    }
    const held = this.releaseHold()
    const madeWay = this.heldForVoice
    this.heldForVoice = false
    const ignore = (why: string) => {
      this.patch({ heard: raw, heardNote: why, interim: '' })
      // The narrator stopped for this and it was not for us (most often: it was the book itself).
      if (madeWay) this.falseStarts.push(this.now())
      if (held) this.resumeHeld()
    }
    const spoken = this.recentSpeech(ECHO_WINDOW_MS)
    // A definite command wins, wherever it is found: in the recogniser's first guess or one of its
    // others ("paws" / "pause"), on its own or spoken over the narrator and so buried in the book's
    // words ("than is physically pause available"). Commands are short and easily lost; this is
    // where most "it did not hear me" comes from.
    for (const guess of [raw, ...alternatives]) {
      for (const candidate of [guess, ownWords(guess, spoken)]) {
        const command = candidate ? parseIntent(candidate) : null
        if (command && isCommand(command)) {
          this.patch({ heard: candidate, heardNote: '', interim: '' })
          void this.command(command, 'voice')
          return
        }
      }
    }
    let text = raw
    let intent = parseIntent(raw)
    if (!isCommand(intent) && intent.type !== 'qa') {
      // Neither a command nor a question as it stands. The recogniser often glues the narrator's
      // last words onto the front of what the student says: look at what is left without them.
      const own = stripEcho(raw, spoken)
      if (own !== raw) [text, intent] = [own, parseIntent(own)]
    }
    const exact = isCommand(intent)
    // A question may well reuse words the book has just used ("what is virtual memory?" straight
    // after that heading), so it is an echo only if whole runs of words match what is being said
    // right now. Anything vaguer is an echo if most of it is the book's own recent words.
    const echo = !exact && (intent.type === 'qa'
      ? isLikelyEcho(text, this.recentSpeech())
      : isLikelyEcho(text, spoken) || isProbablyEcho(text, spoken))
    if (echo) return ignore('ignored: that was the book itself')

    // While an answer is being fetched, only a definite command may interrupt: stray words, a
    // cough, or the rest of the question arriving late must not cancel the answer on its way.
    const waiting = WAITING.has(this.phase)
    if (waiting && !exact) return ignore('ignored: still getting your answer. Say "cancel" to stop.')

    // A phrase the grammar does not know, or only guessed at from a key word, is put to the language
    // model: it understands indirect requests, Indian English, Hindi and Hinglish. One stray word of
    // English is more likely noise than a request; one word of Hindi ("रुको") is a command.
    const worthAsking = text.trim().split(/\s+/).length >= 2 || hasNonLatinWords(text)
    if (needsInterpreting(intent) && this.deps.interpret && worthAsking && !IN_FLOW.has(this.phase)) {
      this.patch({ heard: text, heardNote: 'working out what you meant', interim: '' })
      void this.converse(text, intent.type === 'unknown' ? null : intent, 'voice', spoken)
      return
    }
    if (intent.type === 'unknown') {
      // Heard, but not understood: a quiet tone says so, so silence never means "the microphone is dead".
      if (worthAsking) this.deps.earcons.play('unknown')
      return ignore('not a command I know. Say "help" to hear what you can say.')
    }
    this.patch({ heard: text, heardNote: '', interim: '' })
    void this.command(intent, 'voice')
  }

  /**
   * Conversational fallback: the words matched no command, so ask the language
   * model what was meant. While it thinks, the narrator stays as it was (paused
   * if barge-in had stopped it), and carries on if the words were not for us.
   */
  private async converse(text: string, fallback: Intent | null = null, source: InputSource = 'voice', reading = ''): Promise<void> {
    const flow = this.flow
    const unavailable: Interpretation = { kind: 'ignore', failed: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    const meaning = await Promise.race([
      this.deps.interpret!(text, this.phase, this.state.book?.title ?? '', reading).catch(() => unavailable),
      new Promise<Interpretation>((resolve) => { timer = setTimeout(() => resolve(unavailable), INTERPRET_TIMEOUT_MS) }),
    ])
    clearTimeout(timer)
    if (flow !== this.flow || this.disposed) return
    this.patch({ heardNote: '' })
    if (meaning.kind === 'question') return this.command({ type: 'qa', intent: 'question', question: meaning.question }, source)
    if (meaning.kind === 'reply') return this.command({ type: 'reply', text: meaning.text }, source)
    const intent = meaning.kind === 'command' ? parseIntent(meaning.command) : null
    if (intent && intent.type !== 'unknown') return this.command(intent, source)
    // The model could not be reached: the grammar's own key-word reading still stands, so a slow
    // network never costs the listener a command that used to work. Typed words are always for us.
    const modelFailed = meaning.kind === 'ignore' && meaning.failed === true
    if (fallback && (modelFailed || source === 'typed')) return this.command(fallback, source)
    // The model judged the words were not meant for the app (talk in the room, or the book heard
    // through the microphone). A key word inside them - "wait", "stop", "back" - must not then act.
    this.patch({ heardNote: 'ignored: not meant for me' })
    this.resumeHeld()
  }

  /** Wait for one utterance (or one typed line). */
  private capture(timeoutMs: number | null): Promise<Captured> {
    return new Promise((resolve) => {
      const stt = this.deps.stt
      const usable = !!stt && this.mode.voice && this.state.mic !== 'denied'
      const continuous = usable && this.canListenContinuously()
      let timer: ReturnType<typeof setTimeout> | null = null
      const entry = {
        finish: (result: Captured) => {
          if (this.pending !== entry) return
          this.pending = null
          if (timer) clearTimeout(timer)
          if (usable && !continuous) stt.stop()
          this.patch({ typedPrompt: false, interim: '', mic: continuous ? 'commands' : this.state.mic === 'question' ? 'off' : this.state.mic })
          resolve(result)
        },
      }
      this.pending = entry
      if (!usable) {
        this.patch({ typedPrompt: true }) // no time limit: typing takes as long as it takes
        return
      }
      if (timeoutMs !== null) timer = setTimeout(() => entry.finish({ ok: false, reason: 'timeout' }), timeoutMs)
      this.patch({ mic: 'question' })
      if (!continuous) {
        stt.start('single', {
          onInterim: (text) => this.patch({ interim: text }),
          onFinal: (text) => { this.patch({ heard: text }); entry.finish({ ok: true, text }) },
          onProcessing: () => { if (this.phase === 'LISTENING') this.setPhase('TRANSCRIBING') },
          onError: (code) => {
            if (code === 'not-allowed') this.patch({ mic: 'denied' })
            entry.finish({ ok: false, reason: code })
          },
        })
      }
    })
  }

  // --- input ---------------------------------------------------------------

  /** Text typed into the command box: a command, the awaited question, or a new question. */
  submitText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (this.pending) {
      this.patch({ heard: trimmed })
      this.pending.finish({ ok: true, text: trimmed })
      return
    }
    const intent = parseIntent(trimmed)
    // Typed words are certainly meant for the app: if nothing else makes sense of them, they are a question.
    const reading: Intent = intent.type === 'unknown' ? { type: 'qa', intent: 'question', question: trimmed } : intent
    if (needsInterpreting(intent) && this.deps.interpret) void this.converse(trimmed, reading, 'typed')
    else void this.command(reading, 'typed')
  }

  /** Space bar / the big button. */
  toggle(source: InputSource): void {
    this.noteInteraction(source, 'toggle')
    if (this.phase === 'PLAYING' || IN_FLOW.has(this.phase)) void this.pause()
    else this.play()
  }

  /** The single entry point for every action, whichever way it was triggered. */
  async command(intent: Intent, source: InputSource): Promise<void> {
    if (this.phase === 'LOADING' || !this.state.book) return
    this.noteInteraction(source, intent.type)
    // Barge-in may have silenced the narrator before the command was understood. If the
    // command does not itself pause or restart reading, the book must be picked up again -
    // but never while the assistant is in the middle of saying something.
    const silenced = () => this.phase === 'PLAYING' && !this.reader.playing && !this.hold && this.activeSays === 0
    const wasSilenced = silenced()
    await this.dispatch(intent)
    if (wasSilenced && silenced() && !this.disposed) this.reader.play()
  }

  private async dispatch(intent: Intent): Promise<void> {
    const busy = IN_FLOW.has(this.phase)
    if (!this.mode.studyTools && STUDY_TOOLS.has(intent.type)) {
      this.deps.earcons.play('unknown')
      this.deps.announce('That is not available in this mode.')
      return
    }
    switch (intent.type) {
      case 'sleep':
        return this.setSleep(intent, busy)
      case 'setting':
        return this.applySetting(intent.patch, intent.say, busy)
      case 'goto':
        this.savePosition('manual', 'paused')
        return this.deps.navigate?.(intent.page)
      case 'play':
      case 'resume':
      case 'yes':
        return busy ? this.continueReading() : this.play()
      case 'no':
        return busy ? this.continueReading() : undefined
      case 'pause':
        return this.pause()
      case 'stop':
        return this.stop()
      case 'cancel':
        return busy ? this.cancelQuestion() : undefined
      case 'stayPaused':
        return this.stayPaused()
      case 'ask':
        return this.interrupt()
      case 'qa':
        return this.interrupt(intent)
      case 'quiz':
        return this.quiz()
      case 'replayAnswer':
        return this.replayAnswer()
      case 'repeat':
        if (busy) return this.replayAnswer()
        this.reader.repeat()
        if (this.phase !== 'PLAYING') this.play() // asking to hear it again implies wanting to hear it
        return
      case 'speed':
        return this.changeSpeed(intent, busy)
      case 'volume':
        return this.changeVolume(intent.change, busy)
    }
    if (busy) {
      this.deps.earcons.play('unknown') // navigation is not available in the middle of a question
      return
    }
    switch (intent.type) {
      case 'seek':
        return this.seek(intent.seconds)
      case 'nav':
        return this.navigate(intent.unit, intent.delta)
      case 'gotoChapter':
        return this.gotoChapter(intent.number - 1)
      case 'restartChapter':
        return this.gotoChapter(this.state.chapterIndex)
      case 'where':
        return this.interject(() => this.inform(this.describePosition()))
      case 'help':
        return this.interject(() => this.inform(this.helpText()))
      case 'bookmark':
        return this.addBookmark()
      case 'gotoBookmark':
        return this.gotoBookmark(this.state.bookmarks[this.state.bookmarks.length - 1])
      case 'listBookmarks':
        return this.interject(() => this.inform(this.describeBookmarks()))
      case 'spell':
        return this.interject(() => this.inform(intent.term
          ? `${intent.term}: ${intent.term.replace(/\s+/g, ' ').split('').map((c) => (c === ' ' ? 'space' : c.toUpperCase())).join(', ')}.`
          : 'Say spell, followed by the word you want spelled.'))
      case 'library':
        this.savePosition('manual', 'paused')
        return this.deps.navigate?.('library')
      case 'describeSettings':
        return this.interject(() => this.inform(describeSettings(this.deps.settings())))
      case 'reply':
        return this.interject(() => this.inform(intent.text))
      case 'contents':
        return this.interject(() => this.inform(this.describeContents()))
      case 'sections':
        return this.interject(() => this.inform(this.describeSections()))
      case 'gotoSection':
        return this.gotoSection(intent.name, intent.unit)
      case 'gotoPage':
        return this.gotoPage(intent.page)
      case 'find':
        return this.find(intent.query)
      case 'return':
        return this.returnToPlace()
      case 'skim':
        return this.setSkim(intent.on)
      case 'note':
        return this.takeNote(intent.text)
      case 'readNotes':
        return this.interject(() => this.inform(this.describeNotes()))
      case 'reviewQuestions':
        return this.interject(() => this.inform(this.describeQuestions()))
      case 'exportNotes':
        return this.exportNotes()
      case 'unknown':
        this.deps.earcons.play('unknown')
    }
  }

  private noteInteraction(source: InputSource, action: string): void {
    this.log('interaction', { kind: source, action })
    // In the baseline condition, the first time the listener breaks off from reading is the start of their search.
    const breaksOff = this.phase === 'PLAYING' && SEARCH_ACTIONS.has(action)
    if (!this.mode.assistant && this.searchOrigin === null && breaksOff) this.beginSearch()
  }

  private beginSearch(): void {
    this.searchOrigin = this.ordinal()
    this.log('search_start', { chapter: this.state.chapterIndex, index: this.reader.index })
  }

  /** Evaluation, System A: the researcher marks the moment the participant found the answer. */
  markAnswerFound(): void {
    this.log('answer_found')
    this.awaitingResumeLog = true
    if (this.phase === 'PLAYING') this.logResumed()
  }

  private logResumed(): void {
    if (!this.awaitingResumeLog) return
    this.awaitingResumeLog = false
    this.log('resumed', { offset_sentences: this.searchOrigin === null ? 0 : Math.abs(this.ordinal() - this.searchOrigin) })
    this.searchOrigin = null
  }

  // --- transport -----------------------------------------------------------

  /** Stop whatever question handling is in progress. Call reader.pause() first to keep the exact position. */
  private abortFlow(): void {
    this.flow++
    this.abort?.abort()
    this.abort = null
    this.deps.earcons.stopThinking()
    this.releaseHold()
    this.pending?.finish({ ok: false, reason: 'cancelled' })
    this.deps.tts.cancel()
  }

  play(): void {
    if (this.disposed || !this.reader.items.length) return
    this.reader.pause()
    this.abortFlow()
    if (this.phase === 'FINISHED') this.reader.seekTo(0)
    // A sleep timer that ran out while the listener was busy with something else no longer applies.
    if (this.sleepIsDue()) this.patch({ sleepUntil: null })
    this.patch({ status: 'Reading.', error: null, interim: '' })
    this.setPhase('PLAYING')
    this.reader.play()
    this.logResumed()
  }

  async pause(): Promise<void> {
    if (this.phase === 'PAUSED' || this.phase === 'IDLE' || this.phase === 'FINISHED') return
    this.reader.pause()
    this.abortFlow()
    this.setPhase('PAUSED')
    this.savePosition('manual', 'paused')
    await this.feedback('Paused.', 'Paused.', 'pause')
  }

  private async stop(): Promise<void> {
    this.reader.pause()
    this.abortFlow()
    this.setPhase('IDLE')
    this.savePosition('manual', 'paused')
    await this.feedback('Stopped. Your place is saved.', 'Stopped.', 'pause')
  }

  private async seek(seconds: number): Promise<void> {
    const result = this.reader.seekSeconds(seconds, this.deps.settings().rate)
    this.deps.earcons.play('tick')
    const amount = Math.abs(seconds) >= 60 ? `${Math.round(Math.abs(seconds) / 6) / 10} minutes` : `${Math.abs(seconds)} seconds`
    const message = result === 'start' ? 'Start of the chapter.' : result === 'end' ? 'End of the chapter.'
      : `${seconds < 0 ? 'Back' : 'Forward'} ${amount}.`
    if (this.phase === 'PLAYING' && result === 'ok') {
      this.patch({ status: message }) // the jump itself is audible; no need to talk over the book
      this.deps.announce(message)
    } else {
      await this.interject(() => this.feedback(message))
    }
  }

  private async navigate(unit: 'sentence' | 'paragraph' | 'section' | 'chapter', delta: -1 | 0 | 1): Promise<void> {
    if (unit === 'chapter') return this.gotoChapter(this.state.chapterIndex + delta)
    this.deps.earcons.play('tick')
    if (unit === 'section' && delta !== 0) this.rememberPlace() // leaving the section is a jump worth undoing
    const moved = unit === 'sentence' ? this.reader.stepSentence(delta as -1 | 1) : this.reader.stepUnit(unit, delta)
    if (moved) {
      if (unit === 'section') this.landed()
      // While paused nothing is heard, so say where the jump landed.
      const item = this.reader.current
      if (this.phase !== 'PLAYING' && unit !== 'sentence' && item) await this.feedback(item.sectionTitle || this.state.chapterTitle)
      return
    }
    // Ran off this chapter: continue into the neighbouring one.
    await this.gotoChapter(this.state.chapterIndex + (delta || 1), delta < 0 ? 'end' : 'start')
  }

  private async gotoChapter(index: number, at: 'start' | 'end' = 'start'): Promise<void> {
    const book = this.state.book!
    if (index < 0 || index >= book.chapters.length) {
      return this.interject(() => this.inform(index < 0 ? 'This is the first chapter.' : `There is no chapter ${index + 1}. This book has ${book.chapters.length} chapters.`))
    }
    const reading = this.phase === 'PLAYING'
    this.reader.pause()
    this.abortFlow()
    this.rememberPlace()
    try {
      await this.openChapter(index, at)
    } catch {
      return this.narrationStopped('NETWORK_ERROR', 'I could not load that chapter. Check your connection and try again.')
    }
    this.landed()
    this.deps.earcons.play('chapter')
    if (reading) this.reader.play() // the chapter title is the first thing read
    else {
      if (this.phase === 'FINISHED') this.setPhase('PAUSED')
      await this.feedback(this.state.chapterTitle)
    }
  }

  // --- jumping around, and coming back --------------------------------------

  private here(): Place | null {
    const item = this.reader.current
    return item ? {
      chapterIndex: this.state.chapterIndex, chunkId: item.chunkId, sentenceIndex: item.sentenceIndex,
      charOffset: item.kind === 'sentence' ? this.reader.charOffset : 0,
    } : null
  }

  /**
   * Before a jump: keep the place being left, so "return to my place" can undo it.
   * A run of jumps (browsing through sections) keeps only the place the listener
   * originally left - that is the one they mean by "my place".
   */
  private rememberPlace(): void {
    const place = this.here()
    if (!place || !this.mode.studyTools) return
    const browsing = this.landing !== null && this.landing.chapterIndex === this.state.chapterIndex
      && Math.abs(this.reader.index - this.landing.index) <= 2
    if (browsing) return
    this.returnStack = [...this.returnStack.slice(-9), place]
    this.patch({ canReturn: true })
  }

  private landed(): void {
    this.landing = { chapterIndex: this.state.chapterIndex, index: this.reader.index }
  }

  /**
   * Move to another place in the book: remember where the listener was, say where
   * they have landed, and carry on reading if the book was playing.
   */
  private async jump(chapterIndex: number, locate: () => number, options: {
    say?: string | (() => string); brief?: string; earcon?: EarconName; remember?: boolean; charOffset?: number
  } = {}): Promise<boolean> {
    const reading = this.phase === 'PLAYING'
    this.reader.pause()
    this.abortFlow()
    if (options.remember !== false) this.rememberPlace()
    try {
      if (chapterIndex !== this.state.chapterIndex) await this.openChapter(chapterIndex)
    } catch {
      this.narrationStopped('NETWORK_ERROR', 'I could not load that part of the book. Check your connection and try again.')
      return false
    }
    this.reader.seekTo(locate(), options.charOffset ?? 0)
    this.landed()
    this.deps.earcons.play(options.earcon ?? 'tick')
    if (this.phase === 'FINISHED') this.setPhase('PAUSED')
    const flow = this.flow
    const mine = ++this.interjection
    const say = typeof options.say === 'function' ? options.say() : options.say
    if (say) await this.feedback(say, options.brief ?? say)
    if (reading && flow === this.flow && mine === this.interjection && this.phase === 'PLAYING') this.reader.play()
    return true
  }

  private async returnToPlace(): Promise<void> {
    const place = this.returnStack[this.returnStack.length - 1]
    if (!place) {
      return this.interject(() => this.inform('There is no earlier place to go back to. I remember your place whenever you jump to another part of the book.'))
    }
    this.returnStack = this.returnStack.slice(0, -1)
    this.patch({ canReturn: this.returnStack.length > 0 })
    await this.jump(place.chapterIndex, () => this.reader.indexOf(place.chunkId, place.sentenceIndex), {
      charOffset: place.charOffset, say: 'Back at your place.', brief: 'Back.', earcon: 'resume', remember: false,
    })
    this.landing = null // this is the listener's own place again, not somewhere they are browsing
  }

  /** A heading chosen from the table of contents on screen. `section` null means the start of the chapter. */
  async gotoHeading(chapterIndex: number, section: string | null, source: InputSource): Promise<void> {
    if (this.phase === 'LOADING' || IN_FLOW.has(this.phase) || !this.mode.studyTools) return
    this.noteInteraction(source, 'gotoSection')
    await this.toHeading(chapterIndex, section)
  }

  private async toHeading(chapterIndex: number, section: string | null): Promise<void> {
    const reading = this.phase === 'PLAYING'
    const title = section ?? this.state.book!.chapters[chapterIndex]?.title ?? ''
    await this.jump(chapterIndex, () => (section === null ? 0
      : Math.max(0, this.reader.items.findIndex((it) => it.kind === 'section' && it.text === section))),
    { say: reading ? undefined : title, earcon: 'chapter' }) // when reading, the narrator reads the heading itself
  }

  /** "Go to the section on page faults": a heading by name or, if no heading matches, wherever the book covers it. */
  private async gotoSection(name: string, unit: 'section' | 'chapter' = 'section'): Promise<void> {
    const book = this.state.book!
    // Sections of the chapter being read come first, so a common title ("Summary") means the nearest one.
    const ordered = [...book.chapters].sort((a, b) => Number(b.index === this.state.chapterIndex) - Number(a.index === this.state.chapterIndex))
    const sections = ordered.flatMap((c) => c.sections.filter((s) => s.title).map((s) => ({ chapterIndex: c.index, section: s.title as string | null, title: s.title })))
    const chapters = book.chapters.map((c) => ({ chapterIndex: c.index, section: null as string | null, title: c.title.replace(/^chapter \w+[:.]?\s*/i, '') }))
    const target = closest(name, unit === 'chapter' ? [...chapters, ...sections] : [...sections, ...chapters], (option) => option.title)
    if (!target) return this.find(name)
    return this.toHeading(target.chapterIndex, target.section)
  }

  private async gotoPage(page: number): Promise<void> {
    const book = this.state.book!
    if (!book.total_pages) {
      return this.interject(() => this.inform('This book has no page numbers. Try "go to chapter 2", or say "find", then a topic.'))
    }
    if (page < 1 || page > book.total_pages) {
      return this.interject(() => this.inform(`This book has pages 1 to ${book.total_pages}.`))
    }
    const chapter = [...book.chapters].reverse().find((c) => c.start_page <= page) ?? book.chapters[0]
    await this.jump(chapter.index, () => {
      const index = this.reader.items.findIndex((it) => it.kind === 'sentence' && it.page >= page)
      return index === -1 ? this.reader.items.length - 1 : index
    }, { say: () => `Page ${this.reader.current?.page ?? page}.` })
  }

  /** "Find where it talks about the dirty bit": search the book and go to the best matching sentence. */
  private async find(query: string): Promise<void> {
    if (!this.reader.current) return
    const book = this.state.book!
    const reading = this.phase === 'PLAYING'
    this.reader.pause()
    this.abortFlow()
    const flow = this.flow
    this.patch({ willResume: reading, error: null })
    if (!query) {
      const heard = await this.listen(flow, 'What should I look for?', 'Find what?', 'search')
      if (heard === null) return
      const intent = parseIntent(heard)
      if (intent.type === 'cancel' || intent.type === 'no') return this.cancelQuestion()
      query = intent.type === 'find' && intent.query ? intent.query : heard
    }
    this.setPhase('RETRIEVING')
    this.deps.earcons.startThinking()
    let matches: FindMatch[]
    try {
      const [result] = await Promise.all([this.deps.api.find(book.id, query), this.feedback(`Looking for ${query}.`, 'Searching.')])
      matches = result.matches
    } catch (error) {
      if (flow !== this.flow) return
      return error instanceof NetworkError
        ? this.fail('NETWORK_ERROR', "I can't reach the server. Check your internet connection and try again.", flow)
        : this.fail('RAG_FAILED', "I couldn't search your textbook just now. Please try again.", flow)
    }
    if (flow !== this.flow) return
    this.deps.earcons.stopThinking()

    /** Say the outcome, then put the player back the way it was: reading or paused. */
    const settle = async (message: string) => {
      await this.inform(message)
      if (flow !== this.flow) return
      this.patch({ willResume: false, status: reading ? 'Reading.' : message })
      this.setPhase(reading ? 'PLAYING' : 'PAUSED')
      if (reading) this.reader.play()
    }
    const best = matches[0]
    const current = this.reader.current
    if (!best) return settle(`I couldn't find anything about ${query} in this book.`)
    if (current && best.chunk_id === current.chunkId && best.chapter_index === this.state.chapterIndex) {
      return settle(`The part you are in now is the best match for ${query}.`)
    }
    this.rememberPlace()
    try {
      if (best.chapter_index !== this.state.chapterIndex) await this.openChapter(best.chapter_index)
    } catch {
      return this.fail('NETWORK_ERROR', 'I could not load that part of the book. Check your connection and try again.', flow)
    }
    if (flow !== this.flow) return
    this.reader.seekTo(this.reader.indexOf(best.chunk_id, best.sentence_index))
    this.landed()
    this.deps.earcons.play('answer')
    const where = `Found in ${best.section || best.chapter}${best.page ? `, page ${best.page}` : ''}.`
    const hint = this.once('return') ? ' Say "return to my place" when you want to go back.' : ''
    await settle(reading ? where + hint : `${where} Press Space to hear it.${hint}`)
  }

  /** True the first time it is asked about `key`: for hints worth saying once, not every time. */
  private once(key: string): boolean {
    if (this.hinted.has(key)) return false
    this.hinted.add(key)
    return true
  }

  private describeContents(): string {
    const book = this.state.book!
    return `${book.title} has ${book.chapters.length} chapter${book.chapters.length === 1 ? '' : 's'}. `
      + book.chapters.map((chapter) => `${chapter.title}.`).join(' ')
      + ` You are in ${this.state.chapterTitle}. Say "go to chapter", then a number, or ask "what sections are in this chapter".`
  }

  private describeSections(): string {
    const chapter = this.state.book!.chapters.find((c) => c.index === this.state.chapterIndex)
    const titles = (chapter?.sections ?? []).map((section) => section.title).filter(Boolean)
    if (!titles.length) return `${this.state.chapterTitle} has no named sections.`
    return `${this.state.chapterTitle} has ${titles.length} section${titles.length === 1 ? '' : 's'}: ${titles.join('. ')}. `
      + 'Say "go to", then the name of a section.'
  }

  // --- skimming ------------------------------------------------------------

  /** Skim mode reads only the first sentence of each paragraph. Turning it off re-reads the current paragraph in full. */
  private async setSkim(on: boolean): Promise<void> {
    const was = this.reader.skim
    this.reader.skim = on
    this.patch({ skim: on })
    await this.interject(async () => {
      if (!on && was) this.reader.seekTo(this.reader.startOfParagraph())
      await this.feedback(
        on ? 'Skimming. I will read the first sentence of each paragraph. Say "read this part" to hear one in full.' : 'Reading in full.',
        on ? 'Skimming.' : 'Reading in full.', 'tick')
    })
    if (on && this.phase !== 'PLAYING' && !this.disposed) this.play() // asking to skim means "start skimming"
  }

  // --- notes ---------------------------------------------------------------

  /** Pin a note to the sentence being read. With no text, ask for it ("What would you like to note?"). */
  private async takeNote(text: string): Promise<void> {
    const item = this.reader.current
    if (!item || !this.mode.persist) {
      this.deps.earcons.play('unknown')
      return
    }
    const save = async (body: string) => {
      const note = await this.deps.api.addNote(this.state.book!.id, item.chunkId, item.sentenceIndex, body)
      this.patch({ notes: [...this.state.notes, note] })
      this.haptic(40)
    }
    if (text) {
      try {
        await save(text)
      } catch {
        return this.interject(() => this.inform('The note could not be saved.', true))
      }
      return this.interject(() => this.feedback('Note saved.', 'Noted.', 'bookmark'))
    }

    const reading = this.phase === 'PLAYING'
    this.reader.pause()
    this.abortFlow()
    const flow = this.flow
    this.patch({ willResume: reading, error: null })
    const heard = await this.listen(flow, 'What would you like to note?', 'Your note?', 'note')
    if (heard === null) return
    const intent = parseIntent(heard)
    if (intent.type === 'cancel' || intent.type === 'no') return this.cancelQuestion()
    try {
      await save(heard.charAt(0).toUpperCase() + heard.slice(1))
    } catch {
      if (flow !== this.flow) return
      return this.fail('NETWORK_ERROR', 'The note could not be saved. Check your connection and try again.', flow)
    }
    if (flow !== this.flow) return
    await this.feedback('Note saved.', 'Noted.', 'bookmark')
    if (flow !== this.flow) return
    await this.finish(flow)
  }

  private describeNotes(): string {
    const notes = this.state.notes
    if (!notes.length) return 'You have no notes in this book yet. Say "take a note" to add one.'
    const recent = notes.slice(-8)
    return `You have ${notes.length} note${notes.length === 1 ? '' : 's'} in this book. `
      + (notes.length > recent.length ? `Here are the last ${recent.length}. ` : '')
      + recent.map((note, i) => `${i + 1}: ${note.text}${/[.!?]$/.test(note.text) ? '' : '.'} In ${note.section || note.chapter}.`).join(' ')
  }

  private describeQuestions(): string {
    const turns = this.state.history
    if (!turns.length) return 'You have not asked any questions in this session yet.'
    return `You have asked ${turns.length} question${turns.length === 1 ? '' : 's'} in this session. `
      + turns.slice(-6).map((turn, i) => `${i + 1}: ${turn.question}`).join('. ')
      + '. Say "repeat the answer" to hear the last answer again, or "export my notes" to keep them all.'
  }

  async gotoNote(note: Note): Promise<void> {
    if (this.phase === 'LOADING' || IN_FLOW.has(this.phase)) return
    await this.jump(note.chapter_index, () => this.reader.indexOf(note.chunk_id, note.sentence_index), {
      say: `At your note in ${note.section || note.chapter}.`, brief: 'At note.', earcon: 'bookmark',
    })
  }

  removeNote(id: number): void {
    this.patch({ notes: this.state.notes.filter((note) => note.id !== id) })
  }

  private async exportNotes(): Promise<void> {
    if (!this.deps.exportNotes || !this.mode.persist) {
      this.deps.earcons.play('unknown')
      return
    }
    try {
      await this.deps.exportNotes()
    } catch {
      return this.interject(() => this.inform('The study notes could not be downloaded. Check your connection and try again.', true))
    }
    await this.interject(() => this.feedback('Your study notes have been downloaded as a text file.', 'Downloaded.', 'bookmark'))
  }

  private async changeSpeed(intent: Extract<Intent, { type: 'speed' }>, quiet: boolean): Promise<void> {
    const current = this.deps.settings().rate
    const rate = intent.change === 'set' ? Math.min(3, Math.max(0.5, intent.value ?? 1)) : step(RATES, current, intent.change === 'up' ? 1 : -1)
    this.deps.updateSettings({ rate })
    const message = rate === current && intent.change !== 'set' ? `Speed is already ${rate} times.` : `Speed ${rate} times.`
    if (quiet) {
      this.deps.earcons.play('tick')
      this.deps.announce(message)
      return
    }
    await this.interject(() => this.feedback(message, `${rate}`, 'tick'))
  }

  /** A preference changed by voice ("yellow theme", "short answers", "microphone off"). */
  private async applySetting(patch: Partial<Settings>, say: string, quiet: boolean): Promise<void> {
    this.deps.updateSettings(patch)
    if ('micMode' in patch) this.startCommandListening()
    if (quiet) {
      this.deps.earcons.play('tick')
      this.deps.announce(say)
      return
    }
    await this.interject(() => this.inform(say))
  }

  private async changeVolume(change: 'up' | 'down', quiet: boolean): Promise<void> {
    const volume = Math.round(Math.min(1, Math.max(0.1, this.deps.settings().volume + (change === 'up' ? 0.2 : -0.2))) * 10) / 10
    this.deps.updateSettings({ volume })
    const message = `Volume ${Math.round(volume * 100)} percent.`
    if (quiet) {
      this.deps.earcons.play('tick')
      this.deps.announce(message)
      return
    }
    await this.interject(() => this.feedback(message, message, 'tick'))
  }

  // --- orientation ---------------------------------------------------------

  private describePosition(): string {
    const item = this.reader.current
    const book = this.state.book
    if (!item || !book) return 'No book is open.'
    const left = Math.max(0, (this.reader.duration - this.reader.audioTime) / this.deps.settings().rate)
    const remaining = left < 90 ? 'About a minute left in this chapter.' : `About ${Math.round(left / 60)} minutes left in this chapter.`
    const { sleepUntil, sleepAt } = this.state
    const timer = sleepAt ? `I will stop at the end of this ${sleepAt}.`
      : sleepUntil !== null ? `Sleep timer: ${describeDuration(Math.max(0, (sleepUntil - this.now()) / 1000))} left.` : ''
    return [
      `${book.title}.`, `${this.state.chapterTitle}.`,
      item.sectionTitle ? `Section: ${item.sectionTitle}.` : '',
      item.page ? `Page ${item.page}.` : '',
      `${Math.round(this.reader.progress * 100)} percent through the chapter.`, remaining,
      this.state.skim ? 'Skim mode is on.' : '', timer,
    ].filter(Boolean).join(' ')
  }

  private helpText(): string {
    const questions = this.mode.assistant
      ? ' To ask something, say "ask a question", or simply ask it. You can also say: explain that, explain this simply, give me an example, define this, summarize this section, or quiz me.'
      : ''
    const tools = this.mode.studyTools
      ? ' To get around: read the contents. Go to the section on, then a topic. Find, then a topic. Return to my place. Skim.'
        + ' To study: take a note. Read my notes. Export my notes.'
      : ''
    return 'Here is what you can say. Pause. Continue. Repeat that. Go back 30 seconds. Go forward 30 seconds. '
      + 'Next section. Previous section. Faster. Slower. Where am I. Bookmark this.' + questions + tools
      + ' On the keyboard: Space pauses and resumes, A asks a question, R repeats, and H opens the full list.'
  }

  private describeBookmarks(): string {
    const marks = this.state.bookmarks
    if (!marks.length) return 'You have no bookmarks in this book. Say "bookmark this" to add one.'
    return `You have ${marks.length} bookmark${marks.length > 1 ? 's' : ''}. `
      + marks.map((b, i) => `${i + 1}: ${b.section || b.chapter}${b.page ? `, page ${b.page}` : ''}.`).join(' ')
  }

  private async addBookmark(): Promise<void> {
    const item = this.reader.current
    if (!item || !this.mode.persist) return
    try {
      const label = item.text.length > 80 ? `${item.text.slice(0, 77)}...` : item.text
      const bookmark = await this.deps.api.addBookmark(this.state.book!.id, item.chunkId, item.sentenceIndex, label)
      this.patch({ bookmarks: [...this.state.bookmarks, bookmark] })
      this.haptic(40)
      await this.interject(() => this.feedback('Bookmark added.', 'Bookmarked.', 'bookmark'))
    } catch {
      await this.interject(() => this.inform('The bookmark could not be saved.', true))
    }
  }

  async gotoBookmark(bookmark: Bookmark | undefined): Promise<void> {
    if (!bookmark) return this.interject(() => this.inform('You have no bookmarks in this book yet.'))
    if (IN_FLOW.has(this.phase)) return
    const reading = this.phase === 'PLAYING'
    await this.jump(bookmark.chapter_index, () => this.reader.indexOf(bookmark.chunk_id, bookmark.sentence_index), {
      say: reading ? undefined : `At your bookmark in ${bookmark.section || bookmark.chapter}.`, brief: 'At bookmark.', earcon: 'bookmark',
    })
  }

  removeBookmark(id: number): void {
    this.patch({ bookmarks: this.state.bookmarks.filter((b) => b.id !== id) })
  }

  // --- the interruption flow -----------------------------------------------

  private captureContext(): AskContext {
    const item = this.reader.current!
    const earlier = this.reader.items.slice(Math.max(0, this.reader.index - 3), this.reader.index)
    return {
      chapter: this.state.chapterTitle,
      section: item.sectionTitle,
      page: item.page,
      chunk_id: item.chunkId,
      sentence_index: item.sentenceIndex,
      character_offset: item.kind === 'sentence' ? this.reader.charOffset : 0,
      current_sentence: item.kind === 'sentence' ? item.text : '',
      recent_context: earlier.filter((it) => it.kind === 'sentence').map((it) => it.text).join(' '),
    }
  }

  /** Interrupt the book for a question. With no request, listen for one first. */
  async interrupt(request?: QARequest): Promise<void> {
    if (!this.mode.assistant) {
      this.deps.earcons.play('unknown')
      this.deps.announce('Questions are not available in this mode.')
      return
    }
    if (!this.reader.current) return
    const followUp = IN_FLOW.has(this.phase)
    const wasReading = this.phase === 'PLAYING'

    // PAUSING: stop the narrator on the exact word, then cancel anything else in progress.
    this.reader.pause()
    this.abortFlow()
    const flow = this.flow
    this.setPhase('PAUSING')
    this.haptic(30)

    // CAPTURE_CONTEXT: remember where we are and what was being heard. A follow-up
    // question keeps the original context and the original decision to resume.
    this.setPhase('CAPTURE_CONTEXT')
    if (!followUp || !this.context) {
      this.context = this.captureContext()
      this.savePosition('interrupt', 'interrupted')
      this.searchOrigin = this.ordinal()
      this.log('search_start', { chapter: this.state.chapterIndex, index: this.reader.index })
      this.patch({ willResume: wasReading })
    }
    this.patch({ question: '', answer: [], speakingSentence: -1, sources: [], grounded: null, error: null, heard: '' })

    if (!request) {
      const heard = await this.listen(flow, 'Listening. Ask your question.', 'Listening.')
      if (heard === null) return
      const intent = parseIntent(heard)
      if (intent.type === 'cancel' || intent.type === 'no' || intent.type === 'resume') return this.cancelQuestion()
      if (intent.type === 'pause' || intent.type === 'stop' || intent.type === 'stayPaused') return this.pause()
      request = intent.type === 'qa' ? intent : { intent: 'question', question: heard }
    }
    await this.answer(request, flow)
  }

  /** LISTENING -> TRANSCRIBING. Returns the utterance, or null if the flow ended (cancelled or failed). */
  private async listen(flow: number, prompt: string, brief: string, what = 'question'): Promise<string | null> {
    this.patch({ listeningFor: what })
    for (let attempt = 0; attempt < 2; attempt++) {
      this.setPhase('LISTENING')
      const typed = !this.deps.stt || !this.mode.voice || this.state.mic === 'denied'
      if (typed) await this.inform(`Type your ${what}, then press Enter.`)
      else if (attempt === 0) await this.feedback(prompt, brief)
      else await this.inform("I didn't catch that. Please say it again.")
      if (flow !== this.flow) return null
      if (!typed) {
        this.deps.earcons.play('listen') // the tone, not the words, is the cue that the microphone is open
        this.haptic([20, 40, 20])
      }
      const result = await this.capture(typed ? null : LISTEN_TIMEOUT_MS)
      if (flow !== this.flow) return null
      if (result.ok) {
        this.deps.earcons.play('heard')
        this.setPhase('TRANSCRIBING')
        return result.text
      }
      if (result.reason === 'cancelled') return null
      if (result.reason === 'network') break
      // 'not-allowed' loops once more, now in typed mode; 'no-speech' / 'timeout' get a second try.
    }
    await this.fail('STT_FAILED', what === 'question'
      ? "I couldn't understand the question. Please try again." : "I didn't hear anything. Please try again.", flow)
    return null
  }

  /** RETRIEVING -> GENERATING -> SPEAKING_ANSWER. Speaks each sentence as soon as it arrives. */
  private async answer(request: QARequest, flow: number): Promise<void> {
    const book = this.state.book!
    const s = this.deps.settings()
    this.patch({ question: request.question })
    this.log('question', { text: request.question, intent: request.intent })
    this.setPhase('RETRIEVING')
    this.deps.earcons.startThinking()
    const abort = new AbortController()
    this.abort = abort

    // The spoken status and the request run at the same time; answer sentences queue up behind the status.
    let speech: Promise<unknown> = this.feedback('Searching your textbook.', 'Searching.')
    const sentences: string[] = []
    let speaking = false
    let voiceFailed = false
    const speak = (text: string, index: number) => {
      speech = speech.then(async () => {
        if (flow !== this.flow) return
        if (!speaking) {
          speaking = true
          this.deps.earcons.stopThinking()
          this.deps.earcons.play('answer')
          this.setPhase('SPEAKING_ANSWER')
          this.patch({ status: 'Answering.' })
        }
        this.patch({ speakingSentence: index })
        if ((await this.say(text)) === 'error') voiceFailed = true
      })
    }

    // A slow answer must not sound like a dead one: say so once if nothing has arrived after a while.
    const reassure = setTimeout(() => {
      if (flow !== this.flow || sentences.length) return
      speech = speech.then(async () => {
        if (flow === this.flow && !sentences.length) await this.feedback('Still working on your answer.', 'Still working.')
      })
    }, SLOW_ANSWER_MS)
    abort.signal.addEventListener('abort', () => clearTimeout(reassure))

    try {
      const body = {
        question: request.question, intent: request.intent, term: request.term ?? '', scope: request.scope ?? 'section',
        answer_length: s.answerLength, conversation_id: this.conversationId, context: this.context!,
      }
      for await (const event of this.deps.api.askStream(book.id, body, abort.signal)) {
        if (flow !== this.flow) return
        if (event.type === 'stage' && event.stage === 'generating' && !speaking) {
          this.setPhase('GENERATING')
          this.patch({ status: 'Generating your answer.' })
          this.deps.announce('Generating your answer.')
        } else if (event.type === 'sources') {
          this.patch({ sources: event.sources })
        } else if (event.type === 'sentence') {
          sentences.push(event.text)
          this.deps.tts.prefetch?.(event.text, 'assistant')
          this.patch({ answer: [...sentences] })
          speak(event.text, sentences.length - 1)
        } else if (event.type === 'done') {
          this.conversationId = event.conversation_id
          this.patch({ grounded: event.grounded, provider: event.provider })
        } else if (event.type === 'error') {
          throw new FlowError(event.code, event.message)
        }
      }
    } catch (error) {
      if (flow !== this.flow) return
      if (!sentences.length) {
        if (error instanceof FlowError) return this.fail(error.code, error.message, flow)
        if (error instanceof NetworkError) return this.fail('NETWORK_ERROR', "I can't reach the server. Check your internet connection and try again.", flow)
        const message = error instanceof ApiError && error.status < 500 ? error.message : 'Something went wrong while searching your textbook. Please try again.'
        return this.fail('RAG_FAILED', message, flow)
      }
      // The connection dropped mid-answer: finish speaking what arrived.
    }
    clearTimeout(reassure)
    await speech
    if (flow !== this.flow) return
    this.deps.earcons.stopThinking()
    if (!sentences.length) return this.fail('LLM_FAILED', "I couldn't put an answer together. Please try again.", flow)

    this.patch({ speakingSentence: -1, history: [...this.state.history, { question: request.question, answer: sentences.join(' ') }] })
    this.log('answer_found')
    this.awaitingResumeLog = true
    if (voiceFailed) {
      // The answer cannot be spoken, so it cannot be announced by voice either: use the live region and a tone.
      this.setPhase('TTS_FAILED')
      const message = 'The answer could not be spoken. It is shown on screen. Press Space to continue reading.'
      this.patch({ error: { code: 'TTS_FAILED', message }, status: message })
      this.deps.earcons.play('error')
      this.deps.announce(message, true)
      this.log('error', { code: 'TTS_FAILED' })
      this.setPhase('PAUSED')
      return
    }
    if (s.speakSources && this.state.sources.length) {
      const top = [...this.state.sources].sort((a, b) => b.score - a.score)[0]
      await this.say(`This is from ${top.section || top.chapter}${top.page ? `, page ${top.page}` : ''}.`)
      if (flow !== this.flow) return
    }
    await this.afterAnswer(flow)
  }

  /** Speak an error, then put the student back where they were. Nobody is left in silence. */
  private async fail(code: ErrorCode, message: string, flow: number): Promise<void> {
    this.deps.earcons.stopThinking()
    this.setPhase(code)
    this.patch({ error: { code, message } })
    this.deps.earcons.play('error')
    this.haptic([60, 60, 60])
    this.log('error', { code })
    await this.inform(message, true)
    if (flow !== this.flow) return
    await this.finish(flow)
  }

  private async afterAnswer(flow: number): Promise<void> {
    const s = this.deps.settings()
    const seconds = s.followUpSeconds
    const canHear = !!this.deps.stt && this.mode.voice && this.state.mic !== 'denied'
    if (this.state.willResume && s.autoResume && seconds > 0 && canHear) {
      this.setPhase('FOLLOW_UP')
      await this.feedback('Any follow-up question?', 'Anything else?')
      if (flow !== this.flow) return
      this.deps.earcons.play('listen')
      const result = await this.capture(seconds * 1000)
      if (flow !== this.flow) return
      if (result.ok) {
        const intent = parseIntent(result.text)
        if (intent.type === 'pause' || intent.type === 'stop' || intent.type === 'stayPaused') return this.pause()
        if (intent.type === 'qa') return this.answer(intent, flow)
        if (intent.type === 'unknown' && result.text.split(/\s+/).length >= 2) {
          return this.answer({ intent: 'question', question: result.text }, flow)
        }
      }
    }
    await this.finish(flow)
  }

  /** End of a question: resume the book if it was playing, otherwise stay paused. */
  private async finish(flow: number): Promise<void> {
    if (this.state.willResume && this.deps.settings().autoResume) return this.resumeReading(flow)
    this.setPhase('PAUSED')
    this.patch({ status: 'Paused. Press Space or say "continue" to carry on reading.' })
    this.deps.announce('Paused. Press Space or say continue to carry on reading.')
  }

  /** RESUME_CONFIRMATION -> PLAYING, from the saved position. */
  private async resumeReading(flow: number): Promise<void> {
    this.setPhase('RESUME_CONFIRMATION')
    await this.feedback('Continuing from where you stopped.', 'Continuing.', 'resume')
    if (flow !== this.flow) return
    this.reader.applyResumeMode(this.deps.settings().resumeMode)
    this.context = null
    if (this.sleepIsDue()) this.patch({ sleepUntil: null })
    this.patch({ status: 'Reading.', willResume: false })
    this.setPhase('PLAYING')
    this.reader.play()
    this.logResumed()
  }

  /** "Continue reading": skip the rest of the answer and go straight back to the book. */
  async continueReading(): Promise<void> {
    this.reader.pause()
    this.abortFlow()
    await this.resumeReading(this.flow)
  }

  private async cancelQuestion(): Promise<void> {
    this.reader.pause()
    this.abortFlow()
    await this.finish(this.flow)
  }

  /** "Stay paused": let the answer finish, but do not resume afterwards. */
  private stayPaused(): void {
    this.deps.earcons.play('tick')
    if (!IN_FLOW.has(this.phase)) return
    this.patch({ willResume: false })
    this.deps.announce('I will stay paused after the answer.')
    if (this.phase === 'FOLLOW_UP' || this.phase === 'RESUME_CONFIRMATION') void this.pause()
  }

  async replayAnswer(): Promise<void> {
    const sentences = this.state.answer
    if (!sentences.length) return this.interject(() => this.inform('There is no answer to repeat yet.'))
    const wasReading = this.phase === 'PLAYING'
    this.reader.pause()
    this.abortFlow()
    const flow = this.flow
    if (wasReading) this.patch({ willResume: true })
    this.setPhase('SPEAKING_ANSWER')
    for (let i = 0; i < sentences.length; i++) {
      this.patch({ speakingSentence: i })
      if ((await this.say(sentences[i])) !== 'ended' || flow !== this.flow) return
    }
    this.patch({ speakingSentence: -1 })
    await this.finish(flow)
  }

  /** "Quiz me": one question on the current section, marked against the textbook. */
  private async quiz(): Promise<void> {
    if (!this.mode.assistant || !this.reader.current) return
    const wasReading = this.phase === 'PLAYING'
    const followUp = IN_FLOW.has(this.phase)
    this.reader.pause()
    this.abortFlow()
    const flow = this.flow
    if (!followUp) this.patch({ willResume: wasReading })
    this.context ??= this.captureContext()
    const book = this.state.book!
    this.patch({ question: '', answer: [], sources: [], grounded: null, error: null, speakingSentence: -1 })
    this.setPhase('RETRIEVING')
    this.deps.earcons.startThinking()
    try {
      const [question] = await Promise.all([this.deps.api.quiz(book.id, this.context), this.feedback('Preparing a question.', 'One moment.')])
      if (flow !== this.flow) return
      this.deps.earcons.stopThinking()
      this.setPhase('SPEAKING_ANSWER')
      this.patch({ question: `Quiz: ${question.question}` })
      if ((await this.say(question.question)) !== 'ended' || flow !== this.flow) return
      const given = await this.listen(flow, 'Your answer?', 'Answer?', 'answer')
      if (given === null) return
      this.setPhase('GENERATING')
      this.deps.earcons.startThinking()
      const marked = await this.deps.api.quizCheck(book.id, question, given)
      if (flow !== this.flow) return
      this.deps.earcons.stopThinking()
      this.deps.earcons.play(marked.verdict === 'incorrect' ? 'unknown' : 'answer')
      this.setPhase('SPEAKING_ANSWER')
      this.patch({ answer: [`You said: ${given}`, marked.feedback], speakingSentence: 1 })
      if ((await this.say(marked.feedback)) !== 'ended' || flow !== this.flow) return
      this.patch({ speakingSentence: -1 })
      await this.finish(flow)
    } catch (error) {
      if (flow !== this.flow) return
      if (error instanceof NetworkError) return this.fail('NETWORK_ERROR', "I can't reach the server. Check your internet connection and try again.", flow)
      return this.fail('LLM_FAILED', error instanceof ApiError ? error.message : "I couldn't make a quiz question just now.", flow)
    }
  }

  // --- lifecycle -----------------------------------------------------------

  /** Called when the page is hidden or closed, so the place is never lost. */
  saveNow(): void {
    this.savePosition('manual', this.phase === 'FINISHED' ? 'finished' : 'paused', true)
  }

  dispose(): void {
    this.saveNow()
    this.disposed = true
    this.reader.pause()
    this.abortFlow()
    this.deps.stt?.stop()
    this.listeners.clear()
  }
}
