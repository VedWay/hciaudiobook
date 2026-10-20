/**
 * Text-to-speech behind one interface, so the device's voice can be swapped for a
 * natural-sounding server voice (Microsoft neural voices by default, or OpenAI;
 * ElevenLabs / Google can be added the same way).
 *
 * Text is always spoken one sentence at a time. That keeps the playback position
 * precise and sidesteps browser bugs with long utterances and with pause/resume:
 * "pause" is implemented as cancel + remember the character offset.
 */
import { api } from '../services/api'
import { detectScriptLanguage } from './lang'
import { naturalVoice } from './settings'

export interface SpeakOptions {
  rate: number
  volume: number
  pitch?: number
  voiceURI?: string
  /** Which of the two voices to use (server engine). */
  role?: 'narrator' | 'assistant'
}

export interface SpeakCallbacks {
  onStart?(): void
  /** Index (within the spoken text) of the word that is starting. */
  onBoundary?(charIndex: number): void
  onEnd(): void
  onError(error: string): void
  /** The utterance was cut short by cancel() or by a newer speak(). */
  onCancel?(): void
}

export interface TTSEngine {
  readonly kind: 'browser' | 'server'
  speak(text: string, options: SpeakOptions, callbacks: SpeakCallbacks): void
  cancel(): void
  /** Fetch audio ahead of time so there is no gap before it is spoken (server engine only). */
  prefetch?(text: string, role?: 'narrator' | 'assistant'): void
  /** Called once each time the natural voice becomes unreachable and the device voice takes over (server engine only). */
  onFallback?: () => void
}

export function browserTTSAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!browserTTSAvailable()) return Promise.resolve([])
  const voices = speechSynthesis.getVoices()
  if (voices.length) return Promise.resolve(voices)
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1500) // some browsers never fire the event
  })
}

function englishVoices(): SpeechSynthesisVoice[] {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'))
  // Most natural first: Edge's "Natural" neural voices, then Google's, then the operating system's.
  const quality = (v: SpeechSynthesisVoice) => (/natural|neural/i.test(v.name) ? 0 : /google/i.test(v.name) ? 1 : 2)
  const region = (v: SpeechSynthesisVoice) => (v.lang === navigator.language ? 0 : v.lang.startsWith('en-US') ? 1 : 2)
  return [...voices].sort((a, b) => quality(a) - quality(b) || region(a) - region(b))
}

/** The most natural device voice for a language code such as "hi" or "ar", if the device has one. */
function deviceVoiceFor(language: string): SpeechSynthesisVoice | null {
  const natural = (v: SpeechSynthesisVoice) => (/natural|neural/i.test(v.name) ? 0 : /google/i.test(v.name) ? 1 : 2)
  const matches = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(language))
  return matches.sort((a, b) => natural(a) - natural(b))[0] ?? null
}

/**
 * The narrator and the assistant should sound different, so a listener can tell
 * "the book" from "the answer" without any visual cue. Uses a second voice when
 * the device has one and falls back to a higher pitch otherwise.
 */
export function voiceFor(role: 'narrator' | 'assistant', narratorURI: string, assistantURI: string): { voiceURI?: string; pitch: number } {
  if (!browserTTSAvailable()) return { pitch: 1 }
  const english = englishVoices()
  const all = speechSynthesis.getVoices()
  const narrator = all.find((v) => v.voiceURI === narratorURI) ?? english[0]
  if (role === 'narrator') return { voiceURI: narrator?.voiceURI, pitch: 1 }
  const assistant = all.find((v) => v.voiceURI === assistantURI) ?? english.find((v) => v.voiceURI !== narrator?.voiceURI)
  if (assistant && assistant.voiceURI !== narrator?.voiceURI) return { voiceURI: assistant.voiceURI, pitch: 1 }
  return { voiceURI: narrator?.voiceURI, pitch: 1.25 }
}

export class BrowserTTS implements TTSEngine {
  readonly kind = 'browser' as const
  private generation = 0
  private callbacks: SpeakCallbacks | null = null
  // Chrome can garbage-collect an utterance mid-speech and then never fires its events.
  protected utterance: SpeechSynthesisUtterance | null = null

  speak(text: string, options: SpeakOptions, callbacks: SpeakCallbacks): void {
    this.cancel()
    const generation = this.generation
    const utterance = new SpeechSynthesisUtterance(text)
    // Text in another script (Hindi, Arabic...) needs a voice for that language; the English voice would garble it.
    const language = detectScriptLanguage(text)
    const voice = language
      ? deviceVoiceFor(language) ?? undefined
      : speechSynthesis.getVoices().find((v) => v.voiceURI === options.voiceURI)
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? language ?? 'en-US'
    utterance.rate = options.rate
    utterance.volume = options.volume
    utterance.pitch = options.pitch ?? 1
    const live = () => generation === this.generation
    utterance.onstart = () => { if (live()) callbacks.onStart?.() }
    utterance.onboundary = (event) => {
      if (live() && event.name !== 'sentence') callbacks.onBoundary?.(event.charIndex)
    }
    utterance.onend = () => {
      if (!live()) return
      this.callbacks = null
      callbacks.onEnd()
    }
    utterance.onerror = (event) => {
      if (!live() || event.error === 'interrupted' || event.error === 'canceled') return
      this.callbacks = null
      callbacks.onError(event.error)
    }
    this.utterance = utterance
    this.callbacks = callbacks
    speechSynthesis.speak(utterance)
  }

  cancel(): void {
    this.generation++
    const callbacks = this.callbacks
    this.callbacks = null
    this.utterance = null
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel()
    callbacks?.onCancel?.()
  }
}

/** Longest a sentence may take to arrive before the device voice reads it instead. */
const CLIP_TIMEOUT_MS = 8000
/** After a failure, how long to stay on the device voice before trying the natural voice again. */
const RETRY_AFTER_MS = 30_000

/**
 * Plays natural-sounding audio synthesised by the backend. Word timings from the
 * server drive the same onBoundary callback as the browser engine, so the exact
 * reading position is still known. If the service cannot be reached, the
 * sentence is spoken by the device's own voice instead of failing.
 */
export class ServerTTS implements TTSEngine {
  readonly kind = 'server' as const
  private generation = 0
  private callbacks: SpeakCallbacks | null = null
  private audio: HTMLAudioElement | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private fallback: BrowserTTS | null = browserTTSAvailable() ? new BrowserTTS() : null
  private usingFallback = false
  private unavailableUntil = 0
  private cache = new Map<string, Promise<{ url: string; words: [number, number][] }>>()

  onFallback?: () => void

  private clip(text: string, role: 'narrator' | 'assistant') {
    const voice = naturalVoice(role)
    const key = `${role}:${voice}:${text}`
    let clip = this.cache.get(key)
    if (!clip) {
      clip = api.synthesize(text, role, voice).then(({ audio, words }) => ({ url: URL.createObjectURL(audio), words }))
      clip.catch(() => this.cache.delete(key))
      this.cache.set(key, clip)
      if (this.cache.size > 60) {
        const [oldest, stale] = this.cache.entries().next().value!
        this.cache.delete(oldest)
        stale.then((c) => URL.revokeObjectURL(c.url)).catch(() => undefined)
      }
    }
    return clip
  }

  /** The voice service failed recently: use the device voice for now instead of waiting on every sentence. */
  private get unavailable(): boolean {
    return performance.now() < this.unavailableUntil
  }

  prefetch(text: string, role: 'narrator' | 'assistant' = 'narrator'): void {
    if (!this.unavailable) void this.clip(text, role).catch(() => undefined)
  }

  speak(text: string, options: SpeakOptions, callbacks: SpeakCallbacks): void {
    this.cancel()
    const generation = this.generation
    this.callbacks = callbacks
    const live = () => generation === this.generation
    const finish = (deliver: () => void) => {
      if (!live()) return
      this.stopTicker()
      this.callbacks = null
      deliver()
    }
    // Keep reading rather than fail: the device voice is less natural, but it is there.
    const fallBackToDeviceVoice = () => {
      if (!this.fallback) return finish(() => callbacks.onError('synthesis-failed'))
      this.usingFallback = true
      this.fallback.speak(text, options, callbacks)
    }
    if (this.unavailable && this.fallback) return fallBackToDeviceVoice()

    let timer: ReturnType<typeof setTimeout> | undefined
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('voice service timed out')), CLIP_TIMEOUT_MS)
    })
    Promise.race([this.clip(text, options.role ?? 'narrator'), tooSlow]).finally(() => clearTimeout(timer)).then(({ url, words }) => {
      if (!live()) return
      const audio = new Audio(url)
      this.audio = audio
      audio.playbackRate = options.rate // the browser keeps the pitch constant
      audio.volume = options.volume
      audio.onplaying = () => { if (live()) callbacks.onStart?.() }
      audio.onended = () => finish(() => callbacks.onEnd())
      // This clip could not be played (blocked, or bad audio): read this sentence with the device voice.
      const cannotPlay = () => {
        if (!live() || this.usingFallback) return
        this.stopTicker()
        fallBackToDeviceVoice()
      }
      audio.onerror = cannotPlay
      let lastWord = -1
      this.ticker = setInterval(() => {
        if (!live() || audio.paused) return
        const ms = audio.currentTime * 1000
        if (words.length) {
          let word = lastWord
          while (word + 1 < words.length && words[word + 1][0] <= ms) word++
          if (word !== lastWord) {
            lastWord = word
            callbacks.onBoundary?.(words[word][1])
          }
        } else if (audio.duration) {
          // No timings from this provider: estimate, and snap back to the start of a word.
          callbacks.onBoundary?.(text.lastIndexOf(' ', Math.floor((ms / 1000 / audio.duration) * text.length)) + 1)
        }
      }, 60)
      // Pausing a clip that is still starting rejects play(). That is an ordinary interruption
      // (cancel() has already run), not a failure of the voice service.
      audio.play().catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name !== 'AbortError') cannotPlay()
      })
    }, () => {
      // The clip could not be fetched, or took too long. Do not make the listener sit through the
      // same wait before every sentence: stay on the device voice for a while, then try again.
      if (!this.unavailable) this.onFallback?.()
      this.unavailableUntil = performance.now() + RETRY_AFTER_MS
      if (!live()) return
      this.stopTicker()
      fallBackToDeviceVoice()
    })
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  cancel(): void {
    this.generation++
    this.stopTicker()
    this.audio?.pause()
    this.audio = null
    if (this.usingFallback) {
      this.usingFallback = false
      this.callbacks = null
      this.fallback?.cancel() // delivers onCancel itself
      return
    }
    const callbacks = this.callbacks
    this.callbacks = null
    callbacks?.onCancel?.()
  }
}
