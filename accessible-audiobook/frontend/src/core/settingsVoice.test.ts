import { beforeAll, describe, expect, it, vi } from 'vitest'
import { isCommand, parseIntent } from './intents'
import { DEFAULT_SETTINGS } from './settings'
import { describeSettings } from './settingsVoice'

// The default voice depends on where the device is; pin it so these tests read the same everywhere.
beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'America/New_York' } as Intl.ResolvedDateTimeFormatOptions)
})

describe('settings by voice', () => {
  it.each([
    ['switch to the yellow theme', { theme: 'yellow' }],
    ['dark mode please', { theme: 'dark' }],
    ['can you make the background white', { theme: 'light' }],
    ['make the text bigger', { fontScale: 1.25 }],
    ['set the text size to 200 percent', { fontScale: 2 }],
    ['reduce motion', { motion: 'reduce' }],
    ['turn off word highlighting', { highlightWords: false }],
    ['give me shorter answers', { answerLength: 'brief' }],
    ['I want more detailed answers', { answerLength: 'detailed' }],
    ['tell me where each answer comes from', { speakSources: true }],
    ["don't wait for follow ups", { followUpSeconds: 0 }],
    ['wait 8 seconds for a follow up', { followUpSeconds: 8 }],
    ['resume from the start of the sentence', { resumeMode: 'sentence' }],
    ['continue from the exact word', { resumeMode: 'exact' }],
    ['turn off auto resume', { autoResume: false }],
    ["don't talk over me", { bargeIn: true }],
    ['sounds only', { verbosity: 'earcons', earcons: true }],
    ['you are talking too much', { verbosity: 'earcons', earcons: true }],
    ['short feedback', { verbosity: 'brief' }],
    ['turn the sound cues off', { earcons: false }],
    ['I use a screen reader', { screenReaderMode: true }],
    ['use the natural voice', { speechEngine: 'auto' }],
    ['switch to the device voice', { speechEngine: 'browser' }],
    ['use a female voice', { serverNarratorVoice: 'en-US-AvaMultilingualNeural' }],
    ['switch to a male voice', { serverNarratorVoice: 'en-US-BrianMultilingualNeural' }],
    ['change the voice', { serverNarratorVoice: 'en-IN-NeerjaExpressiveNeural' }],
    ['use an Indian voice', { serverNarratorVoice: 'en-IN-NeerjaExpressiveNeural', serverAssistantVoice: 'en-IN-PrabhatNeural' }],
    ['can you read in an Indian accent', { serverNarratorVoice: 'en-IN-NeerjaExpressiveNeural' }],
    ['I speak Hindi', { speechLanguage: 'hi-IN' }],
    ['please understand Indian English', { speechLanguage: 'en-IN' }],
    ['listen in Marathi', { speechLanguage: 'mr-IN' }],
    ['switch to American English', { speechLanguage: 'en-US' }],
    ['microphone off', { micMode: 'push' }],
    ['stop listening', { micMode: 'push' }],
  ])('%s', (phrase, patch) => {
    const intent = parseIntent(phrase)
    expect(intent).toMatchObject({ type: 'setting', patch })
    expect(intent.type === 'setting' && intent.say.length).toBeGreaterThan(5) // every change is confirmed aloud
  })

  it('resets, describes and navigates', () => {
    expect(parseIntent('reset all my settings')).toMatchObject({ type: 'setting', patch: { theme: 'dark', rate: 1 } })
    expect(parseIntent('what are my settings')).toEqual({ type: 'describeSettings' })
    expect(parseIntent('go to settings')).toEqual({ type: 'goto', page: 'settings' })
    expect(parseIntent('take me to the help page')).toEqual({ type: 'goto', page: 'help' })
    expect(parseIntent('open the evaluation dashboard')).toEqual({ type: 'goto', page: 'evaluation' })
    expect(parseIntent('go home')).toEqual({ type: 'goto', page: 'library' })
    expect(describeSettings(DEFAULT_SETTINGS)).toContain('Reading speed 1 times')
  })

  it('does not mistake questions about the book for settings', () => {
    for (const question of ['What are the sources of page faults?', 'Why is the dark side of the screen mentioned?', 'How does highlighting work in a page table?']) {
      expect(parseIntent(question)).toMatchObject({ type: 'qa', intent: 'question' })
    }
    // Settings phrases are not trusted while the narrator is speaking: they must pass the echo filter.
    expect(isCommand(parseIntent('yellow theme'))).toBe(false)
  })
})
