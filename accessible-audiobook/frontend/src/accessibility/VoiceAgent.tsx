/**
 * The conversational layer for every screen except the player (which has its
 * own, richer one inside the controller).
 *
 * One microphone listener serves the whole app. What it hears - or what is typed
 * into the command box - is offered first to the current page ("open operating
 * systems"), then to the app-wide grammar (navigation, any setting, help, speed,
 * volume), and finally, when a language model is configured, to the model, which
 * works out what was meant.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { SPOKEN_HELP } from '../components/HelpContent'
import { Icon } from '../components/Icon'
import { stopUiSpeech, uiSay } from '../core/audio'
import { earcons } from '../core/earcons'
import { hasNonLatinWords, needsInterpreting, parseIntent, type Intent, type Page } from '../core/intents'
import { getLastBook } from '../core/libraryVoice'
import { getSettings, RATES, step, updateSettings } from '../core/settings'
import { describeSettings } from '../core/settingsVoice'
import { useCapabilities } from '../hooks/useCapabilities'
import { useVoiceCommands } from '../hooks/useVoiceCommands'
import { api, type Interpretation } from '../services/api'
import { useAnnounce } from './Announcer'
import { useFocusSpeech } from './focusSpeech'
import { useShortcuts } from './useShortcuts'

/** Returns true if the page dealt with the phrase. */
type PageHandler = (phrase: string) => boolean

interface VoiceApi {
  setPageHandler: (handler: PageHandler | null, books?: string[]) => void
  /** Speak, or hand to the screen reader, depending on how the user set the app up. */
  tell: (text: string) => void
}

const VoiceContext = createContext<VoiceApi>({ setPageHandler: () => undefined, tell: () => undefined })

export function useVoice(): VoiceApi {
  return useContext(VoiceContext)
}

/** Let a page handle its own spoken commands. `books` helps the language model resolve "open the OS one". */
export function usePageVoice(handler: PageHandler, books: string[] = []): void {
  const { setPageHandler } = useVoice()
  const latest = useRef(handler)
  useEffect(() => { latest.current = handler })
  const titles = books.join('|')
  useEffect(() => {
    setPageHandler((phrase) => latest.current(phrase), titles ? titles.split('|') : [])
    return () => setPageHandler(null)
  }, [setPageHandler, titles])
}

const PAGE_NAMES: Record<string, string> = { '/': 'My books', '/settings': 'Settings', '/help': 'Help', '/evaluation': 'the evaluation dashboard' }
const PATHS: Record<Page, string> = { library: '/', settings: '/settings', help: '/help', evaluation: '/evaluation' }

const STATUS = {
  listening: 'Listening. Say what you want: for example "open operating systems", "yellow theme" or "go to settings".',
  off: 'The microphone is off. Press M to turn it on, or type a command below.',
  unsupported: 'Voice control needs Chrome or Edge. You can type the same commands below.',
  blocked: 'The microphone is blocked. Allow it from the icon in the address bar, then reload the page. You can type commands below.',
  network: 'This browser could not reach its speech recognition service. Use Google Chrome or Microsoft Edge (not an editor preview, Brave or Opera) and check your internet connection. You can type commands below.',
  error: 'Voice control could not start. You can type commands below.',
} as const

export function VoiceAgent({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const announce = useAnnounce()
  const capabilities = useCapabilities()
  const pageHandler = useRef<PageHandler | null>(null)
  const books = useRef<string[]>([])
  const lastSaid = useRef('')
  const commandBox = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState('')
  const inPlayer = pathname.startsWith('/read/')

  const tell = useCallback((text: string) => {
    lastSaid.current = text
    if (getSettings().screenReaderMode) announce(text)
    else void uiSay(text, capabilities)
  }, [announce, capabilities])

  // Name each control as the keyboard reaches it, for people without a screen reader.
  useFocusSpeech((text) => void uiSay(text, capabilities))

  const act = useCallback((intent: Intent): boolean => {
    switch (intent.type) {
      case 'goto':
        navigate(PATHS[intent.page])
        tell(`${PAGE_NAMES[PATHS[intent.page]]}.`)
        return true
      case 'library':
        navigate('/')
        return true
      case 'setting':
        updateSettings(intent.patch)
        earcons.play('tick')
        tell(intent.say)
        return true
      case 'describeSettings':
        tell(describeSettings(getSettings()))
        return true
      case 'help':
        tell(SPOKEN_HELP)
        return true
      case 'where':
        tell(`You are on ${PAGE_NAMES[pathname] ?? 'this page'}. Say "go to my books", "go to settings" or "go to help" to move.`)
        return true
      case 'speed': {
        const rate = intent.change === 'set' ? Math.min(3, Math.max(0.5, intent.value ?? 1)) : step(RATES, getSettings().rate, intent.change === 'up' ? 1 : -1)
        updateSettings({ rate })
        tell(`Speed ${rate} times.`)
        return true
      }
      case 'volume': {
        const volume = Math.round(Math.min(1, Math.max(0.1, getSettings().volume + (intent.change === 'up' ? 0.2 : -0.2))) * 10) / 10
        updateSettings({ volume })
        tell(`Volume ${Math.round(volume * 100)} percent.`)
        return true
      }
      case 'repeat':
        if (lastSaid.current) tell(lastSaid.current)
        return true
      case 'pause':
      case 'stop':
      case 'cancel':
        stopUiSpeech()
        return true
      case 'reply':
        tell(intent.text)
        return true
      case 'play':
      case 'resume': {
        // "Continue" from Settings or Help: go back to the book that was being read.
        const last = getLastBook()
        if (last) {
          stopUiSpeech()
          navigate(`/read/${last}`, { state: { autoplay: true } })
        } else {
          navigate('/')
          tell('Which book? Say "open", then the name of a book.')
        }
        return true
      }
      case 'unknown':
        return false
      default:
        // A real command, but one that needs a book: reading, questions, notes, finding, skimming.
        tell('That works once a book is open. Say "continue", or "open" and the name of a book.')
        return true
    }
  }, [navigate, pathname, tell])

  const understand = useCallback((phrase: string): boolean => pageHandler.current?.(phrase) || act(parseIntent(phrase)), [act])

  /** Everything said or typed outside the player goes through here. */
  const handle = useCallback((phrase: string, wasTyped: boolean) => {
    if (pageHandler.current?.(phrase)) return
    const intent = parseIntent(phrase)
    // Speech that matches nothing is probably not meant for the app; something typed certainly was.
    const ownReading = () => {
      if (!act(intent) && wasTyped) tell('I did not understand that. Try "continue", "open" and a book name, "go to settings", or "help".')
    }
    // A phrase the grammar does not know, or only guessed at from a key word, goes to the language model
    // first: it understands indirect requests, Indian English, Hindi and Hinglish.
    const worthAsking = phrase.trim().split(/\s+/).length >= 2 || hasNonLatinWords(phrase)
    if (!needsInterpreting(intent) || !capabilities || capabilities.llm_is_local_fallback || !worthAsking) return ownReading()
    let timer: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      api.interpret({ utterance: phrase, page: PAGE_NAMES[pathname] ?? 'app', state: '', books: books.current }),
      new Promise<Interpretation>((resolve) => { timer = setTimeout(() => resolve({ kind: 'ignore', failed: true }), 4000) }),
    ]).then((meaning) => {
      if (meaning.kind === 'command' && understand(meaning.command)) return
      if (meaning.kind === 'reply') tell(meaning.text)
      else if (meaning.kind === 'question') tell('Open a book first, then ask me about it. Say "continue", or "open" and the name of a book.')
      else ownReading() // the model was unreachable or made nothing of it: the grammar's own reading stands
    }, ownReading).finally(() => clearTimeout(timer))
  }, [act, capabilities, pathname, tell, understand])

  const voice = useVoiceCommands((phrase) => handle(phrase, false), !inPlayer && capabilities !== undefined, capabilities ?? null)

  const toggleMic = () => {
    const on = getSettings().micMode !== 'always'
    updateSettings({ micMode: on ? 'always' : 'push' })
    earcons.play('tick')
    tell(on ? 'Microphone on. I am listening.' : 'Microphone off. Press M to turn it back on.')
  }
  const focusCommandBox = () => commandBox.current?.focus()
  useShortcuts({ m: toggleMic, t: focusCommandBox, '/': focusCommandBox }, !inPlayer)

  const setPageHandler = useCallback((handler: PageHandler | null, titles: string[] = []) => {
    pageHandler.current = handler
    books.current = titles
  }, [])

  return (
    <VoiceContext.Provider value={{ setPageHandler, tell }}>
      {!inPlayer && (
        <section aria-label="Voice and typed commands" className="mb-5 flex flex-col gap-3">
          <p className="m-0 flex flex-wrap items-center gap-2 font-bold" role="status">
            <Icon name={voice.status === 'listening' ? 'mic' : 'micOff'} /> {STATUS[voice.status]}
            {voice.detail && <span className="font-normal text-muted">(browser error: {voice.detail})</span>}
            {(voice.status === 'network' || voice.status === 'error') && (
              <button type="button" className="btn" onClick={voice.retry}>Try the microphone again</button>
            )}
            {voice.heard && <span className="font-normal text-muted">Last heard: &ldquo;{voice.heard}&rdquo;</span>}
          </p>
          {/* Anything that can be said can be typed: for braille displays, quiet rooms, and a blocked microphone. */}
          <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
            event.preventDefault()
            if (typed.trim()) handle(typed, true)
            setTyped('')
          }}>
            <label htmlFor="global-command" className="font-bold">
              Type a command <span className="kbd" aria-hidden="true">T</span>
            </label>
            <input ref={commandBox} id="global-command" className="field min-w-48 flex-1" value={typed} autoComplete="off"
              onChange={(event) => setTyped(event.target.value)} placeholder="For example: open operating systems"
              onKeyDown={(event) => { if (event.key === 'Escape') event.currentTarget.blur() }} />
            <button type="submit" className="btn">Send</button>
          </form>
        </section>
      )}
      {children}
    </VoiceContext.Provider>
  )
}
