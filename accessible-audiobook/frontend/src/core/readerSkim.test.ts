import { describe, expect, it } from 'vitest'
import type { ChapterContent } from '../types'
import { buildItems, Reader, type ReaderEvents, type ReadItem } from './reader'
import type { SpeakCallbacks, TTSEngine } from './tts'

// Section "Frames" has two paragraphs of two sentences; "Tables" has one paragraph of three.
const chapter: ChapterContent = {
  id: 1, index: 0, title: 'Chapter 2: Paging',
  sections: [
    { id: 1, index: 0, title: 'Frames', chunks: [
      { id: 10, chunk_index: 0, page: 1, sentences: ['A one.', 'A two.', 'B one.', 'B two.'], paragraph_starts: [0, 2] },
    ] },
    { id: 2, index: 1, title: 'Tables', chunks: [
      { id: 11, chunk_index: 1, page: 2, sentences: ['C one.', 'C two.'], paragraph_starts: [0] },
      { id: 12, chunk_index: 2, page: 2, sentences: ['C three.'], paragraph_starts: [] }, // the paragraph continues
    ] },
  ],
}

function makeReader(events: Partial<ReaderEvents> = {}) {
  const spoken: string[] = []
  let callbacks: SpeakCallbacks | null = null
  let ended = 0
  let skips = 0
  const tts: TTSEngine = {
    kind: 'browser',
    speak: (text, _options, cb) => { spoken.push(text); callbacks = cb },
    cancel: () => { callbacks = null },
  }
  const reader = new Reader(tts, () => ({ rate: 1, volume: 1 }), {
    onPosition: () => undefined, onItemStart: () => undefined, onChapterEnd: () => { ended++ }, onError: () => undefined,
    onSkip: () => { skips++ }, ...events,
  })
  reader.load(buildItems(chapter))
  const readAll = () => {
    reader.play()
    for (let i = 0; i < 30 && reader.playing; i++) callbacks?.onEnd()
    return spoken
  }
  return { reader, spoken, readAll, end: () => callbacks?.onEnd(), ended: () => ended, skips: () => skips }
}

describe('paragraph boundaries', () => {
  it('marks the first sentence of each paragraph', () => {
    const starts = buildItems(chapter).filter((item) => item.paragraphStart).map((item) => item.text)
    expect(starts).toEqual(['A one.', 'B one.', 'C one.'])
  })

  it('treats a chunk with no boundary information as one paragraph', () => {
    const legacy: ChapterContent = { id: 1, index: 0, title: 'T', sections: [{ id: 1, index: 0, title: '', chunks: [{ id: 1, chunk_index: 0, page: 0, sentences: ['One.', 'Two.'] }] }] }
    expect(buildItems(legacy).filter((item) => item.paragraphStart).map((item) => item.text)).toEqual(['One.'])
  })
})

describe('skimming', () => {
  it('normally reads everything', () => {
    const { readAll, skips } = makeReader()
    expect(readAll()).toEqual(['Chapter 2: Paging', 'Frames', 'A one.', 'A two.', 'B one.', 'B two.', 'Tables', 'C one.', 'C two.', 'C three.'])
    expect(skips()).toBe(0)
  })

  it('reads headings and the first sentence of each paragraph, signalling each skip', () => {
    const { reader, readAll, skips, ended } = makeReader()
    reader.skim = true
    expect(readAll()).toEqual(['Chapter 2: Paging', 'Frames', 'A one.', 'B one.', 'Tables', 'C one.'])
    expect(skips()).toBe(2) // after "A one." and after "B one."; the end of the chapter is not a skip
    expect(ended()).toBe(1)
  })

  it('can be switched on and off in mid-chapter', () => {
    const { reader, spoken, end } = makeReader()
    reader.play() // chapter title
    end() // Frames
    end() // A one.
    reader.skim = true
    end()
    expect(spoken[spoken.length - 1]).toBe('B one.')
    reader.skim = false
    end()
    expect(spoken[spoken.length - 1]).toBe('B two.')
  })

  it('finds the start of the paragraph being read, even when it began in an earlier chunk', () => {
    const { reader } = makeReader()
    const indexOf = (text: string) => reader.items.findIndex((item) => item.text === text)
    reader.seekTo(indexOf('B two.'))
    expect(reader.items[reader.startOfParagraph()].text).toBe('B one.')
    reader.seekTo(indexOf('C three.'))
    expect(reader.items[reader.startOfParagraph()].text).toBe('C one.')
    reader.seekTo(indexOf('Tables'))
    expect(reader.items[reader.startOfParagraph()].text).toBe('Tables') // on a heading: stay there
  })

  it('steps by paragraph using the real boundaries', () => {
    const { reader } = makeReader()
    const at = () => reader.current!.text
    reader.seekTo(0)
    expect(reader.stepUnit('paragraph', 1)).toBe(true)
    expect(at()).toBe('A one.')
    reader.stepUnit('paragraph', 1)
    expect(at()).toBe('B one.')
    reader.stepUnit('paragraph', 1)
    expect(at()).toBe('C one.')
    expect(reader.stepUnit('paragraph', 1)).toBe(false) // no further paragraph in this chapter
    reader.seekTo(reader.items.findIndex((item) => item.text === 'C three.'))
    reader.stepUnit('paragraph', 0)
    expect(at()).toBe('C one.') // "restart this paragraph" from inside its continuation
  })
})

describe('stopping between sentences', () => {
  it('lets the controller end reading at a boundary, positioned on the next sentence', () => {
    const asked: [string, string][] = []
    const stopBeforeTables = (next: ReadItem, previous: ReadItem) => {
      asked.push([previous.text, next.text])
      return next.text !== 'Tables'
    }
    const { reader, readAll } = makeReader({ beforeItem: stopBeforeTables })
    expect(readAll()).toEqual(['Chapter 2: Paging', 'Frames', 'A one.', 'A two.', 'B one.', 'B two.'])
    expect(reader.playing).toBe(false)
    expect([reader.current!.text, reader.charOffset]).toEqual(['Tables', 0])
    expect(asked[asked.length - 1]).toEqual(['B two.', 'Tables'])

    reader.play() // carrying on does not ask again about the sentence it stopped at
    expect(reader.playing).toBe(true)
  })
})
