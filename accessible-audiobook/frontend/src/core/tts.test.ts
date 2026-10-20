/**
 * The natural (server) voice must never leave the listener in silence: when the
 * voice service fails or is slow, the device voice takes over, and keeps taking
 * over for a while instead of waiting on every sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../services/api'
import { naturalVoice, recognitionLanguage, updateSettings } from './settings'
import { BrowserTTS, ServerTTS, type SpeakCallbacks } from './tts'

class FakeUtterance {
  text: string
  onend: (() => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

const spokenByDevice: string[] = []

function callbacks(): SpeakCallbacks & { ended: number; errors: string[] } {
  const record = { ended: 0, errors: [] as string[] }
  return Object.assign(record, { onEnd: () => { record.ended++ }, onError: (error: string) => { record.errors.push(error) } })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  spokenByDevice.length = 0
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('speechSynthesis', {
    speaking: false, pending: false,
    getVoices: () => [],
    cancel: () => undefined,
    speak: (utterance: FakeUtterance) => {
      spokenByDevice.push(utterance.text)
      setTimeout(() => utterance.onend?.(), 0)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ServerTTS falling back to the device voice', () => {
  it('reads the sentence with the device voice when the service fails, and reports the end normally', async () => {
    const synthesize = vi.spyOn(api, 'synthesize').mockRejectedValue(new Error('service down'))
    const tts = new ServerTTS()
    const first = callbacks()
    tts.speak('First sentence.', { rate: 1, volume: 1 }, first)
    await flush()
    await flush()
    expect(spokenByDevice).toEqual(['First sentence.'])
    expect(first).toMatchObject({ ended: 1, errors: [] })

    // The next sentences do not wait on the broken service again.
    const second = callbacks()
    tts.speak('Second sentence.', { rate: 1, volume: 1 }, second)
    tts.prefetch('Third sentence.')
    await flush()
    expect(spokenByDevice).toEqual(['First sentence.', 'Second sentence.'])
    expect(second.ended).toBe(1)
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('tries the natural voice again after a while', async () => {
    const synthesize = vi.spyOn(api, 'synthesize').mockRejectedValue(new Error('service down'))
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    const tts = new ServerTTS()
    tts.speak('One.', { rate: 1, volume: 1 }, callbacks())
    await flush()
    await flush()
    now.mockReturnValue(1_000 + 61_000)
    tts.speak('Two.', { rate: 1, volume: 1 }, callbacks())
    await flush()
    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('says so once when it drops to the device voice, not for every sentence', async () => {
    vi.spyOn(api, 'synthesize').mockRejectedValue(new Error('service down'))
    const tts = new ServerTTS()
    const notices = vi.fn()
    tts.onFallback = notices
    for (const sentence of ['One.', 'Two.', 'Three.']) {
      tts.speak(sentence, { rate: 1, volume: 1 }, callbacks())
      await flush()
      await flush()
    }
    expect(spokenByDevice).toEqual(['One.', 'Two.', 'Three.'])
    expect(notices).toHaveBeenCalledTimes(1)
  })

  it('asks for the natural voice the listener chose, per role', async () => {
    updateSettings({ serverNarratorVoice: 'en-US-BrianMultilingualNeural', serverAssistantVoice: 'en-US-EmmaMultilingualNeural' })
    try {
      const synthesize = vi.spyOn(api, 'synthesize').mockRejectedValue(new Error('service down'))
      const tts = new ServerTTS()
      tts.speak('The book.', { rate: 1, volume: 1, role: 'narrator' }, callbacks())
      tts.speak('The answer.', { rate: 1, volume: 1, role: 'assistant' }, callbacks())
      expect(synthesize).toHaveBeenNthCalledWith(1, 'The book.', 'narrator', 'en-US-BrianMultilingualNeural')
      expect(synthesize).toHaveBeenNthCalledWith(2, 'The answer.', 'assistant', 'en-US-EmmaMultilingualNeural')
      await flush()
    } finally {
      updateSettings({ serverNarratorVoice: '', serverAssistantVoice: '' })
    }
  })

  it('with nothing chosen, uses Indian English voices and listening in India and the server default elsewhere', () => {
    const zone = (timeZone: string) => vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions)
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    zone('Asia/Kolkata')
    expect([naturalVoice('narrator'), naturalVoice('assistant'), recognitionLanguage()])
      .toEqual(['en-IN-NeerjaExpressiveNeural', 'en-IN-PrabhatNeural', 'en-IN'])
    zone('America/New_York')
    expect([naturalVoice('narrator'), naturalVoice('assistant'), recognitionLanguage()]).toEqual(['', '', 'en-US'])
    // The listener's own choice always wins.
    updateSettings({ speechLanguage: 'hi-IN', serverNarratorVoice: 'en-US-AvaMultilingualNeural' })
    zone('Asia/Kolkata')
    expect([naturalVoice('narrator'), recognitionLanguage()]).toEqual(['en-US-AvaMultilingualNeural', 'hi-IN'])
    updateSettings({ speechLanguage: 'auto', serverNarratorVoice: '' })
  })

  it('reads text in another script with a device voice for that language', async () => {
    const spoken: { lang: string; voice?: unknown }[] = []
    const hindi = { name: 'Microsoft Swara Online (Natural) - Hindi', lang: 'hi-IN', voiceURI: 'swara' }
    const english = { name: 'Microsoft Ava', lang: 'en-US', voiceURI: 'ava' }
    vi.stubGlobal('speechSynthesis', {
      speaking: false, pending: false, getVoices: () => [english, hindi], cancel: () => undefined,
      speak: (u: FakeUtterance & { lang: string; voice?: unknown }) => { spoken.push({ lang: u.lang, voice: u.voice }); setTimeout(() => u.onend?.(), 0) },
    })
    new BrowserTTS().speak('स्टैक में आखिरी आया तत्व सबसे पहले बाहर निकलता है।', { rate: 1, volume: 1, voiceURI: 'ava' }, callbacks())
    new BrowserTTS().speak('Stacks are last in, first out.', { rate: 1, volume: 1, voiceURI: 'ava' }, callbacks())
    expect(spoken).toEqual([{ lang: 'hi-IN', voice: hindi }, { lang: 'en-US', voice: english }])
  })

  it('does not wait forever for a slow service', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'synthesize').mockReturnValue(new Promise(() => undefined)) // never answers
    const tts = new ServerTTS()
    const result = callbacks()
    tts.speak('A sentence that never arrives.', { rate: 1, volume: 1 }, result)
    await vi.advanceTimersByTimeAsync(7_900)
    expect(spokenByDevice).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(spokenByDevice).toEqual(['A sentence that never arrives.'])
    await vi.advanceTimersByTimeAsync(10)
    expect(result.ended).toBe(1)
  })

  it('interrupting a sentence that is just starting is not mistaken for a broken voice service', async () => {
    // A browser rejects play() with AbortError when pause() arrives before playback has begun.
    class FakeAudio {
      playbackRate = 1
      volume = 1
      paused = true
      currentTime = 0
      duration = 1
      onplaying: (() => void) | null = null
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      private rejectPlay: ((error: Error) => void) | null = null
      play() {
        this.paused = false
        return new Promise<void>((_, reject) => { this.rejectPlay = reject })
      }
      pause() {
        this.paused = true
        this.rejectPlay?.(Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' }))
      }
    }
    vi.stubGlobal('Audio', FakeAudio)
    const createObjectURL = vi.fn(() => 'blob:clip')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: () => undefined }))
    const synthesize = vi.spyOn(api, 'synthesize').mockResolvedValue({ audio: new Blob(['audio']), words: [] })

    const tts = new ServerTTS()
    const first = Object.assign(callbacks(), { cancelled: 0, onCancel() { this.cancelled++ } })
    tts.speak('First sentence.', { rate: 1, volume: 1 }, first)
    await flush()
    await flush()
    tts.cancel() // the student interrupts
    await flush()
    expect(first).toMatchObject({ cancelled: 1, ended: 0, errors: [] })

    tts.speak('Second sentence.', { rate: 1, volume: 1 }, callbacks())
    await flush()
    await flush()
    expect(synthesize).toHaveBeenCalledTimes(2) // still using the natural voice
    expect(spokenByDevice).toEqual([])
  })

  it('a cancelled sentence stays cancelled even if the service fails afterwards', async () => {
    let fail: (error: Error) => void = () => undefined
    vi.spyOn(api, 'synthesize').mockReturnValue(new Promise((_, reject) => { fail = reject }))
    const tts = new ServerTTS()
    const result = Object.assign(callbacks(), { cancelled: 0, onCancel() { this.cancelled++ } })
    tts.speak('Interrupted.', { rate: 1, volume: 1 }, result)
    tts.cancel()
    fail(new Error('service down'))
    await flush()
    expect(result).toMatchObject({ cancelled: 1, ended: 0 })
    expect(spokenByDevice).toEqual([])
  })
})
