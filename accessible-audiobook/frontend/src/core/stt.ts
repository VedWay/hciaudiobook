/**
 * Speech-to-text behind one interface.
 *
 * BrowserSTT uses the Web Speech API: low latency and able to listen continuously
 * for commands while the book plays. ServerSTT records one utterance and sends it
 * to the backend (Whisper / Gemini) - used where the browser has no recogniser.
 */
import { api, ApiError } from '../services/api'
import { recognitionLanguage } from './settings'
import { downsample, encodeWav, VoiceSegmenter } from './vad'

export type STTErrorCode = 'no-speech' | 'not-allowed' | 'network' | 'failed'

export interface STTCallbacks {
  onInterim?(text: string): void
  /** `alternatives`: the recogniser's other guesses at the same words, best first ("paws" for "pause"). */
  onFinal(text: string, alternatives?: string[]): void
  /** Speech has ended and the recording is being transcribed. */
  onProcessing?(): void
  /**
   * Someone has started speaking (engines that listen to the sound itself, before any words are
   * known). Always followed by onFinal, or by onDismissed if it came to nothing.
   */
  onSpeechStart?(): void
  /** What began with onSpeechStart was not speech after all: a noise, or nothing intelligible. */
  onDismissed?(): void
  /** `detail` is the browser's own error name, for diagnosis. */
  onError(code: STTErrorCode, detail?: string): void
}

export interface STTEngine {
  readonly kind: 'browser' | 'server'
  /** Can it keep listening for commands while the audiobook plays? */
  readonly continuous: boolean
  start(mode: 'continuous' | 'single', callbacks: STTCallbacks): void
  stop(): void
}

// The Web Speech recognition types are not in TypeScript's DOM library.
interface RecognitionResultEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; length: number; [index: number]: { transcript: string } }>
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  onspeechend: (() => void) | null
  start(): void
  abort(): void
}

/** How many times in a row a command listener may fail to start, or fail in service, before it gives up. */
const MAX_RESTARTS = 6
/**
 * A healthy recogniser reports something at least every few seconds, even in silence (it ends with
 * "no-speech" and is restarted). One that has reported nothing for this long has stalled.
 */
const STALLED_AFTER_MS = 25_000

function recognitionConstructor(): (new () => Recognition) | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as Record<string, new () => Recognition>
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export function browserSTTAvailable(): boolean {
  return recognitionConstructor() !== undefined
}

export class BrowserSTT implements STTEngine {
  readonly kind = 'browser' as const
  readonly continuous = true
  private recognition: Recognition | null = null
  private generation = 0
  private watchdog: ReturnType<typeof setInterval> | null = null

  start(mode: 'continuous' | 'single', callbacks: STTCallbacks): void {
    this.stop()
    const generation = this.generation
    const live = () => generation === this.generation
    const Ctor = recognitionConstructor()!
    const continuous = mode === 'continuous'
    let gotFinal = false
    let failed = false // given up: the caller has been told
    let troubles = 0 // failures in a row; any sign of life resets it
    let lastSign = Date.now()
    let restart: ReturnType<typeof setTimeout> | null = null

    const giveUp = (code: STTErrorCode, detail?: string) => {
      failed = true
      callbacks.onError(code, detail)
    }
    /** A command listener must survive hiccups: try again, a little later each time, before giving up. */
    const retry = (code: STTErrorCode, detail?: string) => {
      if (!continuous || ++troubles > MAX_RESTARTS) return giveUp(code, detail)
      if (restart) clearTimeout(restart)
      restart = setTimeout(() => { if (live() && !failed) begin() }, Math.min(4000, 250 * 2 ** (troubles - 1)))
    }

    const begin = () => {
      restart = null
      this.recognition?.abort() // never two at once: the browser allows a single recogniser
      const recognition = new Ctor()
      const mine = () => live() && this.recognition === recognition
      recognition.lang = recognitionLanguage() // read at each (re)start, so a change of setting takes effect
      recognition.continuous = continuous
      recognition.interimResults = true
      recognition.maxAlternatives = 4
      recognition.onstart = () => { if (mine()) lastSign = Date.now() }
      recognition.onresult = (event) => {
        if (!mine()) return
        lastSign = Date.now()
        troubles = 0
        let interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          const text = result[0].transcript.trim()
          if (!result.isFinal) interim += `${text} `
          else if (text) {
            gotFinal = true
            const others: string[] = []
            for (let n = 1; n < result.length; n++) {
              const other = result[n]?.transcript.trim()
              if (other && other !== text && !others.includes(other)) others.push(other)
            }
            callbacks.onFinal(text, others)
          }
        }
        if (interim.trim()) callbacks.onInterim?.(interim.trim())
      }
      recognition.onspeechend = () => { if (mine() && mode === 'single') callbacks.onProcessing?.() }
      let erred = false
      recognition.onerror = (event) => {
        if (!mine() || event.error === 'aborted') return
        lastSign = Date.now()
        if (event.error === 'no-speech') {
          if (mode === 'single') giveUp('no-speech')
          return // continuous mode simply keeps listening
        }
        erred = true
        const denied = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        if (denied) return giveUp('not-allowed', event.error)
        // A dropped connection or a busy microphone is usually over in a moment.
        retry(event.error === 'network' ? 'network' : 'failed', event.error)
      }
      recognition.onend = () => {
        if (!mine()) return
        lastSign = Date.now()
        // The browser ends recognition after every pause; a command listener is restarted at once,
        // so as little as possible of what is said next is missed.
        if (continuous && !failed && !erred) {
          troubles = 0 // a session that ended normally: whatever went wrong before is over
          restart = setTimeout(() => { if (live() && !failed) begin() }, 60)
        }
        else if (mode === 'single' && !gotFinal && !failed) callbacks.onError('no-speech')
      }
      this.recognition = recognition
      try {
        recognition.start()
      } catch (error) {
        // Typically "already started": the previous recogniser is still shutting down.
        retry('failed', error instanceof Error ? error.name : 'start-failed')
      }
    }
    begin()

    if (continuous) {
      this.watchdog = setInterval(() => {
        if (!live() || failed || restart || Date.now() - lastSign < STALLED_AFTER_MS) return
        lastSign = Date.now()
        begin() // stalled without a word: start afresh
      }, 5000)
    }
  }

  stop(): void {
    this.generation++
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.recognition?.abort()
    this.recognition = null
  }
}

export function liveSTTAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    && typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window)
}

/** Most utterances a minute sent for transcription: stays inside a free speech-service allowance. */
const MAX_UTTERANCES_PER_MINUTE = 15

/**
 * Listens the way a voice assistant does. The microphone is opened with the browser's echo
 * cancellation, so the app's own voice coming out of the loudspeakers is removed before anything
 * else sees it; the sound is cut into utterances as people start and stop speaking; and each
 * utterance is written down by Whisper on the server, which copes with accents, Hindi and noise
 * far better than the browser's built-in recogniser. Nothing is sent while nobody is speaking.
 */
export class LiveSTT implements STTEngine {
  readonly kind = 'server' as const
  readonly continuous = true
  private generation = 0
  private cleanup: (() => void) | null = null

  start(mode: 'continuous' | 'single', callbacks: STTCallbacks): void {
    this.stop()
    const generation = this.generation
    const live = () => generation === this.generation
    void this.open(mode, live, callbacks).catch(() => { if (live()) callbacks.onError('failed', 'audio-setup') })
  }

  private async open(mode: 'continuous' | 'single', live: () => boolean, callbacks: STTCallbacks): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
    } catch {
      if (live()) callbacks.onError('not-allowed')
      return
    }
    if (!live()) return stream.getTracks().forEach((track) => track.stop())

    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const context = new Context()
    void context.resume?.()
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(2048, 1, 1)
    const mute = context.createGain()
    mute.gain.value = 0 // the processor only runs when connected to an output; this keeps it silent
    source.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)

    let giveUp: ReturnType<typeof setTimeout> | null = null
    const release = () => {
      if (giveUp) clearTimeout(giveUp)
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      void context.close().catch(() => undefined)
    }
    this.cleanup = release

    const sent: number[] = []
    let failures = 0
    let busyUntil = 0
    let order: Promise<void> = Promise.resolve() // utterances are reported in the order they were spoken

    const transcribe = (samples: Float32Array) => {
      const now = Date.now()
      while (sent.length && now - sent[0] > 60_000) sent.shift()
      if (now < busyUntil || sent.length >= MAX_UTTERANCES_PER_MINUTE) {
        return mode === 'single' ? callbacks.onError('network') : callbacks.onDismissed?.()
      }
      sent.push(now)
      callbacks.onProcessing?.()
      const request = api.transcribe(encodeWav(samples), recognitionLanguage().slice(0, 2))
      order = order.then(async () => {
        try {
          const text = (await request).trim()
          if (!live()) return
          failures = 0
          if (text) callbacks.onFinal(text)
          else if (mode === 'single') callbacks.onError('no-speech')
          else callbacks.onDismissed?.()
        } catch (error) {
          if (!live()) return
          if (error instanceof ApiError && error.status === 429) {
            busyUntil = Date.now() + 10_000 // the service is rate-limiting: wait, do not give up
            return mode === 'single' ? callbacks.onError('network') : callbacks.onDismissed?.()
          }
          if (mode === 'single' || ++failures >= 3) return callbacks.onError('network')
          callbacks.onDismissed?.()
        }
      })
    }

    const segmenter = new VoiceSegmenter({
      onSpeechStart: () => {
        if (!live()) return
        if (giveUp) clearTimeout(giveUp)
        callbacks.onSpeechStart?.()
      },
      onSpeechEnd: (samples) => {
        if (!live()) return
        if (mode === 'single') processor.onaudioprocess = null // one utterance was asked for
        if (samples) transcribe(samples)
        else if (mode === 'single') callbacks.onError('no-speech')
        else callbacks.onDismissed?.()
      },
    })
    processor.onaudioprocess = (event) => {
      if (!live()) return
      // The browser reuses this buffer, so it is copied before being kept.
      segmenter.push(downsample(new Float32Array(event.inputBuffer.getChannelData(0)), context.sampleRate))
    }
    if (mode === 'single') {
      giveUp = setTimeout(() => {
        if (!live()) return
        processor.onaudioprocess = null
        callbacks.onError('no-speech')
      }, GIVE_UP_WITHOUT_SPEECH_MS)
    }
  }

  stop(): void {
    this.generation++
    this.cleanup?.()
    this.cleanup = null
  }
}

/**
 * Uses one engine and, if it stops working for a reason other than a blocked microphone,
 * carries on with another - so losing the connection to the speech service does not leave
 * the listener without voice control.
 */
export class FallbackSTT implements STTEngine {
  readonly kind: 'browser' | 'server'
  readonly continuous: boolean
  private primary: STTEngine
  private makeSecondary: () => STTEngine
  private secondary: STTEngine | null = null

  constructor(primary: STTEngine, makeSecondary: () => STTEngine) {
    this.primary = primary
    this.makeSecondary = makeSecondary
    this.kind = primary.kind
    this.continuous = primary.continuous
  }

  start(mode: 'continuous' | 'single', callbacks: STTCallbacks): void {
    if (this.secondary) return this.secondary.start(mode, callbacks)
    this.primary.start(mode, {
      ...callbacks,
      onError: (code, detail) => {
        if (code === 'not-allowed' || code === 'no-speech') return callbacks.onError(code, detail)
        this.primary.stop()
        this.secondary = this.makeSecondary()
        this.secondary.start(mode, callbacks)
      },
    })
  }

  stop(): void {
    this.primary.stop()
    this.secondary?.stop()
  }
}

const SILENCE_AFTER_SPEECH_MS = 1400
const GIVE_UP_WITHOUT_SPEECH_MS = 7000
const MAX_RECORDING_MS = 20000
const SPEECH_LEVEL = 0.02 // RMS amplitude treated as "someone is talking"

/** Records one utterance (ending on silence) and has the backend transcribe it. */
export class ServerSTT implements STTEngine {
  readonly kind = 'server' as const
  readonly continuous = false
  private generation = 0
  private cleanup: (() => void) | null = null

  start(_mode: 'continuous' | 'single', callbacks: STTCallbacks): void {
    this.stop()
    const generation = this.generation
    const live = () => generation === this.generation
    void this.record(live, callbacks).catch(() => { if (live()) callbacks.onError('failed') })
  }

  private async record(live: () => boolean, callbacks: STTCallbacks): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      if (live()) callbacks.onError('not-allowed')
      return
    }
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)

    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const parts: Blob[] = []
    recorder.ondataavailable = (event) => parts.push(event.data)

    const started = performance.now()
    let lastSpeech = 0
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length)
      const now = performance.now()
      if (rms > SPEECH_LEVEL) lastSpeech = now
      const finished = lastSpeech ? now - lastSpeech > SILENCE_AFTER_SPEECH_MS : now - started > GIVE_UP_WITHOUT_SPEECH_MS
      if ((finished || now - started > MAX_RECORDING_MS) && recorder.state === 'recording') recorder.stop()
    }, 100)

    const release = () => {
      clearInterval(timer)
      stream.getTracks().forEach((track) => track.stop())
      void context.close()
    }
    this.cleanup = () => {
      release()
      if (recorder.state === 'recording') recorder.stop()
    }
    recorder.onstop = async () => {
      release()
      if (!live()) return
      if (!lastSpeech) return callbacks.onError('no-speech')
      callbacks.onProcessing?.()
      try {
        const text = (await api.transcribe(new Blob(parts, { type: recorder.mimeType }), recognitionLanguage().slice(0, 2))).trim()
        if (!live()) return
        if (text) callbacks.onFinal(text)
        else callbacks.onError('no-speech')
      } catch {
        if (live()) callbacks.onError('network')
      }
    }
    if (!live()) return release()
    recorder.start()
  }

  stop(): void {
    this.generation++
    this.cleanup?.()
    this.cleanup = null
  }
}
