import { describe, expect, it } from 'vitest'
import { isCommand, parseIntent } from './intents'
import { closest, stems, titleScore } from './text'

describe('study-tool commands', () => {
  it.each([
    ['take a note', { type: 'note', text: '' }],
    ['make a note', { type: 'note', text: '' }],
    ['Note that the TLB is a cache', { type: 'note', text: 'the TLB is a cache' }],
    ['Please take a note: revise Belady before Friday', { type: 'note', text: 'revise Belady before Friday' }],
    ['read my notes', { type: 'readNotes' }],
    ['export my notes', { type: 'exportNotes' }],
    ['download my study notes', { type: 'exportNotes' }],
    ['what did I ask', { type: 'reviewQuestions' }],
    ['review my questions', { type: 'reviewQuestions' }],
    ['read the contents', { type: 'contents' }],
    ['table of contents', { type: 'contents' }],
    ['what chapters are there', { type: 'contents' }],
    ['what sections are in this chapter', { type: 'sections' }],
    ['return to my place', { type: 'return' }],
    ['take me back to where I was', { type: 'return' }],
    ['go back to where I was', { type: 'return' }],
    ['skim', { type: 'skim', on: true }],
    ['skim this section', { type: 'skim', on: true }],
    ['start skimming', { type: 'skim', on: true }],
    ['stop skimming', { type: 'skim', on: false }],
    ['read normally', { type: 'skim', on: false }],
    ['read this part', { type: 'skim', on: false }],
    ['sleep timer 15 minutes', { type: 'sleep', seconds: 900 }],
    ['sleep timer twenty', { type: 'sleep', seconds: 1200 }],
    ['stop reading in ten minutes', { type: 'sleep', seconds: 600 }],
    ['set a timer for half an hour', { type: 'sleep', seconds: 1800 }],
    ['stop at the end of this chapter', { type: 'sleep', at: 'chapter' }],
    ['pause after this section', { type: 'sleep', at: 'section' }],
    ['cancel the sleep timer', { type: 'sleep', off: true }],
    ['find', { type: 'find', query: '' }],
    ['find where it talks about the dirty bit', { type: 'find', query: 'the dirty bit' }],
    ['search for thrashing', { type: 'find', query: 'thrashing' }],
    ['look for the part about demand paging', { type: 'find', query: 'demand paging' }],
    ['Where does it explain demand paging?', { type: 'find', query: 'demand paging' }],
    ['where is the working set defined', { type: 'find', query: 'the working set' }],
    ['go to page 12', { type: 'gotoPage', page: 12 }],
    ['turn to page seven', { type: 'gotoPage', page: 7 }],
    ['go to the section on page faults', { type: 'gotoSection', name: 'page faults', unit: 'section' }],
    ['take me to the chapter about virtual memory', { type: 'gotoSection', name: 'virtual memory', unit: 'chapter' }],
    ['jump to thrashing', { type: 'gotoSection', name: 'thrashing', unit: 'section' }],
    ['open the section called The Page Table', { type: 'gotoSection', name: 'the page table', unit: 'section' }],
  ])('%s', (phrase, expected) => {
    expect(parseIntent(phrase)).toEqual(expected)
  })

  it('"go to ..." still means what it meant before', () => {
    expect(parseIntent('go to chapter three')).toEqual({ type: 'gotoChapter', number: 3 })
    expect(parseIntent('take me to chapter two')).toEqual({ type: 'gotoChapter', number: 2 })
    expect(parseIntent('go to the next section')).toEqual({ type: 'nav', unit: 'section', delta: 1 })
    expect(parseIntent('go to my bookmark')).toEqual({ type: 'gotoBookmark' })
    expect(parseIntent('take me back to my bookmark')).toEqual({ type: 'gotoBookmark' })
    expect(parseIntent('go to settings')).toEqual({ type: 'goto', page: 'settings' })
    expect(parseIntent('go to my books')).toEqual({ type: 'library' })
    expect(parseIntent("let's go back to the book")).toEqual({ type: 'resume' })
    expect(parseIntent('go back 30 seconds')).toEqual({ type: 'seek', seconds: -30 })
    expect(parseIntent('where am I')).toEqual({ type: 'where' })
    expect(parseIntent('stop')).toEqual({ type: 'stop' })
  })

  it('understands looser wording too', () => {
    expect(parseIntent('could you make a quick note for me')).toEqual({ type: 'note', text: '' })
    expect(parseIntent('I need a timer')).toEqual({ type: 'sleep', seconds: 900 })
    expect(parseIntent('wake me in about twenty minutes with the timer')).toEqual({ type: 'sleep', seconds: 1200 })
    expect(parseIntent('I want to skim through it')).toEqual({ type: 'skim', on: true })
    expect(parseIntent("that's enough skimming")).toEqual({ type: 'skim', on: false })
    expect(parseIntent('take me back to my place please')).toEqual({ type: 'return' })
  })

  it('does not trust commands that carry free text while the narrator is speaking', () => {
    // The narrator may well say "Note that ..." or "Find the frame ...": these must pass the echo filter first.
    for (const phrase of ['note that the offset is not changed', 'find the frame that holds the page', 'go to the section on paging', 'define a page']) {
      expect(isCommand(parseIntent(phrase))).toBe(false)
    }
    for (const phrase of ['take a note', 'skim', 'return to my place', 'read the contents', 'cancel the sleep timer', 'go to page 4']) {
      expect(isCommand(parseIntent(phrase))).toBe(true)
    }
  })

  it('still treats questions about the book as questions', () => {
    for (const question of ['What is in a page table entry?', 'Why do we need a timer interrupt?', 'How does the book define a note?',
      'What is the difference between a section and a segment?']) {
      expect(parseIntent(question)).toMatchObject({ type: 'qa', intent: 'question' })
    }
  })
})

describe('matching what was said against titles', () => {
  it('reduces words to stems so plurals and small words do not matter', () => {
    expect(stems('The Pages and the Frames')).toEqual(['page', 'frame'])
    expect(stems('Thrashing and the Working Set')).toEqual(['thrash', 'work', 'set'])
    expect(stems('processes')).toEqual(['process'])
  })

  it('scores a spoken phrase against a title', () => {
    expect(titleScore('page faults', 'Page Faults')).toBe(1)
    expect(titleScore('the page fault section', 'Page Faults')).toBeGreaterThan(0.7)
    expect(titleScore('thrashing', 'Thrashing and the Working Set')).toBe(0.5)
    expect(titleScore('the valid bit', 'The Page Table')).toBe(0)
  })

  it('picks the closest title, preferring earlier options on a tie, and nothing when none is close', () => {
    const titles = ['Pages and Frames', 'The Page Table', 'Page Faults', 'What Is Virtual Memory?']
    const pick = (said: string) => closest(said, titles, (t) => t)
    expect(pick('page faults')).toBe('Page Faults')
    expect(pick('the page table')).toBe('The Page Table')
    expect(pick('virtual memory')).toBe('What Is Virtual Memory?')
    expect(pick('operating system')).toBeUndefined()
    expect(closest('operating system', ['Operating Systems', 'Data Structures'], (t) => t)).toBe('Operating Systems')
  })
})
