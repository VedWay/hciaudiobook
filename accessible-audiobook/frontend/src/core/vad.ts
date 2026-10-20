/**
 * Voice activity detection: cuts a continuous microphone signal into utterances.
 *
 * It follows the room's background level and treats sound well above it as a voice. An
 * utterance starts with a short lead-in from just before the voice was noticed (so the first
 * consonant is not clipped) and ends after a pause. Clicks, coughs and bumps are too short to
 * count and are dropped without being sent anywhere.
 */
export const VAD_SAMPLE_RATE = 16000

export interface SegmenterOptions {
  /** Sound below this level is never a voice, however quiet the room. */
  minLevel: number
  /** How far above the background a voice must be. */
  ratio: number
  /** Voiced sound needed before "someone is speaking" is reported. */
  startMs: number
  /** An utterance with less voiced sound than this is a noise, not speech. */
  minVoicedMs: number
  /** A pause this long ends the utterance. */
  endSilenceMs: number
  /** Kept from before the voice was noticed. */
  leadInMs: number
  maxMs: number
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  minLevel: 0.012, ratio: 3, startMs: 150, minVoicedMs: 220, endSilenceMs: 750, leadInMs: 350, maxMs: 20_000,
}

export interface SegmenterEvents {
  /** A voice has been going for long enough to be someone speaking. */
  onSpeechStart(): void
  /** The utterance is over. `samples` is null when it turned out too short to be speech. */
  onSpeechEnd(samples: Float32Array | null): void
}

function level(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / Math.max(1, frame.length))
}

export class VoiceSegmenter {
  private readonly options: SegmenterOptions
  private readonly events: SegmenterEvents
  private background = 0.004
  private leadIn: Float32Array[] = []
  private leadInMs = 0
  private frames: Float32Array[] = []
  private active = false
  private announced = false
  private voicedMs = 0
  private silentMs = 0
  private totalMs = 0

  constructor(events: SegmenterEvents, options: Partial<SegmenterOptions> = {}) {
    this.events = events
    this.options = { ...DEFAULT_SEGMENTER, ...options }
  }

  /** The level above which sound counts as a voice right now. */
  get threshold(): number {
    return Math.max(this.options.minLevel, this.background * this.options.ratio)
  }

  /** Feed the next stretch of 16 kHz audio. */
  push(frame: Float32Array): void {
    const o = this.options
    const ms = (frame.length / VAD_SAMPLE_RATE) * 1000
    const loud = level(frame)
    const voiced = loud > this.threshold

    if (!this.active) {
      if (!voiced) {
        // Quiet: learn the room's background level, and keep a little audio in hand.
        this.background = 0.95 * this.background + 0.05 * loud
        this.leadIn.push(frame)
        this.leadInMs += ms
        while (this.leadInMs - (this.leadIn[0].length / VAD_SAMPLE_RATE) * 1000 >= o.leadInMs) {
          this.leadInMs -= (this.leadIn.shift()!.length / VAD_SAMPLE_RATE) * 1000
        }
        return
      }
      this.active = true
      this.announced = false
      this.frames = [...this.leadIn]
      this.leadIn = []
      this.leadInMs = 0
      this.voicedMs = this.silentMs = this.totalMs = 0
    }

    this.frames.push(frame)
    this.totalMs += ms
    if (voiced) {
      this.voicedMs += ms
      this.silentMs = 0
      if (!this.announced && this.voicedMs >= o.startMs) {
        this.announced = true
        this.events.onSpeechStart()
      }
    } else {
      this.silentMs += ms
    }

    // A noise that never became speech is dropped quickly, so it cannot hold the microphone.
    const fizzled = !this.announced && this.silentMs >= 300
    if (fizzled || this.silentMs >= o.endSilenceMs || this.totalMs >= o.maxMs) this.finish()
  }

  private finish(): void {
    const { frames, announced, voicedMs, totalMs } = this
    const speech = announced && voicedMs >= this.options.minVoicedMs
    if (totalMs >= this.options.maxMs) {
      // Constant sound louder than the background (a fan switched on, music): it is the new background.
      this.background = Math.max(this.background, level(concat(frames)) * 0.6)
    }
    this.active = false
    this.frames = []
    if (!announced) return // never reported as speech, so there is nothing to end
    this.events.onSpeechEnd(speech ? concat(frames) : null)
  }

  reset(): void {
    this.active = false
    this.frames = []
    this.leadIn = []
    this.leadInMs = 0
  }
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((sum, f) => sum + f.length, 0))
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/** Reduce audio to 16 kHz by averaging neighbouring samples (enough for speech recognition). */
export function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === VAD_SAMPLE_RATE) return input
  const ratio = fromRate / VAD_SAMPLE_RATE
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / (end - start)
  }
  return out
}

/** A mono 16-bit WAV file: understood by every speech service, and small for a few seconds of speech. */
export function encodeWav(samples: Float32Array, sampleRate = VAD_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
