import { describe, expect, it } from 'vitest'
import type { BookSummary } from '../types'
import { bookToContinue, parseLibraryPhrase } from './libraryVoice'

function book(id: string, title: string, started = false, status = 'paused'): BookSummary {
  return {
    id, title, author: '', description: '', total_pages: 10, total_chunks: 10, total_chars: 1000, chapter_count: 3,
    status: 'ready', status_detail: '', ingest_progress: 1, is_sample: true,
    session: started ? { book_id: id, chapter_id: 1, chapter_index: 0, chunk_id: 1, sentence_index: 0, character_offset: 0,
      audio_time: 0, playback_speed: 1, status, started: true, progress: 0.3 } : null,
  }
}

const OS = book('operating-systems', 'Operating Systems', true)
const DS = book('data-structures', 'Data Structures')
const BOOKS = [OS, DS]

describe('"continue" with no book named', () => {
  it.each([
    'continue', 'Continue.', 'resume', 'continue reading', 'continue the book', 'continue my book', 'carry on', 'keep going',
    'keep reading', 'go on', 'start reading', 'play', 'read', 'read to me', 'continue where I left off',
    'resume from where I stopped', 'could you please continue reading', 'continue reading the book now', 'open it',
    'play that one', 'read the same book again',
  ])('%s -> the book last being read', (phrase) => {
    expect(parseLibraryPhrase(phrase, BOOKS, 'data-structures')).toEqual({ type: 'open', book: DS })
  })

  it('falls back to the only book in progress, then to the only book there is', () => {
    expect(bookToContinue(BOOKS, '')).toBe(OS)
    expect(bookToContinue(BOOKS, 'a-deleted-book')).toBe(OS)
    expect(bookToContinue([DS], '')).toBe(DS)
  })

  it('with several books in progress, picks the one read most recently instead of asking', () => {
    const older = { ...OS, session: { ...OS.session!, last_updated: '2026-10-01T10:00:00+00:00' } }
    const newer = book('data-structures', 'Data Structures', true)
    newer.session!.last_updated = '2026-10-07T09:30:00+00:00'
    expect(parseLibraryPhrase('start reading', [older, newer], '')).toEqual({ type: 'open', book: newer })
    expect(parseLibraryPhrase('continue', [older, newer], '')).toEqual({ type: 'open', book: newer })
    // A finished book is not what "continue" means while another is part-way through.
    const finished = book('networks', 'Networks', true, 'finished')
    finished.session!.last_updated = '2026-10-08T00:00:00+00:00'
    expect(parseLibraryPhrase('continue', [finished, older], '')).toEqual({ type: 'open', book: older })
  })

  it('asks which book only when several books are all untouched, and says so when there are none', () => {
    expect(parseLibraryPhrase('continue', [DS, book('x', 'Networks')], '')).toEqual({ type: 'which' })
    expect(parseLibraryPhrase('continue', [], '')).toEqual({ type: 'empty' })
  })

  it('"start over" restarts the current book', () => {
    expect(parseLibraryPhrase('start over', BOOKS, 'operating-systems')).toEqual({ type: 'restart', book: OS })
    expect(parseLibraryPhrase('read it from the beginning', BOOKS, 'operating-systems')).toEqual({ type: 'restart', book: OS })
  })
})

describe('naming a book', () => {
  it.each([
    ['open operating systems', OS], ['operating systems', OS], ['continue operating systems', OS],
    ['continue reading data structures', DS], ['read book two', DS], ['open book one', OS], ['two', DS],
    ['the second one', DS], ['open the first book', OS], ['play the data structures book', DS],
    ['can you open up the operating systems textbook please', OS], ['resume with data structures', DS],
  ])('%s', (phrase, expected) => {
    expect(parseLibraryPhrase(phrase, BOOKS, '')).toEqual({ type: 'open', book: expected })
  })

  it('restarts and describes', () => {
    expect(parseLibraryPhrase('start operating systems from the beginning', BOOKS, '')).toEqual({ type: 'restart', book: OS })
    expect(parseLibraryPhrase('restart data structures', BOOKS, '')).toEqual({ type: 'restart', book: DS })
    expect(parseLibraryPhrase('tell me about data structures', BOOKS, '')).toEqual({ type: 'describe', book: DS })
    expect(parseLibraryPhrase('what is operating systems about', BOOKS, '')).toEqual({ type: 'describe', book: OS })
  })

  it('says when a named book is not there, instead of opening another one', () => {
    expect(parseLibraryPhrase('open quantum physics', BOOKS, 'operating-systems')).toEqual({ type: 'notFound', wanted: 'quantum physics' })
    expect(parseLibraryPhrase('play quantum physics', BOOKS, 'operating-systems')).toEqual({ type: 'notFound', wanted: 'quantum physics' })
  })
})

describe('other library phrases', () => {
  it.each(['list my books', 'read me the books', 'what books do I have', 'which books are there', 'what can I read'])('%s', (phrase) => {
    expect(parseLibraryPhrase(phrase, BOOKS, '')).toEqual({ type: 'list' })
  })

  it('leaves everything else to the rest of the app', () => {
    for (const phrase of ['go to settings', 'open settings', 'yellow theme', 'bigger text', 'help', 'what is a page fault',
      'read my notes', 'faster', 'what are my settings', 'show me the help page']) {
      expect(parseLibraryPhrase(phrase, BOOKS, 'operating-systems')).toBeNull()
    }
    expect(parseLibraryPhrase('add a book', BOOKS, '')).toEqual({ type: 'upload' })
  })
})
