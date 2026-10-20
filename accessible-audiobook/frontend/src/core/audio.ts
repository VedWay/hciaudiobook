/** App-wide speech singletons and helpers shared by every page. */
import type { Capabilities } from '../types'
import { earcons } from './earcons'
import { getSettings } from './settings'
import { BrowserSTT, browserSTTAvailable, FallbackSTT, LiveSTT, liveSTTAvailable, ServerSTT, type STTEngine } from './stt'
import { BrowserTTS, browserTTSAvailable, ServerTTS, voiceFor, type SpeakOptions, type TTSEngine } from './tts'

let browserTTS: BrowserTTS | null = null
let serverTTS: ServerTTS | null = null

/** The speech engine for the current settings, or null if this browser cannot speak at all. */
export function getTTS(capabilities: Capabilities | null): TTSEngine | null {
  const wantsServer = getSettings().speechEngine !== 'browser' && !!capabilities?.server_tts
  if (wantsServer || !browserTTSAvailable()) {
    return capabilities?.server_tts ? (serverTTS ??= new ServerTTS()) : null
  }
  return (browserTTS ??= new BrowserTTS())
}

/**
 * The best listener available. With a speech service on the server: an echo-cancelled microphone
 * and Whisper (see LiveSTT), falling back to the browser's own recogniser if the service cannot be
 * reached. Without one: the browser's recogniser. Failing both: one recorded utterance at a time,
 * or typed questions only.
 */
export function createSTT(capabilities: Capabilities | null): STTEngine | null {
  const browser = browserSTTAvailable()
  if (capabilities?.server_stt && liveSTTAvailable() && getSettings().listenEngine !== 'browser') {
    return browser ? new FallbackSTT(new LiveSTT(), () => new BrowserSTT()) : new LiveSTT()
  }
  if (browser) return new BrowserSTT()
  const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  return capabilities?.server_stt && canRecord ? new ServerSTT() : null
}

export function voiceOptions(role: 'narrator' | 'assistant'): SpeakOptions {
  const s = getSettings()
  // The natural voice is read from the settings by the server engine itself; these are the device voice's choices.
  return { rate: s.rate, volume: s.volume, role, ...voiceFor(role, s.narratorVoice, s.assistantVoice) }
}

/** How long after the app stops speaking the recogniser may still report its words. */
const ECHO_LAG_MS = 2500
let lastUiSpeech = ''
let uiSpeaking = 0
let uiSpokeUntil = 0

/**
 * What the microphone could be echoing right now outside the player: whatever the app is
 * saying, or finished saying a moment ago. Older speech is excluded on purpose - after the
 * book list has been read out, saying one of those titles is a request, not an echo.
 */
export function lastSpokenByUi(): string {
  return uiSpeaking > 0 || performance.now() - uiSpokeUntil < ECHO_LAG_MS ? lastUiSpeech : ''
}

/** Speak a page-level message in the assistant's voice. Resolves when finished or cut off. */
export function uiSay(text: string, capabilities: Capabilities | null = null): Promise<void> {
  const tts = getTTS(capabilities)
  if (!tts) return Promise.resolve()
  lastUiSpeech = text
  uiSpeaking++
  return new Promise<void>((resolve) => {
    tts.speak(text, voiceOptions('assistant'), { onEnd: resolve, onCancel: resolve, onError: () => resolve() })
  }).then(() => {
    uiSpeaking--
    uiSpokeUntil = performance.now()
  })
}

export function stopUiSpeech(): void {
  browserTTS?.cancel()
  serverTTS?.cancel()
}

export function syncEarconSettings(): void {
  const s = getSettings()
  earcons.enabled = s.earcons
  earcons.volume = s.volume
}

/**
 * Browsers refuse to play sound until the user has interacted with the page.
 * Called from the first key press or tap.
 */
export function unlockAudio(): void {
  earcons.unlock()
  syncEarconSettings()
  if (browserTTSAvailable()) {
    speechSynthesis.cancel()
    speechSynthesis.getVoices() // start loading the voice list
  }
}
