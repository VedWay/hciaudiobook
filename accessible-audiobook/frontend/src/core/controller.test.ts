/**
 * Tests of the central interaction - interrupt -> ask -> answer -> resume - using
 * fake speech engines, so the state machine is exercised without a browser voice
 * or a microphone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkError } from '../services/api'
import type { AskBody, AskEvent, BookDetail, ChapterContent } from '../types'
import { AudiobookController, type ControllerDeps, type Phase } from './controller'
import { ASSISTANT_PITCH, FakeSTT, FakeTTS, until } from './fakes'
import { DEFAULT_SETTINGS, type Settings } from './settings'

const TARGET = 'Virtual memory allows a process to use more memory than is physically available in the main memory.'
const NEXT = 'It does this by keeping only the parts of a program that are currently needed in RAM.'

const chapter: ChapterContent = {
  id: 3, index: 0, title: 'Chapter 3: Virtual Memory',
  sections: [{
    id: 31, index: 1, title: 'What Is Virtual Memory?',
    chunks: [{ id: 143, chunk_index: 20, page: 6, sentences: [TARGET, NEXT] }],
  }],
}
const book = {
  id: 'operating-systems', title: 'Operating Systems', status: 'ready', session: null,
  chapters: [{ id: 3, index: 0, title: chapter.title, start_page: 6, char_count: 200, sections: [] }],
} as unknown as BookDetail

const ANSWER: AskEvent[] = [
  { type: 'stage', stage: 'retrieving' },
  { type: 'sources', query: 'q', sources: [{ chunk_id: 143, chapter: chapter.title, section: 'What Is Virtual Memory?', page: 6, relation: 'current', score: 1 }] },
  { type: 'stage', stage: 'generating' },
  { type: 'sentence', text: 'Virtual memory lets a program use more memory than the computer really has.' },
  { type: 'sentence', text: 'It keeps the rest on disk.' },
  { type: 'done', answer: '', conversation_id: 'conv-1', grounded: true, provider: 'test', sources: [], timings: {} },
]

function setup(options: { settings?: Partial<Settings>; mode?: ControllerDeps['mode']; stream?: (body: AskBody) => AsyncGenerator<AskEvent>; interpret?: ControllerDeps['interpret'] } = {}) {
  const tts = new FakeTTS()
  const stt = new FakeSTT()
  const settings: Settings = { ...DEFAULT_SETTINGS, haptics: false, ...options.settings }
  const asked: AskBody[] = []
  const announced: string[] = []
  const logged: string[] = []
  const navigated: string[] = []
  const clock = { ms: 1_000_000 }
  const api = {
    getBook: vi.fn(async () => book),
    getChapter: vi.fn(async () => chapter),
    saveSession: vi.fn(async () => ({}) as never),
    bookmarks: vi.fn(async () => []),
    notes: vi.fn(async () => []),
    addNote: vi.fn(),
    find: vi.fn(),
    addBookmark: vi.fn(),
    quiz: vi.fn(),
    quizCheck: vi.fn(),
    askStream: (_bookId: string, body: AskBody) => {
      asked.push(body)
      return options.stream ? options.stream(body) : (async function* () { yield* ANSWER })()
    },
  }
  const controller = new AudiobookController({
    api: api as unknown as ControllerDeps['api'], tts, stt,
    earcons: { play: () => undefined, startThinking: () => undefined, stopThinking: () => undefined },
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    voice: (role) => ({ rate: settings.rate, volume: 1, pitch: role === 'assistant' ? ASSISTANT_PITCH : 1 }),
    announce: (text) => announced.push(text),
    log: (type) => logged.push(type),
    now: () => clock.ms,
    mode: options.mode,
    interpret: options.interpret,
    navigate: (page) => navigated.push(page),
  })
  const phases = () => controller.getState().trace.map((t) => t.phase)
  return { controller, tts, stt, api, asked, announced, logged, phases, settings, clock, navigated }
}

/** Start the book and read up to the word "than" in the target sentence. */
async function playToMidSentence(ctx: ReturnType<typeof setup>): Promise<number> {
  await ctx.controller.load(book.id)
  ctx.controller.play()
  expect(ctx.tts.narrating).toBe('Chapter 3: Virtual Memory')
  ctx.tts.endNarration() // chapter title
  ctx.tts.endNarration() // section heading
  expect(ctx.tts.narrating).toBe(TARGET)
  ctx.clock.ms += 4000 // a few seconds into the sentence: the headings are no longer echo candidates
  const offset = TARGET.indexOf('than')
  ctx.tts.boundary(offset)
  return offset
}

describe('interrupt -> ask -> answer -> resume', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => { ctx = setup() })

  it('answers a spoken question and resumes on the exact word', async () => {
    const offset = await playToMidSentence(ctx)
    ctx.stt.final('What is virtual memory?')
    await until(() => ctx.tts.narrating !== null && ctx.controller.getState().phase === 'PLAYING', 'reading to resume')

    // The retrieval request carried the reading context.
    expect(ctx.asked[0]).toMatchObject({
      question: 'What is virtual memory?', intent: 'question',
      context: { chapter: 'Chapter 3: Virtual Memory', section: 'What Is Virtual Memory?', page: 6, chunk_id: 143,
        sentence_index: 0, character_offset: offset, current_sentence: TARGET },
    })
    // The precise position was checkpointed at the moment of interruption.
    expect(ctx.api.saveSession).toHaveBeenCalledWith(book.id, expect.objectContaining({
      chunk_id: 143, sentence_index: 0, character_offset: offset, reason: 'interrupt', status: 'interrupted' }), false)
    // The user was told what was happening, heard the answer, and was told reading would continue.
    expect(ctx.tts.said('assistant')).toEqual([
      'Searching your textbook.',
      'Virtual memory lets a program use more memory than the computer really has.',
      'It keeps the rest on disk.',
      'Continuing from where you stopped.',
    ])
    // The narrator picked up from the interrupted word, not from the start of the sentence or the page.
    expect(ctx.tts.narrating).toBe('than is physically available in the main memory.')
    expect(ctx.phases()).toEqual([
      'IDLE', 'PLAYING', 'PAUSING', 'CAPTURE_CONTEXT', 'RETRIEVING', 'GENERATING', 'SPEAKING_ANSWER',
      'RESUME_CONFIRMATION', 'PLAYING'] satisfies Phase[])
    expect(ctx.controller.getState()).toMatchObject({ grounded: true, question: 'What is virtual memory?' })
    expect(ctx.logged).toEqual(expect.arrayContaining(['search_start', 'question', 'answer_found', 'resumed']))

    // Reading simply carries on to the next sentence.
    ctx.tts.endNarration()
    expect(ctx.tts.narrating).toBe(NEXT)
  })

  it('"ask a question" goes through LISTENING and TRANSCRIBING, then a follow-up keeps the conversation', async () => {
    await playToMidSentence(ctx)
    ctx.stt.final('ask a question')
    await until(() => ctx.controller.getState().mic === 'question', 'microphone to open')
    expect(ctx.tts.said('assistant')).toEqual(['Listening. Ask your question.'])
    expect(ctx.tts.narrating).toBeNull() // the book is silent while the student speaks

    ctx.stt.final('listening ask your question') // the recogniser hearing our own prompt is ignored
    expect(ctx.controller.getState().phase).toBe('LISTENING')
    ctx.stt.final('what is virtual memory')
    await until(() => ctx.controller.getState().phase === 'PLAYING' && ctx.tts.narrating !== null, 'resume')
    expect(ctx.phases().slice(2, 6)).toEqual(['PAUSING', 'CAPTURE_CONTEXT', 'LISTENING', 'TRANSCRIBING'])
    expect(ctx.asked[0].conversation_id).toBeNull()

    ctx.stt.final('Why is it needed?')
    await until(() => ctx.asked.length === 2, 'follow-up request')
    expect(ctx.asked[1]).toMatchObject({ question: 'Why is it needed?', conversation_id: 'conv-1' })
  })

  it('contextual commands skip listening and send the right intent', async () => {
    await playToMidSentence(ctx)
    ctx.stt.final('Explain this simply')
    await until(() => ctx.asked.length === 1, 'request')
    expect(ctx.asked[0]).toMatchObject({ intent: 'simplify', context: { current_sentence: TARGET } })
    expect(ctx.phases()).not.toContain('LISTENING')
  })

  it('"stay paused" keeps the book paused after the answer', async () => {
    const offset = await playToMidSentence(ctx)
    void ctx.controller.interrupt({ intent: 'question', question: 'What is virtual memory?' })
    void ctx.controller.command({ type: 'stayPaused' }, 'voice')
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause after answer')
    expect(ctx.tts.said('assistant')).not.toContain('Continuing from where you stopped.')
    expect(ctx.controller.getState().charOffset).toBe(offset)

    ctx.controller.toggle('key') // Space resumes from the same word
    expect(ctx.tts.narrating).toBe('than is physically available in the main memory.')
  })

  it('a question asked while paused does not start the book afterwards', async () => {
    await playToMidSentence(ctx)
    await ctx.controller.pause()
    await ctx.controller.interrupt({ intent: 'question', question: 'What is virtual memory?' })
    expect(ctx.controller.getState().phase).toBe('PAUSED')
    expect(ctx.tts.narrating).toBeNull()
  })
})

describe('resume modes', () => {
  it.each([
    ['sentence', TARGET],
    ['exact', 'than is physically available in the main memory.'],
  ] as const)('%s', async (resumeMode, expected) => {
    const ctx = setup({ settings: { resumeMode } })
    await playToMidSentence(ctx)
    await ctx.controller.interrupt({ intent: 'question', question: 'What is virtual memory?' })
    expect(ctx.tts.narrating).toBe(expected)
  })
})

describe('failures are spoken and recoverable', () => {
  it('NETWORK_ERROR: explains, then returns to the book at the same place', async () => {
    // eslint-disable-next-line require-yield
    const ctx = setup({ stream: async function* () { throw new NetworkError('down') } })
    await playToMidSentence(ctx)
    await ctx.controller.interrupt({ intent: 'question', question: 'What is virtual memory?' })
    expect(ctx.phases()).toContain('NETWORK_ERROR')
    expect(ctx.tts.said('assistant')).toContain("I can't reach the server. Check your internet connection and try again.")
    expect(ctx.controller.getState()).toMatchObject({ phase: 'PLAYING', error: { code: 'NETWORK_ERROR' } })
    expect(ctx.tts.narrating).toBe('than is physically available in the main memory.')
  })

  it.each(['RAG_FAILED', 'LLM_FAILED'] as const)('%s reported by the server', async (code) => {
    const ctx = setup({ stream: async function* () { yield { type: 'error', code, message: 'Spoken explanation.' } } })
    await playToMidSentence(ctx)
    await ctx.controller.interrupt({ intent: 'question', question: 'What is virtual memory?' })
    expect(ctx.phases()).toContain(code)
    expect(ctx.tts.said('assistant')).toContain('Spoken explanation.')
    expect(ctx.controller.getState().phase).toBe('PLAYING')
  })

  it('STT_FAILED: asks once more, then gives up gracefully', async () => {
    const ctx = setup({ settings: { micMode: 'push' } })
    await playToMidSentence(ctx)
    void ctx.controller.command({ type: 'ask' }, 'key')
    await until(() => ctx.stt.mode === 'single', 'first listen')
    ctx.stt.error('no-speech')
    await until(() => ctx.tts.said('assistant').includes("I didn't catch that. Please say it again.") && ctx.stt.mode === 'single', 'second listen')
    ctx.stt.error('no-speech')
    await until(() => ctx.controller.getState().phase === 'PLAYING', 'resume')
    expect(ctx.phases()).toContain('STT_FAILED')
    expect(ctx.tts.said('assistant')).toContain("I couldn't understand the question. Please try again.")
    expect(ctx.asked).toHaveLength(0)
  })

  it('TTS_FAILED: the answer stays on screen and the failure goes to the screen reader channel', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(ctx)
    ctx.tts.failAssistant = true
    await ctx.controller.interrupt({ intent: 'question', question: 'What is virtual memory?' })
    expect(ctx.phases()).toContain('TTS_FAILED')
    expect(ctx.controller.getState()).toMatchObject({ phase: 'PAUSED', error: { code: 'TTS_FAILED' } })
    expect(ctx.controller.getState().answer).toHaveLength(2)
    expect(ctx.announced.join(' ')).toContain('could not be spoken')
  })

  it('a blocked microphone falls back to a typed question', async () => {
    const ctx = setup({ settings: { micMode: 'push' } })
    await playToMidSentence(ctx)
    void ctx.controller.command({ type: 'ask' }, 'key')
    await until(() => ctx.stt.mode === 'single', 'listen')
    ctx.stt.error('not-allowed')
    await until(() => ctx.controller.getState().typedPrompt, 'typed prompt')
    ctx.controller.submitText('What is virtual memory?')
    await until(() => ctx.controller.getState().phase === 'PLAYING', 'resume')
    expect(ctx.asked[0].question).toBe('What is virtual memory?')
  })
})

describe('open microphone', () => {
  it('ignores the narrator being picked up by the microphone', async () => {
    const ctx = setup()
    await playToMidSentence(ctx)
    ctx.stt.final('a process to use more memory than is physically available')
    expect(ctx.controller.getState().phase).toBe('PLAYING')
    expect(ctx.tts.narrating).toBe(TARGET)
    expect(ctx.asked).toHaveLength(0)
  })

  it('a heading that was read moments ago is still treated as echo, but not once the recogniser lag has passed', async () => {
    const ctx = setup()
    await ctx.controller.load(book.id)
    ctx.controller.play()
    ctx.tts.endNarration() // chapter title
    ctx.tts.endNarration() // section heading "What Is Virtual Memory?" has just finished
    ctx.stt.final('what is virtual memory')
    expect(ctx.asked).toHaveLength(0)
    ctx.clock.ms += 4000
    ctx.stt.final('what is virtual memory')
    await until(() => ctx.asked.length === 1, 'request')
  })

  it('barge-in: pauses as soon as the student starts speaking, and resumes if it was not for us', async () => {
    const ctx = setup()
    const offset = await playToMidSentence(ctx)
    ctx.stt.interim('what is')
    expect(ctx.tts.narrating).toBeNull() // stopped talking over the student
    ctx.stt.final('what is for dinner mum')
    // Shaped like a question, so it is answered; a non-question would resume instead:
    await until(() => ctx.asked.length === 1, 'request')

    const other = setup()
    await playToMidSentence(other)
    other.stt.interim('yes mum')
    expect(other.tts.narrating).toBeNull()
    other.stt.final('yes mum I am coming')
    expect(other.tts.narrating).toBe('than is physically available in the main memory.')
    expect(other.controller.getState().charOffset).toBe(offset)
  })

  it('voice commands control playback', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(ctx)
    ctx.stt.final('pause')
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause')
    ctx.stt.final('continue reading')
    expect(ctx.tts.narrating).toBe('than is physically available in the main memory.')
    ctx.stt.final('repeat that')
    expect(ctx.tts.narrating).toBe(TARGET)
    ctx.stt.final('faster')
    await until(() => ctx.settings.rate === 1.25, 'speed change')
  })

  it.each(['continue', 'Continue.', 'okay continue', 'please carry on', 'you can go on now', 'continue from where I left off', 'hey could you keep reading'])(
    'after a pause, "%s" carries on from the same word, with spoken feedback on', async (phrase) => {
      const ctx = setup()
      await playToMidSentence(ctx)
      ctx.stt.final('pause')
      await until(() => ctx.controller.getState().phase === 'PAUSED' && ctx.tts.said('assistant').includes('Paused.'), 'pause')
      ctx.stt.final(phrase)
      await until(() => ctx.controller.getState().phase === 'PLAYING', 'reading to resume')
      expect(ctx.tts.narrating).toBe('than is physically available in the main memory.')
    })
})

describe('System A (traditional audiobook baseline)', () => {
  it('has no assistant and no microphone, and logs the search and resume moments', async () => {
    const ctx = setup({ mode: { assistant: false, voice: false, persist: false } })
    await playToMidSentence(ctx)
    expect(ctx.stt.mode).toBeNull()
    await ctx.controller.interrupt()
    expect(ctx.asked).toHaveLength(0)
    expect(ctx.controller.getState().phase).toBe('PLAYING')

    ctx.controller.toggle('key')
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause')
    ctx.controller.markAnswerFound()
    ctx.controller.toggle('key')
    expect(ctx.logged.filter((t) => t !== 'interaction')).toEqual(['search_start', 'answer_found', 'resumed'])
    expect(ctx.api.saveSession).not.toHaveBeenCalled()
  })
})

describe('conversational control', () => {
  it('changes settings by voice while reading, confirms aloud, and carries on from the same word', async () => {
    const ctx = setup()
    await playToMidSentence(ctx)
    ctx.stt.final('switch to the yellow theme')
    await until(() => ctx.settings.theme === 'yellow' && ctx.tts.narrating === 'than is physically available in the main memory.', 'theme change and resume')
    expect(ctx.tts.said('assistant')).toContain('Yellow on black.')
    expect(ctx.tts.narrating).toBe('than is physically available in the main memory.')

    ctx.stt.final('give me more detailed answers')
    await until(() => ctx.settings.answerLength === 'detailed' && ctx.tts.narrating !== null, 'answer length')
    ctx.stt.final('what are my settings')
    await until(() => ctx.tts.said('assistant').some((t) => t.includes('Reading speed 1 times')), 'settings read out')
  })

  it('navigates by voice and saves the place first', async () => {
    const ctx = setup()
    const offset = await playToMidSentence(ctx)
    ctx.stt.final('go to settings')
    await until(() => ctx.navigated.length === 1, 'navigation')
    expect(ctx.navigated).toEqual(['settings'])
    expect(ctx.api.saveSession).toHaveBeenLastCalledWith(book.id, expect.objectContaining({ character_offset: offset }), false)
  })

  it('asks the language model about phrases it does not recognise', async () => {
    const heard: string[] = []
    const ctx = setup({
      interpret: async (utterance) => {
        heard.push(utterance)
        if (utterance.includes('eyes')) return { kind: 'command', command: 'dark theme' }
        if (utterance.includes('thanks')) return { kind: 'reply', text: 'You are welcome.' }
        if (utterance.includes('disk')) return { kind: 'question', question: 'What role does the disk play in virtual memory?' }
        return { kind: 'ignore' }
      },
    })
    ctx.settings.theme = 'light'
    await playToMidSentence(ctx)

    ctx.stt.final('my eyes hurt it is too bright')
    await until(() => ctx.settings.theme === 'dark' && ctx.tts.narrating !== null, 'model-routed command')

    ctx.stt.final('thanks a lot mate')
    await until(() => ctx.tts.said('assistant').includes('You are welcome.') && ctx.tts.narrating !== null, 'model reply, then reading again')

    ctx.stt.interim('yes mum')
    ctx.stt.final('yes mum I am coming down now')
    await until(() => heard.length === 3 && ctx.tts.narrating !== null, 'ignored chatter resumes the book')
    expect(ctx.asked).toHaveLength(0)

    ctx.stt.final('so the disk thing is part of it then')
    await until(() => ctx.asked.length === 1, 'model-routed question')
    expect(ctx.asked[0].question).toBe('What role does the disk play in virtual memory?')
  })

  it('the model works out Hindi and Hinglish requests, and commands it is not needed for stay instant', async () => {
    const heard: string[] = []
    const ctx = setup({
      settings: { verbosity: 'earcons' },
      interpret: async (utterance) => {
        heard.push(utterance)
        if (utterance.includes('peeche')) return { kind: 'command', command: 'go back 10 seconds' }
        if (utterance.includes('मेमोरी')) return { kind: 'question', question: 'वर्चुअल मेमोरी क्या होती है?' }
        if (utterance.includes('ready')) return { kind: 'command', command: 'continue reading' }
        return { kind: 'ignore' }
      },
    })
    await playToMidSentence(ctx)

    ctx.stt.final('रुको') // one Hindi word, known to the grammar: no model, no delay
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause in Hindi')
    expect(heard).toEqual([])

    ctx.stt.final('ok I am ready let us get back to it')
    await until(() => ctx.controller.getState().phase === 'PLAYING', 'indirect request to continue')

    ctx.stt.final('pause')
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause')
    expect(heard).toHaveLength(1) // "pause" did not go to the model

    ctx.stt.final('वर्चुअल मेमोरी क्या होती है')
    await until(() => ctx.asked.length === 1, 'question in Hindi')
    expect(ctx.asked[0].question).toBe('वर्चुअल मेमोरी क्या होती है?')
  })

  it('falls back on its own key-word reading when the model fails or is too slow', async () => {
    const failing = setup({ settings: { verbosity: 'earcons' }, interpret: async () => { throw new Error('offline') } })
    await playToMidSentence(failing)
    failing.stt.final('could you hold on for a bit I need to think')
    await until(() => failing.controller.getState().phase === 'PAUSED', 'pause despite the model failing')

    const slow = setup({ settings: { verbosity: 'earcons' }, interpret: () => new Promise(() => undefined) }) // never answers
    await playToMidSentence(slow)
    slow.stt.final('could you hold on for a bit I need to think')
    await until(() => slow.controller.getState().phase === 'PAUSED', 'pause despite the model never answering')
  }, 10_000)

  it('a key word in talk the model judges was not for the app does not stop the book', async () => {
    const said: string[] = []
    const ctx = setup({ settings: { verbosity: 'earcons' }, interpret: async (_utterance, _state, _book, reading) => { said.push(reading ?? ''); return { kind: 'ignore' } } })
    await playToMidSentence(ctx)
    ctx.stt.interim('tell them')
    expect(ctx.tts.narrating).toBeNull() // someone is talking: the narrator makes way
    ctx.stt.final('tell them to wait and stop shouting back there')
    await until(() => ctx.tts.narrating !== null, 'the book to carry on')
    expect(ctx.controller.getState()).toMatchObject({ phase: 'PLAYING', heardNote: 'ignored: not meant for me' })
    expect(said[0]).toContain('Virtual memory allows a process') // the model is told what the app was reading
  })

  it('the book heard through the loudspeakers, even misheard, neither stops it nor reaches the model', async () => {
    let calls = 0
    const ctx = setup({ interpret: async () => { calls++; return { kind: 'command', command: 'pause' } } })
    await playToMidSentence(ctx)
    for (const echo of [
      'virtual memory allows the process to use more memory', // "a" misheard as "the"
      'memory allows a process to use mode memory than is physically', // "more" misheard as "mode"
      'use more memory than is physically available in the main memory',
      'chapter 3 virtual memory what is virtual memory virtual memory allows a process', // spans the headings too
    ]) {
      ctx.stt.interim(echo)
      expect(ctx.tts.narrating).toBe(TARGET) // not even a pause
      ctx.stt.final(echo)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(0)
    expect(ctx.controller.getState()).toMatchObject({ phase: 'PLAYING', heardNote: 'ignored: that was the book itself' })
    expect(ctx.tts.narrating).toBe(TARGET)
  })

  it('hears a command the recogniser got wrong on its first guess', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(ctx)
    ctx.stt.final('pours', ['boss', 'pause'])
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause from the third guess')
    expect(ctx.controller.getState().heard).toBe('pause')
    ctx.stt.final('can tinue reading', ['continue reading'])
    await until(() => ctx.controller.getState().phase === 'PLAYING', 'continue from the second guess')
  })

  it('hears a command spoken over the narrator, in among the book\'s own words', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(ctx)
    ctx.stt.interim('more memory than is pause')
    expect(ctx.tts.narrating).toBeNull() // the narrator makes way as soon as the command is caught
    ctx.stt.final('more memory than is pause physically available')
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause spoken over the narrator')

    const other = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(other)
    other.stt.final('than is physically available in the main memory repeat that')
    await until(() => other.tts.narrating === TARGET && other.controller.getState().charOffset === 0, 'the sentence read again from its start')

    // ...while the book alone, with words misheard, still triggers nothing.
    const quiet = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(quiet)
    quiet.stt.final('virtual memory allows the process to use mode memory than is physically', ['virtual memory allows a process to use more memory'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(quiet.controller.getState().phase).toBe('PLAYING')
    expect(quiet.tts.narrating).toBe(TARGET)
  })

  it('makes way the moment a voice is heard, then acts on what Whisper says it was', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(ctx)
    ctx.stt.speechStart()
    expect(ctx.tts.narrating).toBeNull() // before a single word is known
    expect(ctx.controller.getState().phase).toBe('PLAYING')
    ctx.stt.final('What is virtual memory?')
    await until(() => ctx.asked.length === 1, 'the question to be asked')

    // A cough: the narrator carries on from the same word.
    const cough = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(cough)
    cough.stt.speechStart()
    expect(cough.tts.narrating).toBeNull()
    cough.stt.dismiss()
    expect(cough.tts.narrating).toBe('than is physically available in the main memory.')
  })

  it('stops making way for a microphone that keeps mistaking the book or noise for speech, but still obeys commands', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(ctx)
    ctx.stt.speechStart()
    ctx.stt.dismiss() // a noise
    ctx.stt.speechStart()
    ctx.stt.final('than is physically available in the main memory') // the book itself, leaking through
    expect(ctx.tts.narrating).not.toBeNull()
    ctx.stt.speechStart() // a third time: not believed
    expect(ctx.tts.narrating).not.toBeNull()
    ctx.stt.final('pause.')
    await until(() => ctx.controller.getState().phase === 'PAUSED', 'pause')
    // After a while it is given the benefit of the doubt again.
    ctx.stt.final('continue.')
    await until(() => ctx.controller.getState().phase === 'PLAYING', 'continue')
    ctx.clock.ms += 3 * 60_000
    ctx.stt.speechStart()
    expect(ctx.tts.narrating).toBeNull()
  })

  it('answers a question that arrives glued to the narrator\'s last words', async () => {
    const ctx = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(ctx)
    ctx.stt.final('more memory than is physically available what does physically available mean')
    await until(() => ctx.asked.length === 1, 'the question to be asked')
    expect(ctx.asked[0].question).toBe('what does physically available mean')
    // ...and a question that reuses the words of a heading read a moment ago is still a question.
    const other = setup({ settings: { verbosity: 'earcons' } })
    await playToMidSentence(other)
    other.stt.final('What is virtual memory used for?')
    await until(() => other.asked.length === 1, 'the question to be asked')
    expect(other.asked[0].question).toBe('What is virtual memory used for?')
  })

  it('stray words while the answer is on its way do not cancel it, but "cancel" does', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stream = async function* (): AsyncGenerator<AskEvent> {
      yield ANSWER[0]
      await gate
      yield* ANSWER.slice(1)
    }
    const ctx = setup({ settings: { verbosity: 'earcons' }, stream, interpret: async () => ({ kind: 'command', command: 'pause' }) })
    await playToMidSentence(ctx)
    ctx.stt.final('What is virtual memory?')
    await until(() => ctx.controller.getState().phase === 'RETRIEVING', 'searching')
    ctx.stt.final('hmm okay wait') // thinking aloud
    ctx.stt.final('and why is it needed') // the rest of the thought, arriving late
    ctx.stt.final('searching your textbook')
    expect(ctx.controller.getState().phase).toBe('RETRIEVING')
    expect(ctx.asked).toHaveLength(1)
    release()
    await until(() => ctx.tts.said('assistant').includes('It keeps the rest on disk.'), 'the answer to be spoken')

    const cancelled = setup({ settings: { verbosity: 'earcons' }, stream: async function* () { yield ANSWER[0]; await new Promise(() => undefined) } })
    await playToMidSentence(cancelled)
    cancelled.stt.final('What is virtual memory?')
    await until(() => cancelled.controller.getState().phase === 'RETRIEVING', 'searching')
    cancelled.stt.final('cancel')
    await until(() => cancelled.controller.getState().phase === 'PLAYING', 'back to the book')
  })

  it('never sends the narrator\'s own words to the language model', async () => {
    let calls = 0
    const ctx = setup({ interpret: async () => { calls++; return { kind: 'ignore' } } })
    await playToMidSentence(ctx)
    ctx.stt.final('a process to use more memory than is physically available')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(0)
    expect(ctx.tts.narrating).toBe(TARGET)
  })
})
