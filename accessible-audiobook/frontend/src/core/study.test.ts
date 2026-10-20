/**
 * Tests of the study tools built around the reading flow: the table of contents,
 * finding a passage, returning to one's place, skimming, the sleep timer and notes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BookDetail, ChapterContent, FindMatch, Note, PlaybackSession } from '../types'
import { AudiobookController, type ControllerDeps } from './controller'
import { ASSISTANT_PITCH, FakeSTT, FakeTTS, until } from './fakes'
import { DEFAULT_SETTINGS, type Settings } from './settings'

const LEAD = ['Paging removes the need for contiguous allocation.', 'Note that paging is used by almost every operating system today.']
const FRAMES = ['Physical memory is divided into frames.', 'Logical memory is divided into pages.', 'Every frame has the same size.', 'So any free frame can hold any page.']
const TABLE = ['Every process has its own page table.', 'The valid bit says whether the page is in memory.', 'The dirty bit records a change.']
const FAULTS = ['A page fault is a normal signal.', 'It is not an error.']
const THRASH = ['Thrashing wastes time moving pages.']

const chapters: ChapterContent[] = [
  { id: 10, index: 0, title: 'Chapter 1: Paging', sections: [
    { id: 100, index: 0, title: '', chunks: [{ id: 1, chunk_index: 0, page: 1, sentences: LEAD, paragraph_starts: [0] }] },
    // Two paragraphs of two sentences each.
    { id: 101, index: 1, title: 'Pages and Frames', chunks: [{ id: 2, chunk_index: 1, page: 1, sentences: FRAMES, paragraph_starts: [0, 2] }] },
    { id: 102, index: 2, title: 'The Page Table', chunks: [{ id: 3, chunk_index: 2, page: 2, sentences: TABLE, paragraph_starts: [0, 1] }] },
  ] },
  { id: 11, index: 1, title: 'Chapter 2: Virtual Memory', sections: [
    { id: 110, index: 0, title: 'Page Faults', chunks: [{ id: 4, chunk_index: 3, page: 3, sentences: FAULTS, paragraph_starts: [0] }] },
    { id: 111, index: 1, title: 'Thrashing and the Working Set', chunks: [{ id: 5, chunk_index: 4, page: 4, sentences: THRASH, paragraph_starts: [0] }] },
  ] },
]

function makeBook(session: Partial<PlaybackSession> | null = null): BookDetail {
  return {
    id: 'os', title: 'Operating Systems', status: 'ready', session, total_pages: 4,
    chapters: chapters.map((c) => ({
      id: c.id, index: c.index, title: c.title, start_page: c.sections[0].chunks[0].page, char_count: 300,
      sections: c.sections.map((s) => ({ id: s.id, index: s.index, title: s.title })),
    })),
  } as unknown as BookDetail
}

const IN_PAGE_FAULTS: FindMatch = {
  chunk_id: 4, sentence_index: 1, chapter_index: 1, chapter: 'Chapter 2: Virtual Memory', section: 'Page Faults', page: 3,
  snippet: FAULTS[1], score: 1,
}

function setup(options: { settings?: Partial<Settings>; mode?: ControllerDeps['mode']; session?: Partial<PlaybackSession> } = {}) {
  const tts = new FakeTTS()
  const stt = new FakeSTT()
  const settings: Settings = { ...DEFAULT_SETTINGS, haptics: false, ...options.settings }
  const clock = { ms: 1_000_000 }
  const announced: string[] = []
  const search = { matches: [IN_PAGE_FAULTS] as FindMatch[] }
  const api = {
    getBook: vi.fn(async () => makeBook(options.session ?? null)),
    getChapter: vi.fn(async (_id: string, index: number) => chapters[index]),
    saveSession: vi.fn(async () => ({}) as never),
    bookmarks: vi.fn(async () => []),
    addBookmark: vi.fn(),
    notes: vi.fn(async () => []),
    addNote: vi.fn(async (_id: string, chunk_id: number, sentence_index: number, text: string): Promise<Note> => ({
      id: Math.random(), chunk_id, sentence_index, text, chapter_index: 0, chapter: 'Chapter 1: Paging', section: '', page: 1, quote: '',
    })),
    find: vi.fn(async () => ({ matches: search.matches })),
    quiz: vi.fn(),
    quizCheck: vi.fn(),
    askStream: vi.fn(),
  }
  const exportNotes = vi.fn(async () => undefined)
  const controller = new AudiobookController({
    api: api as unknown as ControllerDeps['api'], tts, stt,
    earcons: { play: () => undefined, startThinking: () => undefined, stopThinking: () => undefined },
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    voice: (role) => ({ rate: settings.rate, volume: 1, pitch: role === 'assistant' ? ASSISTANT_PITCH : 1 }),
    announce: (text) => announced.push(text),
    now: () => clock.ms,
    mode: options.mode,
    exportNotes,
  })
  const state = () => controller.getState()
  /** Let the narrator read on until it is reading `text`. */
  const readTo = (text: string) => {
    for (let i = 0; i < 40 && tts.narrating !== text; i++) tts.endNarration()
    expect(tts.narrating).toBe(text)
  }
  /** Open the book, start reading, and stop part-way through the first sentence. Returns where. */
  const startMidSentence = async () => {
    await controller.load('os')
    controller.play()
    readTo(LEAD[0])
    const offset = LEAD[0].indexOf('need')
    tts.boundary(offset)
    clock.ms += 4000 // long enough that earlier headings are not mistaken for an echo
    return offset
  }
  return { controller, tts, stt, api, settings, clock, announced, search, exportNotes, state, readTo, startMidSentence }
}

const FROM_NEED = 'need for contiguous allocation.'

describe('table of contents', () => {
  it('reads the chapters and the sections of the current chapter aloud, then carries on reading', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('read the contents')
    await until(() => ctx.tts.narrating === FROM_NEED, 'reading to resume')
    expect(ctx.tts.said('assistant').join(' ')).toContain('Operating Systems has 2 chapters. Chapter 1: Paging. Chapter 2: Virtual Memory.')

    ctx.stt.final('what sections are in this chapter')
    await until(() => ctx.tts.said('assistant').some((t) => t.includes('has 2 sections: Pages and Frames. The Page Table.')), 'sections')
  })

  it('goes to a section by name in another chapter, and returns to the exact word', async () => {
    const ctx = setup()
    const offset = await ctx.startMidSentence()
    ctx.stt.final('go to the section on page faults')
    await until(() => ctx.tts.narrating === 'Page Faults', 'the narrator to read the heading')
    expect(ctx.api.getChapter).toHaveBeenCalledWith('os', 1)
    expect(ctx.state()).toMatchObject({ chapterIndex: 1, canReturn: true })

    ctx.readTo(FAULTS[0])
    ctx.clock.ms += 4000
    ctx.stt.final('return to my place')
    await until(() => ctx.tts.narrating === FROM_NEED, 'reading to resume at the old place')
    expect(ctx.tts.said('assistant')).toContain('Back at your place.')
    expect(ctx.state()).toMatchObject({ chapterIndex: 0, index: 1, charOffset: offset, canReturn: false })
  })

  it('browsing through several sections still remembers the place originally left', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    await ctx.controller.command({ type: 'nav', unit: 'section', delta: 1 }, 'key')
    expect(ctx.tts.narrating).toBe('Pages and Frames')
    await ctx.controller.command({ type: 'nav', unit: 'section', delta: 1 }, 'key')
    expect(ctx.tts.narrating).toBe('The Page Table')
    void ctx.controller.command({ type: 'return' }, 'key')
    await until(() => ctx.tts.narrating === FROM_NEED, 'return')
    expect(ctx.state().canReturn).toBe(false)
  })

  it('goes to a page, and says so when the page does not exist', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('go to page 3')
    await until(() => ctx.tts.narrating === FAULTS[0], 'page 3')
    expect(ctx.tts.said('assistant')).toContain('Page 3.')

    ctx.stt.final('go to page 9')
    await until(() => ctx.tts.said('assistant').includes('This book has pages 1 to 4.'), 'out-of-range message')
    await until(() => ctx.tts.narrating !== null, 'reading to continue')
    expect(ctx.state().chapterIndex).toBe(1)
  })

  it('a heading picked on screen while paused is announced and leaves the book paused', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    await ctx.controller.pause()
    await ctx.controller.gotoHeading(0, 'The Page Table', 'touch')
    expect(ctx.tts.said('assistant')).toContain('The Page Table')
    expect(ctx.state()).toMatchObject({ phase: 'PAUSED', index: 8 })
    expect(ctx.tts.narrating).toBeNull()
  })
})

describe('find in the book', () => {
  it('searches, jumps to the matching sentence, keeps reading, and can come back', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('find where it talks about page faults')
    await until(() => ctx.tts.narrating === FAULTS[1], 'reading from the match')
    expect(ctx.api.find).toHaveBeenCalledWith('os', 'page faults')
    expect(ctx.tts.said('assistant')).toEqual([
      'Looking for page faults.', 'Found in Page Faults, page 3. Say "return to my place" when you want to go back.'])
    expect(ctx.state().trace.map((t) => t.phase).slice(-3)).toEqual(['PLAYING', 'RETRIEVING', 'PLAYING'])

    ctx.clock.ms += 4000
    ctx.stt.final('return to my place')
    await until(() => ctx.tts.narrating === FROM_NEED, 'return')
  })

  it('says so when nothing matches, and carries on from the same word', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.search.matches = []
    ctx.stt.final('find photosynthesis')
    await until(() => ctx.tts.narrating === FROM_NEED, 'reading to resume')
    expect(ctx.tts.said('assistant')).toContain("I couldn't find anything about photosynthesis in this book.")
    expect(ctx.state().canReturn).toBe(false)
  })

  it('"find" on its own asks what to look for', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    void ctx.controller.command({ type: 'find', query: '' }, 'key')
    await until(() => ctx.state().mic === 'question', 'microphone to open')
    expect(ctx.tts.said('assistant')).toEqual(['What should I look for?'])
    expect(ctx.state().listeningFor).toBe('search')
    ctx.stt.final('the valid bit')
    await until(() => ctx.api.find.mock.calls.length === 1, 'search request')
    expect(ctx.api.find).toHaveBeenCalledWith('os', 'the valid bit')
  })

  it('"go to the part about ..." falls back to searching the text when no heading matches', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('go to the part about the valid bit')
    await until(() => ctx.api.find.mock.calls.length === 1, 'search request')
    expect(ctx.api.find).toHaveBeenCalledWith('os', 'the valid bit')
  })

  it('a failed search is explained and returns to the book', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.api.find.mockRejectedValueOnce(new Error('search is down'))
    ctx.stt.final('find the valid bit')
    await until(() => ctx.tts.narrating === FROM_NEED, 'reading to resume')
    expect(ctx.state().trace.map((t) => t.phase)).toContain('RAG_FAILED')
    expect(ctx.tts.said('assistant')).toContain("I couldn't search your textbook just now. Please try again.")
  })
})

describe('skimming', () => {
  it('reads headings and only the first sentence of each paragraph, across chapters', async () => {
    const ctx = setup()
    await ctx.controller.load('os')
    ctx.controller.play()
    ctx.stt.final('skim')
    await until(() => ctx.state().skim && ctx.tts.narrating !== null, 'skimming to start')
    expect(ctx.tts.said('assistant')[0]).toContain('I will read the first sentence of each paragraph')

    const heard: string[] = []
    for (let i = 0; i < 8; i++) {
      heard.push(ctx.tts.narrating!)
      ctx.tts.endNarration()
    }
    expect(heard).toEqual(['Chapter 1: Paging', LEAD[0], 'Pages and Frames', FRAMES[0], FRAMES[2], 'The Page Table', TABLE[0], TABLE[1]])
    await until(() => ctx.tts.narrating === 'Chapter 2: Virtual Memory', 'the next chapter')
  })

  it('"read this part" goes back to the start of the paragraph and reads everything from there', async () => {
    const ctx = setup()
    await ctx.controller.load('os')
    await ctx.controller.command({ type: 'skim', on: true }, 'key') // while paused: starts reading too
    expect(ctx.state().phase).toBe('PLAYING')
    ctx.readTo(FRAMES[2])
    ctx.tts.boundary(6)
    ctx.stt.final('read this part')
    await until(() => !ctx.state().skim && ctx.tts.narrating === FRAMES[2], 'full reading from the paragraph start')
    ctx.tts.endNarration()
    expect(ctx.tts.narrating).toBe(FRAMES[3]) // a sentence skimming would have skipped
  })
})

describe('sleep timer', () => {
  it('"stop at the end of this section" stops exactly at the section boundary', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('stop at the end of this section')
    await until(() => ctx.state().sleepAt === 'section' && ctx.tts.narrating === FROM_NEED, 'timer set')
    expect(ctx.tts.said('assistant')).toContain('I will stop at the end of this section.')

    ctx.tts.endNarration()
    expect(ctx.tts.narrating).toBe(LEAD[1]) // still inside the section
    ctx.tts.endNarration()
    await until(() => ctx.state().phase === 'PAUSED', 'the book to stop')
    expect(ctx.tts.said('assistant')).toContain('Sleep timer. Paused. Your place is saved.')
    expect(ctx.state()).toMatchObject({ index: 3, charOffset: 0, sleepAt: null })

    ctx.controller.toggle('key')
    expect(ctx.tts.narrating).toBe('Pages and Frames') // carries on from the next section
  })

  it('a timed sleep finishes the sentence before stopping', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    await ctx.controller.command({ type: 'sleep', seconds: 60 }, 'key')
    expect(ctx.tts.said('assistant')).toContain('Sleep timer set for 60 seconds.')
    ctx.tts.endNarration()
    expect(ctx.tts.narrating).toBe(LEAD[1]) // not yet
    ctx.clock.ms += 61_000
    ctx.tts.endNarration()
    await until(() => ctx.state().phase === 'PAUSED', 'the book to stop')
    expect(ctx.state()).toMatchObject({ index: 3, sleepUntil: null })
  })

  it('a timer that ran out while the listener was busy does not stop the book the moment it restarts', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    await ctx.controller.command({ type: 'sleep', seconds: 60 }, 'key')
    await ctx.controller.pause()
    ctx.clock.ms += 61_000
    ctx.controller.play()
    ctx.readTo(FRAMES[0])
    expect(ctx.state()).toMatchObject({ phase: 'PLAYING', sleepUntil: null })
  })

  it('the button cycles 15, 30 and 60 minutes, end of chapter, off', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await ctx.startMidSentence()
    const minutes = () => Math.round(((ctx.state().sleepUntil ?? ctx.clock.ms) - ctx.clock.ms) / 60_000)
    await ctx.controller.cycleSleep('key')
    expect(minutes()).toBe(15)
    await ctx.controller.cycleSleep('key')
    expect(minutes()).toBe(30)
    await ctx.controller.cycleSleep('key')
    expect(minutes()).toBe(60)
    await ctx.controller.cycleSleep('key')
    expect(ctx.state()).toMatchObject({ sleepUntil: null, sleepAt: 'chapter' })
    await ctx.controller.cycleSleep('key')
    expect(ctx.state()).toMatchObject({ sleepUntil: null, sleepAt: null })
  })
})

describe('notes', () => {
  it('"note that ..." saves the words at the sentence being read and carries on', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('Note that paging has no external fragmentation')
    await until(() => ctx.tts.narrating === FROM_NEED, 'reading to resume')
    expect(ctx.api.addNote).toHaveBeenCalledWith('os', 1, 0, 'paging has no external fragmentation')
    expect(ctx.tts.said('assistant')).toEqual(['Note saved.'])
    expect(ctx.state().notes).toHaveLength(1)
  })

  it('"take a note" listens for the note, saves it, and resumes on the same word', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    void ctx.controller.command({ type: 'note', text: '' }, 'key')
    await until(() => ctx.state().mic === 'question', 'microphone to open')
    expect(ctx.tts.said('assistant')).toEqual(['What would you like to note?'])
    expect(ctx.tts.narrating).toBeNull()

    ctx.stt.final('check the valid bit before the exam')
    await until(() => ctx.tts.narrating === FROM_NEED, 'reading to resume')
    expect(ctx.api.addNote).toHaveBeenCalledWith('os', 1, 0, 'Check the valid bit before the exam')
    expect(ctx.tts.said('assistant').slice(1)).toEqual(['Note saved.', 'Continuing from where you stopped.'])

    ctx.stt.final('read my notes')
    await until(() => ctx.tts.said('assistant').some((t) => t.startsWith('You have 1 note in this book. 1: Check the valid bit before the exam.')), 'notes read out')
  })

  it('the narrator reading "Note that ..." aloud never creates a note', async () => {
    const ctx = setup()
    await ctx.controller.load('os')
    ctx.controller.play()
    ctx.readTo(LEAD[1])
    ctx.stt.final('note that paging is used by almost every operating system')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ctx.api.addNote).not.toHaveBeenCalled()
    expect(ctx.tts.narrating).toBe(LEAD[1])
  })

  it('exports the study sheet and says so', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('export my notes')
    await until(() => ctx.tts.narrating === FROM_NEED, 'reading to resume')
    expect(ctx.exportNotes).toHaveBeenCalledOnce()
    expect(ctx.tts.said('assistant')).toEqual(['Your study notes have been downloaded as a text file.'])
  })
})

describe('coming back to a book', () => {
  it('says where you are, then starts from the beginning of the sentence', async () => {
    const ctx = setup({ session: { started: true, chapter_index: 0, chunk_id: 2, sentence_index: 1, character_offset: 12 } })
    await ctx.controller.load('os')
    expect(ctx.state()).toMatchObject({ phase: 'PAUSED', index: 5, charOffset: 0 })
    await ctx.controller.begin()
    expect(ctx.tts.said('assistant')).toEqual(['Continuing Operating Systems. Chapter 1: Paging. Pages and Frames.'])
    expect(ctx.tts.narrating).toBe(FRAMES[1])
  })

  it('a new book just starts reading', async () => {
    const ctx = setup()
    await ctx.controller.load('os')
    await ctx.controller.begin()
    expect(ctx.tts.said('assistant')).toEqual([])
    expect(ctx.tts.narrating).toBe('Chapter 1: Paging')
  })
})

describe('talking without losing the place', () => {
  it('voicing a focused control pauses the book and resumes on the same word', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    await ctx.controller.speakAside('Ask a question, button')
    expect(ctx.tts.said('assistant')).toEqual(['Ask a question, button'])
    expect(ctx.tts.narrating).toBe(FROM_NEED)
  })

  it('a loosely worded command after barge-in is carried out and reading continues', async () => {
    const ctx = setup()
    await ctx.controller.load('os')
    ctx.controller.play()
    ctx.readTo(FRAMES[1])
    ctx.tts.boundary(8)
    ctx.clock.ms += 4000
    ctx.stt.interim('take me back')
    expect(ctx.tts.narrating).toBeNull() // the narrator stopped as soon as the student spoke
    ctx.stt.final('take me back a little')
    await until(() => ctx.tts.narrating !== null, 'reading to continue')
    expect(ctx.state().index).toBeLessThan(5)
  })

  it('two requests in quick succession end with the book reading once, from the same word', async () => {
    const ctx = setup()
    await ctx.startMidSentence()
    ctx.stt.final('where am i')
    ctx.stt.final('faster')
    await until(() => ctx.settings.rate === 1.25 && ctx.tts.narrating === FROM_NEED, 'both handled')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ctx.tts.narrating).toBe(FROM_NEED) // nothing restarted or cut the narrator off afterwards
    expect(ctx.tts.said('narrator').filter((t) => t === FROM_NEED)).toHaveLength(1)
  })
})

describe('evaluation trials', () => {
  it('System B keeps its voice but not the study tools, so the trial measures one interaction', async () => {
    const ctx = setup({ mode: { assistant: true, voice: true, persist: false, studyTools: false } })
    await ctx.startMidSentence()
    expect(ctx.state().mic).toBe('commands')
    ctx.stt.final('find where it talks about page faults')
    ctx.stt.final('skim')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ctx.api.find).not.toHaveBeenCalled()
    expect(ctx.state()).toMatchObject({ skim: false, phase: 'PLAYING' })

    await ctx.controller.command({ type: 'nav', unit: 'section', delta: 1 }, 'key') // ordinary navigation still works...
    expect(ctx.tts.narrating).toBe('Pages and Frames')
    expect(ctx.state().canReturn).toBe(false) // ...but there is no "return to my place" to lean on
  })
})

describe('System A (traditional audiobook baseline)', () => {
  it('has none of the study tools', async () => {
    const ctx = setup({ mode: { assistant: false, voice: false, persist: false } })
    await ctx.controller.load('os')
    ctx.controller.play()
    ctx.readTo(LEAD[0])
    for (const intent of [{ type: 'find', query: 'paging' }, { type: 'skim', on: true }, { type: 'note', text: 'x' },
      { type: 'gotoSection', name: 'page faults' }, { type: 'contents' }, { type: 'return' }, { type: 'sleep', seconds: 60 }] as const) {
      await ctx.controller.command(intent, 'typed')
    }
    await ctx.controller.gotoHeading(1, 'Page Faults', 'touch')
    expect(ctx.api.find).not.toHaveBeenCalled()
    expect(ctx.api.addNote).not.toHaveBeenCalled()
    expect(ctx.state()).toMatchObject({ skim: false, chapterIndex: 0, canReturn: false, sleepUntil: null })
    expect(ctx.announced.filter((a) => a === 'That is not available in this mode.')).toHaveLength(7)
    expect(ctx.tts.narrating).toBe(LEAD[0])
  })
})
