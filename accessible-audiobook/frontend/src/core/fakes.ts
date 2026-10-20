/**
 * Stand-ins for the speech engines, used only by the tests. They let the whole
 * interaction be driven deterministically: the test decides when the narrator
 * reaches a word or finishes a sentence, and what the microphone "hears".
 */
import type { STTCallbacks, STTEngine } from './stt'
import type { SpeakCallbacks, SpeakOptions, TTSEngine } from './tts'

/** The pitch the tests give the assistant's voice, which is how the fake tells the two voices apart. */
export const ASSISTANT_PITCH = 1.25

/** The narrator's utterances are finished by the test; the assistant's finish by themselves. */
export class FakeTTS implements TTSEngine {
  readonly kind = 'browser' as const
  spoken: { text: string; role: 'narrator' | 'assistant' }[] = []
  failAssistant = false
  private current: { text: string; role: 'narrator' | 'assistant'; callbacks: SpeakCallbacks } | null = null

  speak(text: string, options: SpeakOptions, callbacks: SpeakCallbacks): void {
    this.cancel()
    const role = options.pitch === ASSISTANT_PITCH ? 'assistant' : 'narrator'
    this.spoken.push({ text, role })
    const entry = { text, role, callbacks } as const
    this.current = entry
    if (role === 'assistant') {
      setTimeout(() => {
        if (this.current !== entry) return
        this.current = null
        if (this.failAssistant) callbacks.onError('synthesis-failed')
        else callbacks.onEnd()
      }, 0)
    }
  }

  cancel(): void {
    const entry = this.current
    this.current = null
    entry?.callbacks.onCancel?.()
  }

  /** What the narrator is reading right now (null while silent or while the assistant is talking). */
  get narrating(): string | null {
    return this.current?.role === 'narrator' ? this.current.text : null
  }

  /** The narrator reaches the word starting at `charIndex` of the current utterance. */
  boundary(charIndex: number): void {
    this.current?.callbacks.onBoundary?.(charIndex)
  }

  endNarration(): void {
    const entry = this.current
    this.current = null
    entry?.callbacks.onEnd()
  }

  said(role: 'narrator' | 'assistant'): string[] {
    return this.spoken.filter((s) => s.role === role).map((s) => s.text)
  }
}

export class FakeSTT implements STTEngine {
  readonly kind = 'browser' as const
  readonly continuous = true
  mode: 'continuous' | 'single' | null = null
  private callbacks: STTCallbacks | null = null

  start(mode: 'continuous' | 'single', callbacks: STTCallbacks): void {
    this.mode = mode
    this.callbacks = callbacks
  }

  stop(): void {
    this.mode = null
    this.callbacks = null
  }

  interim(text: string): void { this.callbacks?.onInterim?.(text) }
  final(text: string, alternatives: string[] = []): void { this.callbacks?.onFinal(text, alternatives) }
  error(code: 'no-speech' | 'not-allowed' | 'network'): void { this.callbacks?.onError(code) }
  /** A voice is heard, before any words are known (the echo-cancelled microphone + Whisper listener). */
  speechStart(): void { this.callbacks?.onSpeechStart?.() }
  dismiss(): void { this.callbacks?.onDismissed?.() }
}

/** Wait for something asynchronous to become true. */
export async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}
