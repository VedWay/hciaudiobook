/**
 * What a phrase means on the "My books" screen: "open operating systems",
 * "the second one", "tell me about data structures" - and, with no book named,
 * "continue", "resume", "start reading", which mean the book last being read.
 */
import type { BookSummary } from '../types'
import { normalize, parseIntent, parseNumber } from './intents'
import { closest } from './text'

export type LibraryAction =
  | { type: 'list' | 'upload' | 'empty' }
  /** Several books and no way to tell which one is meant: ask. */
  | { type: 'which' }
  | { type: 'open' | 'restart' | 'describe'; book: BookSummary }
  | { type: 'notFound'; wanted: string }

const LAST_BOOK_KEY = 'aa.lastBook'

/** The book most recently opened on this device, so "continue" works from any screen. */
export function getLastBook(): string {
  try {
    return localStorage.getItem(LAST_BOOK_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setLastBook(id: string): void {
  try {
    localStorage.setItem(LAST_BOOK_KEY, id)
  } catch {
    // Private browsing: "continue" then falls back to the book that is part-way through.
  }
}

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9,
}

const VERB = /^(open up|open|read out|read|continue with|continue|resume|play|start|begin|restart|carry on with|carry on|keep going|keep reading|go on with|go on|go ahead|proceed|listen to|put on|launch|load|select|choose|pick|tell me about|describe|what is|what's)\b ?/
const DESCRIBE = /^(tell me about|describe|what is|what's)\b/
const FROM_START = /\b(from the (very )?(beginning|start|top)|start(ing)? (over|afresh)|over again|from scratch|restart)\b/g
const WHERE_I_WAS = /\b(from |at )?where (i|we) (left off|left|stopped|was|were|had stopped|had left off)\b/g
/** Words around a title that say nothing about which book is meant. */
const NOISE = /^(reading|with|on|the|my|a|an|book|books|audiobook|textbook|number|called|named|titled|it|that|this|again|now|then|last|previous|current|same|recent|most|about|is|to|me|up|out|aloud|loud)$/

function strip(text: string): string {
  // "that one", "the same one" point at the current book; "book one" and "the second one" name a book.
  const words = text.replace(/\b(that|this|same|last|previous|current) one\b/g, ' ').replace(/\b(\w+(?:st|nd|rd|th)|first|second|third) one\b/g, '$1')
    .split(' ').filter(Boolean)
  while (words.length && NOISE.test(words[0])) words.shift()
  while (words.length && NOISE.test(words[words.length - 1])) words.pop()
  return words.join(' ')
}

/**
 * "Continue" or "start reading" with no book named: the one last opened on this device, else the
 * one read most recently, else the only one there is. Only a shelf of several untouched books
 * leaves a real question - a listener should not be quizzed when the answer is obvious.
 */
export function bookToContinue(ready: BookSummary[], lastId: string): BookSummary | 'which' | 'empty' {
  if (!ready.length) return 'empty'
  const last = ready.find((book) => book.id === lastId)
  if (last) return last
  const started = ready.filter((book) => book.session?.started)
  const unfinished = started.filter((book) => book.session!.status !== 'finished')
  const candidates = unfinished.length ? unfinished : started
  if (candidates.length) {
    return [...candidates].sort((a, b) => (b.session!.last_updated ?? '').localeCompare(a.session!.last_updated ?? ''))[0]
  }
  return ready.length === 1 ? ready[0] : 'which'
}

function pick(wanted: string, ready: BookSummary[]): BookSummary | undefined {
  const number = parseNumber(wanted) ?? ORDINALS[wanted] ?? null
  return number !== null ? ready[number - 1] : closest(wanted, ready, (book) => book.title)
}

/** The library's reading of a phrase, or null when it is not about the library (settings, help, a question...). */
export function parseLibraryPhrase(phrase: string, ready: BookSummary[], lastId: string): LibraryAction | null {
  const text = normalize(phrase)
  if (!text) return null
  if (/^(list|read|show|tell me|say|what are)( me)?( all)?( my| the)?( all)? books$|^what books (do i have|are there|have i got)$|^what can i (read|listen to)$|^which books( do i have| are there)?$/.test(text)) {
    return { type: 'list' }
  }
  if (/\b(add|upload|import)\b.*\b(book|file|pdf|textbook)\b/.test(text)) return { type: 'upload' }

  // "Start over" and "from where I left off" say how to open a book, not which one: set them aside first.
  const fromStart = text.search(FROM_START) !== -1
  const cleaned = text.replace(FROM_START, ' ').replace(WHERE_I_WAS, ' ').replace(/\s+/g, ' ').trim()
  const verb = VERB.exec(cleaned)
  const wanted = strip(verb ? cleaned.slice(verb[0].length) : cleaned)
  const describe = !!verb && DESCRIBE.test(verb[0])

  if (!wanted) {
    // No book named. "Continue", "resume", "start reading", "play it", "start over": the current book.
    if ((!verb && !fromStart) || describe) return null
    const book = bookToContinue(ready, lastId)
    if (book === 'which' || book === 'empty') return { type: book }
    return { type: fromStart ? 'restart' : 'open', book }
  }

  const book = pick(wanted, ready)
  if (book) return { type: describe ? 'describe' : fromStart ? 'restart' : 'open', book }
  // Not a book we have. Only complain if nothing else in the app understands the phrase
  // ("open settings", "read my notes" and "what is my speed" are not requests for a book).
  if (!verb || fromStart) return null
  const other = parseIntent(phrase).type
  return ['unknown', 'gotoSection', 'find', 'play', 'resume'].includes(other) ? { type: 'notFound', wanted } : null
}
