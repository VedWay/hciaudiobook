/**
 * Changing settings by voice: "switch to the yellow theme", "make the text
 * bigger", "stop saying so much", "resume from the start of the sentence".
 * Every preference on the Settings screen can be reached this way, so the
 * screen never has to be opened.
 */
import { DEFAULT_SETTINGS, FONT_SCALES, NARRATOR_VOICES, getSettings, naturalVoice, step, type Settings } from './settings'

export interface SettingChange {
  patch: Partial<Settings>
  /** Spoken confirmation. */
  say: string
}

const OFF = /\b(off|disable|disabled|deactivate|stop|no|don't|do not|without|mute|remove|hide)\b/
const QUESTION = /^(what|why|how|who|when|where|which|is|are|was|were|does|do|did)\b/

const onOff = (text: string) => !OFF.test(text)
const state = (on: boolean) => (on ? 'on' : 'off')

function nearest(values: number[], target: number): number {
  return values.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best))
}

/** A setting change requested in `text` (already lower-cased and stripped of punctuation), or null. */
export function parseSetting(text: string): SettingChange | null {
  if (text.split(' ').length > 12 || QUESTION.test(text)) return null
  const s = getSettings()

  if (/\breset (all )?(my |the )?(settings|preferences)\b/.test(text)) {
    return { patch: { ...DEFAULT_SETTINGS, onboarded: true }, say: 'All settings are back to their defaults.' }
  }

  // Display.
  if (/\b(theme|mode|colou?rs?|contrast|background|screen)\b/.test(text) && /\b(yellow|dark|black|light|white|bright)\b/.test(text)) {
    const theme = /\byellow\b/.test(text) ? 'yellow' : /\b(light|white|bright)\b/.test(text) ? 'light' : 'dark'
    return { patch: { theme }, say: { yellow: 'Yellow on black.', light: 'High contrast light theme.', dark: 'High contrast dark theme.' }[theme] }
  }
  if (/\b(text|font|letters|print|writing|words)\b/.test(text) && /\b(big|bigger|larger|large|increase|enlarge|small|smaller|decrease|reduce|size|normal|default|\d+)\b/.test(text)) {
    const number = /\b(\d{2,3})\b/.exec(text)
    const fontScale = number ? nearest(FONT_SCALES, Number(number[1]) / 100)
      : /\b(normal|default)\b/.test(text) ? 1
        : step(FONT_SCALES, s.fontScale, /\b(small|smaller|decrease|reduce)\b/.test(text) ? -1 : 1)
    return { patch: { fontScale }, say: `Text size ${Math.round(fontScale * 100)} percent.` }
  }
  if (/\b(motion|animations?|movement)\b/.test(text) && /\b(reduce|less|off|stop|no|allow|on|more|enable|disable)\b/.test(text)) {
    const reduce = /\b(reduce|less|off|stop|no|disable)\b/.test(text)
    return { patch: { motion: reduce ? 'reduce' : 'full' }, say: reduce ? 'Motion reduced.' : 'Motion allowed.' }
  }
  if (/\bhighlight\w*\b/.test(text)) {
    const on = onOff(text)
    return { patch: { highlightWords: on }, say: `Word highlighting ${state(on)}.` }
  }

  // Answers. (Checked before feedback, so "short answers" is not read as "short feedback".)
  if (/\banswers?\b/.test(text) && /\b(short|shorter|brief|concise|long|longer|detailed|detail|depth)\b/.test(text)) {
    const brief = /\b(short|shorter|brief|concise)\b/.test(text)
    return { patch: { answerLength: brief ? 'brief' : 'detailed' }, say: brief ? 'I will keep answers short.' : 'I will give more detailed answers.' }
  }
  if (/\b(cite|citations?)\b|\b(say|tell|speak|mention|read)\b.*\b(sources?|where (the |each |my )?answers? comes? from)\b/.test(text)) {
    const on = onOff(text)
    return { patch: { speakSources: on }, say: on ? 'I will say where each answer comes from.' : 'I will not read out sources.' }
  }
  if (/\bfollow ?ups?\b/.test(text)) {
    const number = /\b(\d+)\b/.exec(text)
    const followUpSeconds = number ? nearest([0, 4, 8], Number(number[1])) : OFF.test(text) ? 0 : 4
    return { patch: { followUpSeconds }, say: followUpSeconds ? `I will wait ${followUpSeconds} seconds for a follow-up question.` : 'I will not wait for follow-up questions.' }
  }
  if (/\b(resume|continue|restart|pick up|start again|go back)\b.*\b(word|sentence)\b/.test(text)) {
    const resumeMode = /\b(exact|same) word\b/.test(text) ? 'exact'
      : /\b(previous|earlier|before|one sentence back|sentence back)\b/.test(text) ? 'previous' : 'sentence'
    return { patch: { resumeMode }, say: { exact: 'After an answer I will continue from the exact word.', sentence: 'After an answer I will continue from the start of the sentence.', previous: 'After an answer I will continue from one sentence earlier.' }[resumeMode] }
  }
  if (/\bauto(matic(ally)?)? ?(resume|continue)\b|\b(resume|continue|go back) automatically\b/.test(text)) {
    const on = onOff(text)
    return { patch: { autoResume: on }, say: on ? 'I will go back to the book after each answer.' : 'I will stay paused after each answer.' }
  }
  if (/\bbarge ?in\b|\bpause when i (speak|talk|start)\b|\btalk(ing)? over me\b/.test(text)) {
    const on = /\btalk(ing)? over me\b/.test(text) ? true : onOff(text)
    return { patch: { bargeIn: on }, say: on ? 'I will stop reading as soon as you start speaking.' : 'I will keep reading until you finish speaking.' }
  }

  // Feedback.
  if (/\b(sounds?|tones?|beeps?) only\b|\btalk(ing)? (too|so) much\b/.test(text)) {
    return { patch: { verbosity: 'earcons', earcons: true }, say: 'Sounds only.' }
  }
  if (/\b(short|brief|fewer|less) (words?|feedback|prompts?|messages?)\b|\bsay less\b|\bbe brief\b/.test(text)) {
    return { patch: { verbosity: 'brief' }, say: 'Short feedback.' }
  }
  if (/\b(full|long|complete) (sentences?|feedback|prompts?|messages?)\b|\bsay more\b|\bverbose\b/.test(text)) {
    return { patch: { verbosity: 'full' }, say: 'I will describe what I am doing in full sentences.' }
  }
  if (/\b(sound cues?|sounds|tones|beeps|earcons?)\b/.test(text)) {
    const on = onOff(text)
    return { patch: { earcons: on }, say: `Sound cues ${state(on)}.` }
  }
  if (/\b(vibrat\w+|haptics?)\b/.test(text)) {
    const on = onOff(text)
    return { patch: { haptics: on }, say: `Vibration ${state(on)}.` }
  }
  if (/\b(speak|say|read|announce|name)\b.*\b(buttons?|controls?|what i (select|focus|tab to))\b|\bbutton names\b/.test(text)) {
    const on = onOff(text)
    return { patch: { speakFocus: on }, say: on ? 'I will name each button and field as you move through them.' : 'I will stop naming buttons and fields.' }
  }
  if (/\bscreen ?reader\b/.test(text)) {
    const on = onOff(text)
    return { patch: { screenReaderMode: on }, say: on ? 'Screen reader mode on. Status messages will go to your screen reader.' : 'Screen reader mode off. I will speak status messages myself.' }
  }

  // The language and accent the microphone expects: "I speak Hindi", "understand Indian English", "listen in Marathi".
  const speaks = /\b(?:i speak|i am speaking|i'm speaking|i will speak|i talk in|understand|listen (?:in|for|to)|recogni[sz]e|speech language|my language is|switch to|change to)\b.*\b(?<language>hindi|marathi|indian english|american english|us english|british english|uk english)\b/.exec(text)
  if (speaks && !/\b(voice|accent)\b/.test(text)) {
    const language = speaks.groups!.language
    const [speechLanguage, name]: [Settings['speechLanguage'], string] = language === 'hindi' ? ['hi-IN', 'Hindi']
      : language === 'marathi' ? ['mr-IN', 'Marathi']
        : /american|us/.test(language) ? ['en-US', 'American English']
          : /british|uk/.test(language) ? ['en-GB', 'British English'] : ['en-IN', 'Indian English']
    return { patch: { speechLanguage }, say: `I will listen for ${name}.` }
  }

  // Voice and microphone.
  if (/\b(indian|india|desi)\b.*\b(voice|accent|narrator|english)\b|\b(voice|accent)\b.*\b(indian|india)\b/.test(text)) {
    return {
      patch: { speechEngine: 'auto', serverNarratorVoice: NARRATOR_VOICES.indian.narrator, serverAssistantVoice: NARRATOR_VOICES.indian.assistant },
      say: 'Reading in an Indian English voice.',
    }
  }
  if (/\b(american|us|u s)\b.*\b(voice|accent)\b/.test(text)) {
    return { patch: { speechEngine: 'auto', serverNarratorVoice: NARRATOR_VOICES.female, serverAssistantVoice: 'en-US-AndrewMultilingualNeural' }, say: 'Reading in an American voice.' }
  }
  if (/\b(female|woman|woman's|lady)\b.*\bvoice\b|\bvoice\b.*\b(female|woman)\b/.test(text)) {
    return { patch: { speechEngine: 'auto', serverNarratorVoice: NARRATOR_VOICES.female }, say: 'Reading in a female voice.' }
  }
  if (/\bmale\b.*\bvoice\b|\bvoice\b.*\bmale\b|\b(man|man's) voice\b/.test(text)) {
    return { patch: { speechEngine: 'auto', serverNarratorVoice: NARRATOR_VOICES.male }, say: 'Reading in a male voice.' }
  }
  if (/\b(change|switch|different|another|next|new) (the |my |your |reading |narrator |narrator's )*voice\b/.test(text)) {
    const at = NARRATOR_VOICES.cycle.indexOf(naturalVoice('narrator', s) || NARRATOR_VOICES.cycle[0]) // from the voice in use now
    const next = NARRATOR_VOICES.cycle[(at + 1) % NARRATOR_VOICES.cycle.length]
    return { patch: { speechEngine: 'auto', serverNarratorVoice: next }, say: 'This is the new voice reading your book.' }
  }
  if (/\b(natural|neural|human|realistic|better|nicer) voice\b/.test(text)) return { patch: { speechEngine: 'auto' }, say: 'Natural voice.' }
  if (/\b(device|robot|robotic|system|browser|computer|offline|built in) voice\b/.test(text)) return { patch: { speechEngine: 'browser' }, say: "This device's voice." }
  if (/\b(mic|microphone)\b|\b(stop|start|keep|always) listening\b/.test(text)) {
    const on = !/\b(off|stop|mute|disable)\b/.test(text)
    return { patch: { micMode: on ? 'always' : 'push' }, say: on ? 'Microphone on. I am listening.' : 'Microphone off. Press A, or M, when you want me to listen again.' }
  }
  return null
}

/** "What are my settings?" */
export function describeSettings(s: Settings): string {
  const theme = { dark: 'high contrast dark', yellow: 'yellow on black', light: 'high contrast light' }[s.theme]
  const verbosity = { full: 'full sentences', brief: 'short words', earcons: 'sounds only' }[s.verbosity]
  const resume = { exact: 'the exact word', sentence: 'the start of the sentence', previous: 'one sentence earlier' }[s.resumeMode]
  return [
    `Reading speed ${s.rate} times. Volume ${Math.round(s.volume * 100)} percent.`,
    `${s.speechEngine === 'browser' ? "This device's voice" : 'Natural voice'}.`,
    `Microphone ${s.micMode === 'always' ? 'always listening' : 'only when you press A'}.`,
    `Feedback in ${verbosity}. Sound cues ${state(s.earcons)}.`,
    `Answers are ${s.answerLength === 'brief' ? 'short' : 'detailed'}.`,
    s.autoResume ? `After an answer I continue from ${resume}.` : 'After an answer I stay paused.',
    `Theme: ${theme}. Text size ${Math.round(s.fontScale * 100)} percent.`,
    'To change one, just say it. For example: yellow theme, bigger text, or short answers.',
  ].join(' ')
}
