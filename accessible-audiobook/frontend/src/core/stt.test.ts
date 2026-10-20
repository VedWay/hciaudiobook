/**
 * The command listener must keep listening: the browser ends recognition after every pause,
 * drops its connection now and then, and sometimes stalls without a word. None of that may
 * leave a blind listener talking to a microphone that has quietly stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserSTT } from './stt'

class FakeRecognition {
  static made: FakeRecognition[] = []
  static failStart = 0
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 1
  onresult: ((event: unknown) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  onstart: (() => void) | null = null
  onspeechend: (() => void) | null = null
  started = false
  aborted = false
  constructor() {
    FakeRecognition.made.push(this)
  }
  start() {
    if (FakeRecognition.failStart > 0) {
      FakeRecognition.failStart--
      throw Object.assign(new Error('recognition has already started'), { name: 'InvalidStateError' })
    }
    this.started = true
  }
  abort() {
    this.aborted = true
  }
  /** One final result with the recogniser's guesses, best first. */
  hear(...guesses: string[]) {
    const result = Object.assign(guesses.map((transcript) => ({ transcript })), { isFinal: true })
    this.onresult?.({ resultIndex: 0, results: [result] })
  }
}

const latest = () => FakeRecognition.made[FakeRecognition.made.length - 1]

function listen() {
  const finals: [string, string[]][] = []
  const errors: string[] = []
  const stt = new BrowserSTT()
  stt.start('continuous', { onFinal: (text, others = []) => finals.push([text, others]), onError: (code) => errors.push(code) })
  return { stt, finals, errors }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeRecognition.made = []
  FakeRecognition.failStart = 0
  vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { SpeechRecognition: FakeRecognition }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('BrowserSTT as an always-on command listener', () => {
  it('asks for the recogniser\'s other guesses and passes them on', () => {
    const { finals } = listen()
    expect(latest().maxAlternatives).toBeGreaterThan(1)
    latest().hear('paws', 'pause', 'paws', 'pours')
    expect(finals).toEqual([['paws', ['pause', 'pours']]])
  })

  it('starts listening again at once when the browser ends a session', () => {
    listen()
    latest().onend?.()
    vi.advanceTimersByTime(100)
    expect(FakeRecognition.made).toHaveLength(2)
    expect(latest().started).toBe(true)
  })

  it('rides out a dropped connection instead of switching the microphone off', () => {
    const { errors, finals } = listen()
    for (let i = 0; i < 3; i++) {
      latest().onerror?.({ error: 'network' })
      latest().onend?.()
      vi.advanceTimersByTime(5000)
    }
    expect(errors).toEqual([])
    expect(latest().started).toBe(true)
    latest().hear('pause')
    expect(finals).toEqual([['pause', []]])
  })

  it('gives up, and says so, only when it keeps failing', () => {
    const { errors } = listen()
    for (let i = 0; i < 10 && !errors.length; i++) {
      latest().onerror?.({ error: 'network' })
      latest().onend?.()
      vi.advanceTimersByTime(5000)
    }
    expect(errors).toEqual(['network'])
    const made = FakeRecognition.made.length
    vi.advanceTimersByTime(60_000)
    expect(FakeRecognition.made).toHaveLength(made) // no further attempts once the user has been told
  })

  it('a blocked microphone is reported straight away', () => {
    const { errors } = listen()
    latest().onerror?.({ error: 'not-allowed' })
    expect(errors).toEqual(['not-allowed'])
  })

  it('tries again when the previous recogniser is still shutting down', () => {
    FakeRecognition.failStart = 2
    const { errors } = listen()
    vi.advanceTimersByTime(3000)
    expect(errors).toEqual([])
    expect(latest().started).toBe(true)
  })

  it('restarts a recogniser that has stalled without a word', () => {
    listen()
    vi.advanceTimersByTime(20_000)
    expect(FakeRecognition.made).toHaveLength(1)
    vi.advanceTimersByTime(15_000)
    expect(FakeRecognition.made).toHaveLength(2)
    expect(FakeRecognition.made[0].aborted).toBe(true)
  })

  it('stops for good when asked to', () => {
    const { stt } = listen()
    stt.stop()
    latest().onend?.()
    vi.advanceTimersByTime(60_000)
    expect(FakeRecognition.made).toHaveLength(1)
  })
})
