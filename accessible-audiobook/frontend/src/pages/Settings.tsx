import { useEffect, useState, type ReactNode } from 'react'
import { stopUiSpeech, voiceOptions } from '../core/audio'
import { getTTS } from '../core/audio'
import { earcons } from '../core/earcons'
import { DEFAULT_SETTINGS, FONT_SCALES, naturalVoice, RATES, recognitionLanguage, updateSettings, useSettings, type Settings } from '../core/settings'
import { browserSTTAvailable } from '../core/stt'
import { listVoices } from '../core/tts'
import { useCapabilities } from '../hooks/useCapabilities'
import { api, ApiError, setToken } from '../services/api'
import type { VoiceCatalogue } from '../types'

const LANGUAGE_NAMES: Record<string, string> = {
  'en-IN': 'Indian English', 'hi-IN': 'Hindi', 'mr-IN': 'Marathi', 'en-US': 'American English', 'en-GB': 'British English',
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="card flex flex-col gap-5">
      <h2 id={id} className="m-0 text-2xl">{title}</h2>
      {children}
    </section>
  )
}

/** A group of large radio "cards": one press, no dropdown to open, the current choice always visible. */
function Choice<T extends string | number>({ legend, hint, value, options, onChange }: {
  legend: string; hint?: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void
}) {
  const name = legend.replace(/\W+/g, '-').toLowerCase()
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="p-0 text-lg font-bold">{legend}</legend>
      {hint && <p className="m-0 mb-2 text-muted">{hint}</p>}
      <div className="mt-2 flex flex-wrap gap-3">
        {options.map((option) => (
          <label key={String(option.value)} className={`btn cursor-pointer ${option.value === value ? 'border-accent' : 'btn-quiet'}`}>
            <input type="radio" name={name} checked={option.value === value} onChange={() => onChange(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="block text-lg font-bold">{label}</span>
        {/* data-hint: when controls are read aloud, the hint is said after the name and state, not inside the name. */}
        {hint && <span className="block text-muted" data-hint>{hint}</span>}
      </span>
    </label>
  )
}

export default function SettingsPage() {
  const settings = useSettings()
  const capabilities = useCapabilities()
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [natural, setNatural] = useState<VoiceCatalogue | null>(null)
  const set = (patch: Partial<Settings>) => updateSettings(patch)
  const hasServerVoice = !!capabilities?.server_tts

  useEffect(() => {
    // Every language, not just English (the book may be in another one), grouped by language.
    void listVoices().then((all) => setVoices([...all].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))))
    return stopUiSpeech
  }, [])

  useEffect(() => {
    if (hasServerVoice) void api.voices().then(setNatural).catch(() => setNatural(null))
  }, [hasServerVoice])

  const preview = (role: 'narrator' | 'assistant') => {
    const text = role === 'narrator'
      ? 'This is the narrator, reading your textbook at the speed you chose. Stacks are last in, first out.'
      : 'And this is the assistant, answering your question.'
    getTTS(capabilities ?? null)?.speak(text, voiceOptions(role), { onEnd: () => undefined, onError: () => undefined })
  }

  const voiceSelect = (id: string, label: string, key: 'narratorVoice' | 'assistantVoice', role: 'narrator' | 'assistant') => (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={id} className="flex min-w-64 flex-1 flex-col gap-1 text-lg font-bold">
        {label}
        <select id={id} className="field font-normal" value={settings[key]} onChange={(event) => set({ [key]: event.target.value })}>
          <option value="">Automatic</option>
          {voices.map((voice) => (
            <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang}){voice.localService ? '' : ' - online'}</option>
          ))}
        </select>
      </label>
      <button type="button" className="btn" onClick={() => preview(role)}>Hear the {role}</button>
    </div>
  )

  // With nothing chosen: an Indian English voice on a device set up for India, otherwise the server's own default.
  const defaultVoice = (role: 'narrator' | 'assistant') =>
    naturalVoice(role, { ...settings, serverNarratorVoice: '', serverAssistantVoice: '' }) || natural?.defaults[role] || ''

  const naturalSelect = (id: string, label: string, key: 'serverNarratorVoice' | 'serverAssistantVoice', role: 'narrator' | 'assistant') => (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={id} className="flex min-w-64 flex-1 flex-col gap-1 text-lg font-bold">
        {label}
        <select id={id} className="field font-normal" value={settings[key]} onChange={(event) => set({ [key]: event.target.value })}>
          <option value="">Default{natural ? ` (${natural.voices.find((v) => v.id === defaultVoice(role))?.label ?? defaultVoice(role)})` : ''}</option>
          {natural?.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
        </select>
      </label>
      <button type="button" className="btn" onClick={() => preview(role)}>Hear the {role}</button>
    </div>
  )

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 text-4xl">Settings</h1>
        <p className="m-0 mt-2 text-xl text-muted">
          Changes apply immediately and are remembered on this device. Every setting can also be changed by voice,
          from any screen: say &ldquo;yellow theme&rdquo;, &ldquo;bigger text&rdquo;, &ldquo;short answers&rdquo;,
          &ldquo;sounds only&rdquo;, or &ldquo;what are my settings&rdquo;.
        </p>
      </div>

      <Section id="set-speech" title="Voice">
        <Choice legend="Reading speed" value={settings.rate} onChange={(rate) => set({ rate })}
          options={RATES.map((rate) => ({ value: rate, label: `${rate}×` }))} />
        <label className="flex flex-col gap-1 text-lg font-bold">
          Volume: {Math.round(settings.volume * 100)}%
          <input type="range" min={0.1} max={1} step={0.1} value={settings.volume}
            aria-valuetext={`${Math.round(settings.volume * 100)} percent`}
            onChange={(event) => set({ volume: Number(event.target.value) })} />
        </label>
        {capabilities?.server_tts && (
          <Choice legend="Voice" hint="The natural voice needs an internet connection. If it cannot be reached, this device's voice takes over automatically."
            value={settings.speechEngine === 'server' ? 'auto' : settings.speechEngine} onChange={(speechEngine) => set({ speechEngine })}
            options={[{ value: 'auto', label: 'Natural voice' }, { value: 'browser', label: "This device's voice" }]} />
        )}
        {hasServerVoice && settings.speechEngine !== 'browser' && (
          <>
            {naturalSelect('natural-narrator', 'Narrator voice (reads the book)', 'serverNarratorVoice', 'narrator')}
            {naturalSelect('natural-assistant', 'Assistant voice (answers questions)', 'serverAssistantVoice', 'assistant')}
            <p className="m-0 text-muted">
              These voices read other languages too: a Spanish or French passage, or a Hindi, Arabic or Chinese one,
              is read in the right language and accent automatically. You can also say &ldquo;male voice&rdquo;,
              &ldquo;female voice&rdquo; or &ldquo;change the voice&rdquo; at any time.
            </p>
          </>
        )}
        {(settings.speechEngine === 'browser' || !hasServerVoice) && (
          <>
            {voiceSelect('narrator-voice', 'Narrator voice (reads the book)', 'narratorVoice', 'narrator')}
            {voiceSelect('assistant-voice', 'Assistant voice (answers questions)', 'assistantVoice', 'assistant')}
            <p className="m-0 text-muted">
              Two different voices make it easy to tell the book from the answers. If your device has only one voice,
              the assistant speaks at a higher pitch instead. Voices marked &ldquo;online&rdquo; may not report word
              positions, so resuming is accurate to the sentence rather than the word.
            </p>
          </>
        )}
      </Section>

      <Section id="set-questions" title="Asking questions">
        <Choice legend="I speak" value={settings.speechLanguage} onChange={(speechLanguage) => set({ speechLanguage })}
          hint={`The accent and language the microphone listens for. Automatic is currently ${LANGUAGE_NAMES[recognitionLanguage(settings)] ?? recognitionLanguage(settings)}. Commands and questions in Hindi, Marathi or mixed with English are understood either way; choosing your language makes them heard correctly. You can also say "I speak Hindi".`}
          options={[
            { value: 'auto', label: 'Automatic' }, { value: 'en-IN', label: 'Indian English' }, { value: 'hi-IN', label: 'Hindi' },
            { value: 'mr-IN', label: 'Marathi' }, { value: 'en-US', label: 'American English' }, { value: 'en-GB', label: 'British English' },
          ]} />
        {capabilities?.server_stt && (
          <Choice legend="How I listen" value={settings.listenEngine} onChange={(listenEngine) => set({ listenEngine })}
            hint="Whisper removes the book's own voice from what the microphone hears and copes much better with accents, Hindi and noise. It needs an internet connection; if the connection drops, the browser's recogniser takes over by itself."
            options={[{ value: 'auto', label: 'Whisper (recommended)' }, { value: 'browser', label: "This browser's recogniser" }]} />
        )}
        <Choice legend="Microphone" value={settings.micMode} onChange={(micMode) => set({ micMode })}
          hint={browserSTTAvailable()
            ? 'Always listening lets you interrupt hands-free. Headphones stop the microphone from hearing the audiobook.'
            : 'This browser cannot listen continuously. Press A, then speak or type your question.'}
          options={[{ value: 'always', label: 'Always listening' }, { value: 'push', label: 'Only when I press A' }]} />
        <Toggle label="Pause as soon as I start speaking" checked={settings.bargeIn} onChange={(bargeIn) => set({ bargeIn })}
          hint="The book stops the moment it hears you, instead of talking over your question." />
        <Toggle label="Go back to the book automatically after an answer" checked={settings.autoResume} onChange={(autoResume) => set({ autoResume })}
          hint={'When off, the book stays paused until you press Space or say "continue".'} />
        <Choice legend="After an answer, continue from" value={settings.resumeMode} onChange={(resumeMode) => set({ resumeMode })}
          options={[
            { value: 'exact', label: 'The exact word' },
            { value: 'sentence', label: 'The start of that sentence' },
            { value: 'previous', label: 'One sentence earlier' },
          ]} />
        <Choice legend="Wait for a follow-up question" hint="After each answer, listen for a moment before going back to the book."
          value={settings.followUpSeconds} onChange={(followUpSeconds) => set({ followUpSeconds })}
          options={[{ value: 0, label: 'Do not wait' }, { value: 4, label: '4 seconds' }, { value: 8, label: '8 seconds' }]} />
        <Choice legend="Answer length" value={settings.answerLength} onChange={(answerLength) => set({ answerLength })}
          options={[{ value: 'brief', label: 'Short' }, { value: 'detailed', label: 'More detailed' }]} />
        <Toggle label="Say where in the book each answer comes from" checked={settings.speakSources} onChange={(speakSources) => set({ speakSources })} />
      </Section>

      <Section id="set-feedback" title="Spoken feedback and sounds">
        <Choice legend="How much the app says about what it is doing" value={settings.verbosity} onChange={(verbosity) => set({ verbosity })}
          hint="New users usually prefer full sentences. Experienced users often prefer short words, or sounds only."
          options={[
            { value: 'full', label: 'Full sentences' },
            { value: 'brief', label: 'Short words' },
            { value: 'earcons', label: 'Sounds only' },
          ]} />
        <Toggle label="I use a screen reader" checked={settings.screenReaderMode} onChange={(screenReaderMode) => set({ screenReaderMode })}
          hint="Status messages are sent to your screen reader instead of being spoken by the app, so two voices never talk at once. The book and the answers are still read by the app." />
        {!settings.screenReaderMode && (
          <Toggle label="Name each button and field as I move to it" checked={settings.speakFocus} onChange={(speakFocus) => set({ speakFocus })}
            hint="When you press Tab, the app says what you have landed on, for example: Ask a question, button. For people who do not use a screen reader." />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Toggle label="Sound cues" checked={settings.earcons} onChange={(value) => set({ earcons: value })}
            hint="Short tones for listening, thinking, answers and errors." />
          <button type="button" className="btn" onClick={() => { earcons.unlock(); earcons.play('listen') }}>Play the &ldquo;listening&rdquo; sound</button>
        </div>
        <Toggle label="Vibration on phones and tablets" checked={settings.haptics} onChange={(haptics) => set({ haptics })} />
      </Section>

      <Section id="set-display" title="Display">
        <Choice legend="Colours" value={settings.theme} onChange={(theme) => set({ theme })}
          options={[
            { value: 'dark', label: 'High contrast dark' },
            { value: 'yellow', label: 'Yellow on black' },
            { value: 'light', label: 'High contrast light' },
          ]} />
        <Choice legend="Text size" value={settings.fontScale} onChange={(fontScale) => set({ fontScale })}
          options={FONT_SCALES.map((scale) => ({ value: scale, label: `${Math.round(scale * 100)}%` }))} />
        <Choice legend="Motion" value={settings.motion} onChange={(motion) => set({ motion })}
          options={[
            { value: 'system', label: 'Follow my device' },
            { value: 'reduce', label: 'Reduce motion' },
            { value: 'full', label: 'Allow motion' },
          ]} />
        <Toggle label="Highlight each word as it is read" checked={settings.highlightWords} onChange={(highlightWords) => set({ highlightWords })} />
      </Section>

      <Account />

      <Section id="set-system" title="About this installation">
        {capabilities ? (
          <dl className="m-0 grid gap-x-6 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <dt className="font-bold">Answers</dt><dd className="m-0">{capabilities.llm}{capabilities.llm_is_local_fallback && ' (offline fallback: quotes the textbook, no AI model configured)'}</dd>
            <dt className="font-bold">Search embeddings</dt><dd className="m-0">{capabilities.embeddings}</dd>
            <dt className="font-bold">Vector database</dt><dd className="m-0">{capabilities.vector_store}</dd>
            <dt className="font-bold">Speech recognition</dt><dd className="m-0">{browserSTTAvailable() ? 'This browser' : capabilities.server_stt ?? 'Not available: type your questions'}</dd>
            <dt className="font-bold">Server voice</dt><dd className="m-0">{capabilities.server_tts ?? 'Not configured'}</dd>
            <dt className="font-bold">Picture descriptions</dt><dd className="m-0">{capabilities.picture_descriptions ?? 'Off: no vision model is configured, so pictures in books are passed over'}</dd>
          </dl>
        ) : <p className="m-0">{capabilities === null ? 'The server could not be reached.' : 'Loading…'}</p>}
        <button type="button" className="btn self-start" onClick={() => updateSettings({ ...DEFAULT_SETTINGS, onboarded: true })}>Reset all settings</button>
      </Section>
    </div>
  )
}

/** Optional sign-in. A guest account is created automatically; registering keeps books and positions across devices. */
function Account() {
  const [user, setUser] = useState<{ display_name: string; email: string | null; is_guest: boolean } | null>(null)
  const [mode, setMode] = useState<'register' | 'login'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => { void api.me().then(setUser).catch(() => undefined) }, [])

  const submit = async () => {
    setMessage('')
    try {
      const result = mode === 'register' ? await api.register(email, password, '') : await api.login(email, password)
      setToken(result.access_token)
      setUser(await api.me())
      setPassword('')
      setMessage(mode === 'register' ? 'Account created. Your books and reading positions are now saved to it.' : 'Signed in.')
    } catch (caught) {
      setMessage(caught instanceof ApiError
        ? (caught.status === 422 ? 'Enter a valid email address and a password of at least 8 characters.' : caught.message)
        : 'The server could not be reached.')
    }
  }

  return (
    <Section id="set-account" title="Account">
      {user && !user.is_guest ? (
        <p className="m-0 text-lg">Signed in as <strong>{user.email}</strong>.</p>
      ) : (
        <>
          <p className="m-0 text-muted">
            You are using a guest account on this device, so there is nothing to sign in to before you can listen.
            Create an account if you want your books and reading positions kept under an email address.
          </p>
          <Choice legend="I want to" value={mode} onChange={setMode}
            options={[{ value: 'register', label: 'Create an account' }, { value: 'login', label: 'Sign in' }]} />
          <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <label className="flex flex-col gap-1 font-bold">
              Email
              <input className="field font-normal" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 font-bold">
              Password <span className="font-normal text-muted">(at least 8 characters)</span>
              <input className="field font-normal" type="password" required minLength={8}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <button type="submit" className="btn btn-primary self-start">{mode === 'register' ? 'Create account' : 'Sign in'}</button>
          </form>
        </>
      )}
      {message && <p role="status" className="m-0 font-bold">{message}</p>}
    </Section>
  )
}
