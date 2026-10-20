/**
 * Earcons: short non-speech sounds that tell a listener what the system is doing
 * faster than words can ("mic is open", "still thinking", "something went wrong").
 * Synthesised with Web Audio, so there are no audio files to load.
 */
export type EarconName =
  | 'listen' | 'heard' | 'answer' | 'pause' | 'resume' | 'error' | 'tick' | 'bookmark' | 'chapter' | 'unknown' | 'think'

type Note = [frequency: number, startSeconds: number, durationSeconds: number, type?: OscillatorType]

const PATTERNS: Record<EarconName, Note[]> = {
  listen: [[660, 0, 0.09], [880, 0.1, 0.14]], // rising: "go ahead"
  heard: [[880, 0, 0.09], [660, 0.1, 0.14]], // falling: "got it"
  answer: [[523, 0, 0.08], [659, 0.08, 0.08], [784, 0.16, 0.16]],
  pause: [[392, 0, 0.12]],
  resume: [[523, 0, 0.08], [784, 0.09, 0.14]],
  error: [[196, 0, 0.16, 'square'], [165, 0.2, 0.24, 'square']],
  tick: [[1046, 0, 0.04]],
  bookmark: [[988, 0, 0.06], [1319, 0.07, 0.1]],
  chapter: [[440, 0, 0.18], [554, 0.2, 0.18], [659, 0.4, 0.3]],
  unknown: [[220, 0, 0.1, 'triangle']],
  think: [[587, 0, 0.05, 'triangle']],
}

export interface EarconPlayer {
  play(name: EarconName): void
  /** A quiet repeating pulse: the audible equivalent of a progress spinner. */
  startThinking(): void
  stopThinking(): void
}

export class Earcons implements EarconPlayer {
  enabled = true
  volume = 1
  private context: AudioContext | null = null
  private thinking: ReturnType<typeof setInterval> | null = null

  /** Must be called from a user gesture; browsers block audio before one. */
  unlock(): void {
    if (typeof AudioContext === 'undefined') return
    this.context ??= new AudioContext()
    void this.context.resume()
  }

  play(name: EarconName): void {
    const context = this.context
    if (!this.enabled || !context || context.state !== 'running') return
    const level = (name === 'think' ? 0.05 : 0.16) * this.volume
    for (const [frequency, start, duration, type] of PATTERNS[name]) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = type ?? 'sine'
      oscillator.frequency.value = frequency
      const t0 = context.currentTime + start
      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(level, t0 + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(t0)
      oscillator.stop(t0 + duration + 0.02)
    }
  }

  startThinking(): void {
    this.stopThinking()
    this.thinking = setInterval(() => this.play('think'), 900)
  }

  stopThinking(): void {
    if (this.thinking) clearInterval(this.thinking)
    this.thinking = null
  }
}

export const earcons = new Earcons()
