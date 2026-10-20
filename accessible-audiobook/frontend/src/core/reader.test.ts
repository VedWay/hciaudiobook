import { describe, expect, it } from 'vitest'
import type { ChapterContent } from '../types'
import { buildItems, Reader, wordStart } from './reader'
import type { SpeakCallbacks, TTSEngine } from './tts'

const chapter: ChapterContent = {
  id: 1, index: 0, title: 'Chapter 2: Paging',
  sections: [
    { id: 1, index: 0, title: '', chunks: [{ id: 10, chunk_index: 0, page: 3, sentences: ['Paging removes the need for contiguous allocation.'] }] },
    { id: 2, index: 1, title: 'Pages and Frames', chunks: [
      { id: 11, chunk_index: 1, page: 3, sentences: ['Physical memory is divided into frames.', 'Logical memory is divided into pages.'] },
      { id: 12, chunk_index: 2, page: 4, sentences: ['Any free frame can hold any page.'] },
    ] },
    { id: 3, index: 2, title: 'The Page Table', chunks: [{ id: 13, chunk_index: 3, page: 4, sentences: ['Every process has its own page table.'] }] },
  ],
}

function makeReader() {
  const spoken: string[] = []
  let callbacks: SpeakCallbacks | null = null
  let ended = 0
  const tts: TTSEngine = {
    kind: 'browser',
    speak: (text, _options, cb) => { spoken.push(text); callbacks = cb },
    cancel: () => { callbacks = null },
  }
  const reader = new Reader(tts, () => ({ rate: 1, volume: 1 }), {
    onPosition: () => undefined, onItemStart: () => undefined, onChapterEnd: () => { ended++ }, onError: () => undefined,
  })
  reader.load(buildItems(chapter))
  return { reader, spoken, end: () => callbacks?.onEnd(), boundary: (i: number) => callbacks?.onBoundary?.(i), ended: () => ended }
}

describe('buildItems', () => {
  it('reads the chapter title, then section headings, then sentences, in order', () => {
    const items = buildItems(chapter)
    expect(items.map((i) => i.kind)).toEqual(['chapter', 'sentence', 'section', 'sentence', 'sentence', 'sentence', 'section', 'sentence'])
    expect(items[2]).toMatchObject({ text: 'Pages and Frames', chunkId: 11, sentenceIndex: 0 })
    expect(items[1].startChar).toBe('Chapter 2: Paging'.length + 1)
  })
})

describe('Reader', () => {
  it('tracks the word being spoken and resumes from it', () => {
    const { reader, spoken, end, boundary } = makeReader()
    reader.play()
    end()
    const sentence = reader.current!.text
    boundary(sentence.indexOf('need'))
    reader.pause()
    expect(reader.charOffset).toBe(sentence.indexOf('need'))
    reader.play()
    expect(spoken[spoken.length - 1]).toBe('need for contiguous allocation.')
    boundary(5) // offsets from a resumed utterance are relative to where it started
    expect(reader.charOffset).toBe(sentence.indexOf('for'))
  })

  it('finds a saved (chunk, sentence) position', () => {
    const { reader } = makeReader()
    expect(reader.items[reader.indexOf(11, 1)].text).toBe('Logical memory is divided into pages.')
    expect(reader.items[reader.indexOf(11, 0)].kind).toBe('sentence') // not the heading that shares its chunk
  })

  it('seeks by time onto sentence starts and clamps at the chapter edges', () => {
    const { reader } = makeReader()
    reader.seekTo(4)
    expect(reader.seekSeconds(-3, 1)).toBe('ok') // ~45 characters back
    expect(reader.index).toBeLessThan(4)
    expect(reader.charOffset).toBe(0)
    expect(reader.seekSeconds(-600, 1)).toBe('start')
    expect(reader.index).toBe(0)
    expect(reader.seekSeconds(1, 1)).toBe('ok')
    expect(reader.index).toBe(1) // always moves forward at least one sentence
    expect(reader.seekSeconds(600, 1)).toBe('end')
  })

  it('steps by section and paragraph', () => {
    const { reader } = makeReader()
    reader.seekTo(4)
    expect(reader.stepUnit('section', 1)).toBe(true)
    expect(reader.current!.text).toBe('The Page Table')
    expect(reader.stepUnit('section', 1)).toBe(false) // no further section in this chapter
    reader.seekTo(4)
    reader.stepUnit('section', -1) // from the middle: back to the start of this section
    expect(reader.current!.text).toBe('Pages and Frames')
    reader.stepUnit('section', -1)
    expect(reader.index).toBe(0)
    reader.seekTo(3)
    reader.stepUnit('paragraph', 1)
    expect(reader.current!.chunkId).toBe(12)
  })

  it('repeat restarts the sentence, or the previous one if this one has only just begun', () => {
    const { reader, boundary } = makeReader()
    reader.seekTo(4)
    reader.play()
    boundary(20)
    reader.repeat()
    expect([reader.index, reader.charOffset]).toEqual([4, 0])
    reader.repeat()
    expect(reader.index).toBe(3)
  })

  it('signals the end of the chapter and stays on a real position', () => {
    const { reader, end, ended } = makeReader()
    reader.seekTo(reader.items.length - 1)
    reader.play()
    end()
    expect(ended()).toBe(1)
    expect(reader.playing).toBe(false)
    expect(reader.current!.text).toBe('Every process has its own page table.')
  })
})

describe('wordStart', () => {
  it('snaps to the beginning of the word containing the offset', () => {
    expect(wordStart('more memory than', 7)).toBe(5)
    expect(wordStart('more memory than', 5)).toBe(5)
    expect(wordStart('more memory than', 0)).toBe(0)
  })
})
