/** User preferences: persisted locally, readable both from React and from the audio engine. */
import { useSyncExternalStore } from 'react'

export interface Settings {
  rate: number
  volume: number
  narratorVoice: string // voiceURI, '' = automatic
  assistantVoice: string
  theme: 'dark' | 'yellow' | 'light'
  fontScale: number
  motion: 'system' | 'reduce' | 'full'
  /** How much the app says about what it is doing: sentences, single words, or tones only. */
  verbosity: 'full' | 'brief' | 'earcons'
  earcons: boolean
  haptics: boolean
  /** Route status messages to the user's screen reader instead of the app's own voice. */
  screenReaderMode: boolean
  /**
   * Say the name of each button, link and field as the keyboard reaches it. For people who
   * rely on the app's own voice and have no screen reader; ignored in screen-reader mode.
   */
  speakFocus: boolean
  micMode: 'always' | 'push'
  /** Pause the book the moment the student starts speaking, before the phrase is finished. */
  bargeIn: boolean
  autoResume: boolean
  resumeMode: 'exact' | 'sentence' | 'previous'
  followUpSeconds: number
  answerLength: 'brief' | 'detailed'
  speakSources: boolean
  highlightWords: boolean
  /** auto = the server's natural voice when there is one, otherwise this device's voices */
  speechEngine: 'auto' | 'browser' | 'server'
  /** Which natural voice reads the book / the answers; '' = the server's default for that role. */
  serverNarratorVoice: string
  serverAssistantVoice: string
  /**
   * The language and accent the microphone expects. 'auto' follows the device, and means Indian
   * English in India - an American-English recogniser mishears Indian accents and Hindi words.
   */
  speechLanguage: SpeechLanguage
  /**
   * How speech is recognised. auto = an echo-cancelled microphone and Whisper on the server when
   * there is one (far better with accents and with the book playing), else the browser's recogniser.
   */
  listenEngine: 'auto' | 'browser'
  onboarded: boolean
}

export type SpeechLanguage = 'auto' | 'en-IN' | 'hi-IN' | 'mr-IN' | 'en-US' | 'en-GB'

/** Natural voices that "female voice", "male voice", "Indian voice" and "change the voice" choose between. */
export const NARRATOR_VOICES = {
  female: 'en-US-AvaMultilingualNeural',
  male: 'en-US-BrianMultilingualNeural',
  indian: { narrator: 'en-IN-NeerjaExpressiveNeural', assistant: 'en-IN-PrabhatNeural' },
  cycle: ['en-US-AvaMultilingualNeural', 'en-IN-NeerjaExpressiveNeural', 'en-US-EmmaMultilingualNeural', 'en-US-BrianMultilingualNeural',
    'en-IN-PrabhatNeural', 'en-AU-WilliamMultilingualNeural'],
}

/** Is this device set up for India? (Its language list, or failing that its time zone.) */
export function inIndia(): boolean {
  try {
    if (typeof navigator !== 'undefined' && (navigator.languages ?? [navigator.language]).some((l) => /-IN$/i.test(l ?? ''))) return true
    return /^Asia\/(Kolkata|Calcutta)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '')
  } catch {
    return false
  }
}

/** The BCP 47 code the speech recogniser should listen in. */
export function recognitionLanguage(s: Settings = getSettings()): string {
  if (s.speechLanguage !== 'auto') return s.speechLanguage
  if (inIndia()) return 'en-IN'
  const device = typeof navigator !== 'undefined' ? navigator.language ?? '' : ''
  return /^en-/i.test(device) ? device : 'en-US'
}

/** The natural voice for a role: the listener's choice, else Indian English in India, else the server's default (''). */
export function naturalVoice(role: 'narrator' | 'assistant', s: Settings = getSettings()): string {
  const chosen = role === 'narrator' ? s.serverNarratorVoice : s.serverAssistantVoice
  return chosen || (inIndia() ? NARRATOR_VOICES.indian[role] : '')
}

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]
export const FONT_SCALES = [1, 1.25, 1.5, 1.75, 2]

export const DEFAULT_SETTINGS: Settings = {
  rate: 1,
  volume: 1,
  narratorVoice: '',
  assistantVoice: '',
  theme: 'dark',
  fontScale: 1,
  motion: 'system',
  verbosity: 'full',
  earcons: true,
  haptics: true,
  screenReaderMode: false,
  speakFocus: true,
  micMode: 'always',
  bargeIn: true,
  autoResume: true,
  resumeMode: 'exact',
  followUpSeconds: 0,
  answerLength: 'brief',
  speakSources: false,
  highlightWords: true,
  speechEngine: 'auto',
  serverNarratorVoice: '',
  serverAssistantVoice: '',
  speechLanguage: 'auto',
  listenEngine: 'auto',
  onboarded: false,
}

const KEY = 'aa.settings'
const listeners = new Set<() => void>()

function load(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

let current = load()

export function getSettings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Private browsing: the preference still applies for this visit.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings)
}

/** Next value up or down a fixed scale (speed steps, text sizes). */
export function step(values: number[], value: number, direction: 1 | -1): number {
  const nearest = values.reduce((best, v, i) => (Math.abs(v - value) < Math.abs(values[best] - value) ? i : best), 0)
  return values[Math.min(values.length - 1, Math.max(0, nearest + direction))]
}
