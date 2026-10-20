/** Presentational pieces of the player screen. All behaviour lives in the controller. */
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ControllerState } from '../core/controller'
import { detectScriptLanguage } from '../core/lang'
import { PHASES } from '../core/phaseInfo'
import type { ReadItem } from '../core/reader'
import type { Capabilities } from '../types'
import { Icon, type IconName } from './Icon'

/** "Sleep timer: 14 minutes left", "Stops at the end of this chapter", or '' when no timer is set. */
export function sleepLabel(state: Pick<ControllerState, 'sleepUntil' | 'sleepAt'>): string {
  if (state.sleepAt) return `Stops at the end of this ${state.sleepAt}`
  if (state.sleepUntil === null) return ''
  const minutes = Math.max(1, Math.ceil((state.sleepUntil - Date.now()) / 60_000))
  return `Sleep timer: ${minutes} minute${minutes === 1 ? '' : 's'} left`
}

/** The large "what is happening right now" indicator: orb + word + hint. */
export function StatusHero({ state }: { state: ControllerState }) {
  const info = PHASES[state.phase]
  const item = state.items[state.index]
  const place = [state.chapterTitle, item?.sectionTitle, item?.page ? `Page ${item.page}` : ''].filter(Boolean)
  const percent = Math.round(state.chapterProgress * 100)
  return (
    <section aria-labelledby="status-label" className="card flex flex-col gap-5">
      <div className="flex items-center gap-5">
        <div className="orb" data-tone={info.tone} aria-hidden="true"><Icon name={info.icon} size="3.2rem" /></div>
        <div className="min-w-0">
          <p className="m-0 text-sm font-bold uppercase tracking-widest text-muted">Status</p>
          <h2 id="status-label" className="m-0 text-3xl sm:text-4xl">{info.label}</h2>
          <p className="m-0 mt-1 text-lg text-muted">{state.error && state.phase === 'PAUSED' ? state.error.message : info.hint}</p>
        </div>
      </div>
      <div>
        <p className="m-0 text-sm font-bold uppercase tracking-widest text-muted">Reading position</p>
        <p className="m-0 text-xl font-bold">{place.join(' • ') || 'Loading'}</p>
        {(state.skim || sleepLabel(state)) && (
          <p className="m-0 mt-1 flex flex-wrap gap-x-4 font-bold">
            {state.skim && <span className="flex items-center gap-1"><Icon name="skipNext" size="1.2em" /> Skimming: first sentence of each paragraph</span>}
            {sleepLabel(state) && <span className="flex items-center gap-1"><Icon name="pause" size="1.2em" /> {sleepLabel(state)}</span>}
          </p>
        )}
        <div className="mt-3 flex items-center gap-3">
          <div className="meter flex-1" role="progressbar" aria-label="Progress through this chapter"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent} percent of this chapter`}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <span className="w-14 text-right font-bold" aria-hidden="true">{percent}%</span>
        </div>
      </div>
    </section>
  )
}

interface ActionButtonProps {
  icon: IconName
  label: string
  shortcut?: string
  onClick: () => void
  className?: string
  pressed?: boolean
  /** Shown next to the label when the visible text is shorter than the accessible name. */
  short?: string
  /**
   * Nothing to do right now. The button stays focusable and clickable (pressing it explains
   * why), because a control that silently vanishes from the tab order is harder to learn by ear.
   */
  unavailable?: boolean
}

/** A large, labelled button. The shortcut is exposed to assistive technology via aria-keyshortcuts. */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { icon, label, shortcut, onClick, className = '', pressed, short, unavailable }, ref) {
  return (
    <button ref={ref} type="button" className={`btn ${className}`} onClick={onClick} aria-pressed={pressed}
      aria-disabled={unavailable || undefined}
      aria-label={short ? label : undefined} aria-keyshortcuts={shortcut === 'Space' ? 'Space' : shortcut}>
      <Icon name={icon} />
      <span>{short ?? label}</span>
      {shortcut && <span className="kbd" aria-hidden="true">{shortcut}</span>}
    </button>
  )
})

/** A value with big minus / plus buttons: easier than a slider for keyboard, switch and low-vision users. */
export function Stepper({ label, value, onDown, onUp, downLabel, upLabel }: {
  label: string; value: string; onDown: () => void; onUp: () => void; downLabel: string; upLabel: string
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2">
      <button type="button" className="btn" onClick={onDown} aria-label={downLabel}><Icon name="minus" /></button>
      <p className="m-0 min-w-0 flex-1 text-center">
        <span className="block text-sm font-bold uppercase tracking-widest text-muted">{label}</span>
        <span className="text-2xl font-bold">{value}</span>
      </p>
      <button type="button" className="btn" onClick={onUp} aria-label={upLabel}><Icon name="plus" /></button>
    </div>
  )
}

function renderItem(item: ReadItem, body: ReactNode, key: number, className: string) {
  if (item.kind === 'sentence') return <span key={key} className={className}>{body} </span>
  return <strong key={key} className={`block py-1 text-accent ${className}`}>{body}</strong>
}

/** The text being read, with the sentence (and word) currently spoken marked for partially sighted readers. */
export function Transcript({ state, highlightWords }: { state: ControllerState; highlightWords: boolean }) {
  const { items, index, charOffset } = state
  const current = items[index]
  const from = Math.max(0, index - 2)
  const visible = items.slice(from, index + 3)

  let currentBody: ReactNode = current?.text
  if (current && highlightWords && state.phase === 'PLAYING') {
    const end = current.text.indexOf(' ', charOffset)
    const wordEnd = end === -1 ? current.text.length : end
    currentBody = (
      <>
        {current.text.slice(0, charOffset)}
        <mark className="now-word">{current.text.slice(charOffset, wordEnd)}</mark>
        {current.text.slice(wordEnd)}
      </>
    )
  }

  return (
    // Deliberately not a live region: the app's voice is already reading this text.
    <section aria-labelledby="transcript-heading" className="card">
      <h2 id="transcript-heading" className="m-0 mb-3 text-sm font-bold uppercase tracking-widest text-muted">Text being read</h2>
      <p className="m-0 text-2xl leading-relaxed" lang={detectScriptLanguage(visible.map((item) => item.text).join(' ')) ?? 'en'}>
        {visible.map((item, i) => {
          const position = from + i
          if (position === index) return renderItem(item, currentBody, position, 'spoken font-bold')
          return renderItem(item, item.text, position, 'text-muted')
        })}
      </p>
    </section>
  )
}

const RELATION = { current: 'the part you were reading', heard: 'earlier in the book', ahead: 'later in the book' } as const

/** "You asked" and the answer, shown while it is being spoken. */
export function AnswerPanel({ state, capabilities, onReplay, onContinue, onStayPaused, inFlow }: {
  state: ControllerState; capabilities: Capabilities | null | undefined; inFlow: boolean
  onReplay: () => void; onContinue: () => void; onStayPaused: () => void
}) {
  if (!state.question && !state.answer.length && !state.interim) return null
  const sources = [...state.sources].sort((a, b) => b.score - a.score).slice(0, 2)
  return (
    <section aria-labelledby="qa-heading" className="card flex flex-col gap-4 border-accent">
      <h2 id="qa-heading" className="sr-only">Your question and the answer</h2>
      {(state.question || state.interim) && (
        <div>
          <h3 className="m-0 text-sm font-bold uppercase tracking-widest text-muted">{state.question ? 'You asked' : 'Hearing'}</h3>
          <p className="m-0 text-2xl font-bold">&ldquo;{state.question || state.interim}&rdquo;</p>
        </div>
      )}
      {state.answer.length > 0 && (
        <div>
          <h3 className="m-0 text-sm font-bold uppercase tracking-widest text-muted">Answer</h3>
          <p className="m-0 text-2xl leading-relaxed">
            {state.answer.map((sentence, i) => (
              <span key={i} className={i === state.speakingSentence ? 'spoken font-bold' : ''}>{sentence} </span>
            ))}
          </p>
          {state.grounded === false && (
            <p className="mb-0 mt-3 flex items-center gap-2 font-bold"><Icon name="alert" /> This was not found in your textbook.</p>
          )}
          {state.grounded !== false && sources.length > 0 && (
            <p className="mb-0 mt-3 text-muted">
              From your textbook: {sources.map((s) => `${s.section || s.chapter}${s.page ? `, page ${s.page}` : ''} (${RELATION[s.relation]})`).join('; ')}.
            </p>
          )}
          {capabilities?.llm_is_local_fallback && (
            <p className="mb-0 mt-2 text-muted">
              Offline mode: no AI model is configured, so this answer is quoted directly from the textbook.
            </p>
          )}
        </div>
      )}
      {state.answer.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn" onClick={onReplay}><Icon name="repeat" /> Replay answer</button>
          <button type="button" className="btn btn-primary" onClick={onContinue}>
            <Icon name="play" /> Continue reading <span className="kbd" aria-hidden="true">C</span>
          </button>
          {inFlow && (
            <button type="button" className="btn" aria-pressed={!state.willResume} onClick={onStayPaused}>
              <Icon name="pause" /> Stay paused afterwards
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Typed commands and questions. Everything that can be said can be typed here,
 * which serves users of braille displays, people who cannot or prefer not to
 * speak, and noisy rooms. It is also the fallback when the microphone is blocked.
 */
export const CommandBar = forwardRef<HTMLInputElement, {
  onSubmit: (text: string) => void; assistant: boolean
  /** The app is waiting for something to be typed: 'question', 'note', 'search' or 'answer'. Empty otherwise. */
  waitingFor: string
}>(
  function CommandBar({ onSubmit, waitingFor, assistant }, ref) {
    const [text, setText] = useState('')
    return (
      <form className="card flex flex-col gap-2" onSubmit={(event) => {
        event.preventDefault()
        onSubmit(text)
        setText('')
      }}>
        <label htmlFor="command" className="text-lg font-bold">
          {waitingFor ? `Type your ${waitingFor}, then press Enter` : assistant ? 'Type a command or a question' : 'Type a command'}
          <span className="kbd ml-2" aria-hidden="true">T</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <input ref={ref} id="command" className="field flex-1" value={text} onChange={(event) => setText(event.target.value)}
            autoComplete="off" spellCheck placeholder={assistant ? 'For example: what is a page fault?' : 'For example: go back 30 seconds'}
            aria-describedby="command-hint" />
          <button type="submit" className="btn btn-primary">Send</button>
        </div>
        <p id="command-hint" className="m-0 text-muted">Anything you can say, you can type. Press Escape to leave the box.</p>
      </form>
    )
  })

/** Whether the microphone is listening - shown at all times, because an open microphone must never be a surprise. */
export function MicStatus({ mic }: { mic: ControllerState['mic'] }) {
  const text = {
    commands: 'Microphone on: listening for commands and questions',
    question: 'Microphone on: listening for your question',
    off: 'Microphone off: press A to ask a question',
    unavailable: 'Voice input is not available here: use the keyboard and the command box',
    denied: 'Microphone blocked: allow it in your browser, or type your questions',
  }[mic]
  const on = mic === 'commands' || mic === 'question'
  return (
    <p className="m-0 flex items-center gap-2 font-bold">
      <Icon name={on ? 'mic' : 'micOff'} /> {text}
    </p>
  )
}

/** A native modal dialog: focus is trapped inside, Escape closes it, and focus returns to where it was. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="modal-title">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id="modal-title" className="m-0 text-3xl">{title}</h2>
        <button type="button" className="btn" onClick={onClose}><Icon name="close" /> Close</button>
      </div>
      {open && children}
    </dialog>
  )
}
