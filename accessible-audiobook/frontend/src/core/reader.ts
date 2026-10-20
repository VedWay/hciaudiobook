/**
 * The narrator: reads a chapter one sentence at a time and always knows exactly
 * where it is - (item index, character offset of the word being spoken).
 * That precise position is what makes "resume exactly where I interrupted" work.
 */
import type { ChapterContent } from '../types'
import type { SpeakOptions, TTSEngine } from './tts'

export interface ReadItem {
  kind: 'chapter' | 'section' | 'sentence'
  text: string
  chunkId: number
  chunkIndex: number
  sentenceIndex: number
  sectionIndex: number
  sectionTitle: string
  page: number
  /** True for the first sentence of a paragraph: the one sentence skimming reads. */
  paragraphStart: boolean
  /** Characters of the chapter that come before this item (for progress and time seeking). */
  startChar: number
}

export type ResumeMode = 'exact' | 'sentence' | 'previous'

export interface ReaderEvents {
  onPosition(): void
  onItemStart(item: ReadItem): void
  onChapterEnd(): void
  onError(error: string): void
  /** Asked before moving on to the next item. Return false to stop reading there (sleep timer). */
  beforeItem?(next: ReadItem, previous: ReadItem): boolean
  /** Skimming just jumped over the rest of a paragraph. */
  onSkip?(): void
}

/** Flatten a chapter into what is spoken, in order: its title, each section heading, each sentence. */
export function buildItems(chapter: ChapterContent): ReadItem[] {
  const items: ReadItem[] = []
  let startChar = 0
  const push = (item: Omit<ReadItem, 'startChar'>) => {
    items.push({ ...item, startChar })
    startChar += item.text.length + 1
  }
  let first = true
  for (const section of chapter.sections) {
    const lead = section.chunks[0]
    if (!lead) continue
    const base = {
      chunkId: lead.id, chunkIndex: lead.chunk_index, sentenceIndex: 0, sectionIndex: section.index,
      sectionTitle: section.title, page: lead.page, paragraphStart: false,
    }
    if (first) push({ kind: 'chapter', text: chapter.title, ...base })
    first = false
    if (section.title) push({ kind: 'section', text: section.title, ...base })
    for (const chunk of section.chunks) {
      const starts = new Set(chunk.paragraph_starts ?? [0]) // unknown: treat the chunk as one paragraph
      chunk.sentences.forEach((text, sentenceIndex) => push({
        kind: 'sentence', text, chunkId: chunk.id, chunkIndex: chunk.chunk_index, sentenceIndex,
        sectionIndex: section.index, sectionTitle: section.title, page: chunk.page,
        paragraphStart: starts.has(sentenceIndex),
      }))
    }
  }
  return items
}

/** Start of the word that contains (or begins at) `offset`. */
export function wordStart(text: string, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= text.length) return text.length
  return text.lastIndexOf(' ', offset - 1) + 1
}

const DEFAULT_CHARS_PER_SECOND = 15 // typical synthetic voice at 1x; refined as sentences are timed

export class Reader {
  items: ReadItem[] = []
  index = 0
  charOffset = 0
  playing = false
  /**
   * Skim mode: read headings and only the first sentence of each paragraph. Sighted
   * readers skim by eye; this is the same thing by ear.
   */
  skim = false
  charsPerSecond = DEFAULT_CHARS_PER_SECOND

  private tts: TTSEngine
  private voice: () => SpeakOptions
  private events: ReaderEvents
  private utteranceBase = 0
  private utteranceLength = 0
  private utteranceRate = 1
  private utteranceStarted = 0
  private sawBoundary = false

  constructor(tts: TTSEngine, voice: () => SpeakOptions, events: ReaderEvents) {
    this.tts = tts
    this.voice = voice
    this.events = events
  }

  load(items: ReadItem[], index = 0, charOffset = 0): void {
    this.halt()
    this.items = items
    this.index = Math.min(Math.max(0, index), Math.max(0, items.length - 1))
    this.charOffset = charOffset
    this.events.onPosition()
  }

  get current(): ReadItem | undefined {
    return this.items[this.index]
  }

  get totalChars(): number {
    const last = this.items[this.items.length - 1]
    return last ? last.startChar + last.text.length : 0
  }

  /** Fraction of the chapter already read. */
  get progress(): number {
    const item = this.current
    return item && this.totalChars ? (item.startChar + this.charOffset) / this.totalChars : 0
  }

  /** Estimated seconds into the chapter at normal speed. */
  get audioTime(): number {
    const item = this.current
    return item ? (item.startChar + this.charOffset) / this.charsPerSecond : 0
  }

  get duration(): number {
    return this.totalChars / this.charsPerSecond
  }

  play(): void {
    if (!this.items.length) return
    this.playing = true
    this.speakCurrent()
  }

  /** Stop speaking and keep the exact position of the word that was being spoken. */
  pause(): void {
    if (!this.playing) return
    if (!this.sawBoundary && this.utteranceStarted) {
      // This voice reports no word boundaries: estimate from elapsed time instead.
      const elapsed = (performance.now() - this.utteranceStarted) / 1000
      const spoken = Math.min(this.utteranceLength, elapsed * this.charsPerSecond * this.utteranceRate)
      this.charOffset = wordStart(this.current?.text ?? '', this.utteranceBase + Math.floor(spoken))
    }
    this.halt()
    this.events.onPosition()
  }

  private halt(): void {
    this.playing = false
    this.utteranceStarted = 0
    this.tts.cancel()
  }

  /** The item read after the current one (-1 at the end of the chapter). Skimming passes over the rest of each paragraph. */
  private nextIndex(): number {
    for (let i = this.index + 1; i < this.items.length; i++) {
      const item = this.items[i]
      if (!this.skim || item.kind !== 'sentence' || item.paragraphStart) return i
    }
    return -1
  }

  private speakCurrent(): void {
    const item = this.current
    if (!item) return
    const offset = wordStart(item.text, this.charOffset)
    const text = item.text.slice(offset)
    if (!text.trim()) return this.advance()

    const options = this.voice()
    this.charOffset = offset
    this.utteranceBase = offset
    this.utteranceLength = text.length
    this.utteranceRate = options.rate
    this.utteranceStarted = performance.now()
    this.sawBoundary = false
    this.events.onItemStart(item)
    this.events.onPosition()
    const next = this.items[this.nextIndex()]
    if (next) this.tts.prefetch?.(next.text)

    this.tts.speak(text, options, {
      onStart: () => { this.utteranceStarted = performance.now() },
      onBoundary: (charIndex) => {
        this.sawBoundary = true
        this.charOffset = this.utteranceBase + charIndex
        this.events.onPosition()
      },
      onEnd: () => {
        const seconds = (performance.now() - this.utteranceStarted) / 1000
        if (seconds > 1 && text.length > 20) {
          const measured = text.length / (seconds * this.utteranceRate)
          this.charsPerSecond = 0.8 * this.charsPerSecond + 0.2 * Math.min(30, Math.max(8, measured))
        }
        this.advance()
      },
      onError: (error) => {
        this.playing = false
        this.events.onError(error)
      },
    })
  }

  private advance(): void {
    const next = this.nextIndex()
    if (next === -1) {
      // Stay on the last sentence (fully read) so the position remains a real place in the book.
      this.charOffset = this.current?.text.length ?? 0
      this.playing = false
      this.events.onPosition()
      this.events.onChapterEnd()
      return
    }
    const previous = this.items[this.index]
    const skipped = next > this.index + 1
    this.index = next
    this.charOffset = 0
    if (this.playing && this.events.beforeItem && !this.events.beforeItem(this.items[next], previous)) {
      this.playing = false // stopped at a clean boundary, ready to carry on from the next sentence
    }
    if (!this.playing) return this.events.onPosition()
    if (skipped) this.events.onSkip?.()
    this.speakCurrent()
  }

  /** Move without losing the playing state. */
  private moveTo(index: number, charOffset = 0): void {
    const wasPlaying = this.playing
    this.halt()
    this.index = Math.min(Math.max(0, index), this.items.length - 1)
    this.charOffset = charOffset
    this.events.onPosition()
    if (wasPlaying) this.play()
  }

  seekTo(index: number, charOffset = 0): void {
    this.moveTo(index, charOffset)
  }

  /** Where to restart after an interruption. */
  applyResumeMode(mode: ResumeMode): void {
    if (mode === 'exact') return
    if (mode === 'previous' && this.index > 0 && this.items[this.index - 1].kind === 'sentence') this.index--
    this.charOffset = 0
  }

  /**
   * "Go back 30 seconds": seconds of listening at the current speed. Lands on the
   * start of a sentence, since restarting mid-word is disorienting by ear.
   */
  seekSeconds(seconds: number, rate: number): 'ok' | 'start' | 'end' {
    const item = this.current
    if (!item) return 'ok'
    const target = item.startChar + this.charOffset + seconds * this.charsPerSecond * rate
    if (target <= 0) {
      this.moveTo(0)
      return 'start'
    }
    if (target >= this.totalChars) {
      this.moveTo(this.items.length - 1)
      return 'end'
    }
    let index = this.items.findIndex((it) => target < it.startChar + it.text.length + 1)
    if (seconds > 0) index = Math.max(index, Math.min(this.index + 1, this.items.length - 1))
    else if (index === this.index && this.charOffset < 12) index = Math.max(0, index - 1)
    this.moveTo(index)
    return 'ok'
  }

  /** "Repeat that": the current sentence, or the previous one if this one has barely begun. */
  repeat(): void {
    const barelyBegun = this.charOffset < 12
    this.moveTo(barelyBegun && this.index > 0 ? this.index - 1 : this.index)
  }

  stepSentence(delta: -1 | 1): boolean {
    const target = this.index + delta
    if (target < 0 || target >= this.items.length) return false
    this.moveTo(target)
    return true
  }

  /** Jump by paragraph or section; delta 0 restarts the current one. False when there is none in this chapter. */
  stepUnit(unit: 'paragraph' | 'section', delta: -1 | 0 | 1): boolean {
    const starts = unit === 'section'
      ? this.items.flatMap((it, i) => (i === 0 || it.sectionIndex !== this.items[i - 1].sectionIndex ? [i] : []))
      : this.items.flatMap((it, i) => (it.kind === 'sentence' && it.paragraphStart ? [i] : []))
    const here = starts.filter((s) => s <= this.index).length - 1
    if (here < 0) {
      // On a heading, before the first paragraph: "next" goes to that paragraph, anything else stays put.
      if (delta === 1 && starts.length) this.moveTo(starts[0])
      else if (delta === 0) this.moveTo(this.index)
      return delta !== -1 && (delta === 0 || starts.length > 0)
    }
    // "Previous" from the middle of a unit goes to its start first, like a music player's back button.
    const deep = this.index - starts[here] > 1
    const target = delta === -1 && deep ? here : here + delta
    if (target < 0 || target >= starts.length) return false
    this.moveTo(starts[target])
    return true
  }

  /** Index of the first sentence of the paragraph being read (for "read this part in full"). */
  startOfParagraph(): number {
    for (let i = this.index; i >= 0; i--) {
      const item = this.items[i]
      if (item.kind !== 'sentence') return Math.min(i + 1, this.index)
      if (item.paragraphStart) return i
    }
    return this.index
  }

  /** First item for a saved (chunk, sentence) position. */
  indexOf(chunkId: number, sentenceIndex: number): number {
    const index = this.items.findIndex((it) => it.kind === 'sentence' && it.chunkId === chunkId && it.sentenceIndex === sentenceIndex)
    return Math.max(0, index)
  }
}
