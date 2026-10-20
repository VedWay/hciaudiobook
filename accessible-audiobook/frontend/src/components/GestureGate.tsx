/**
 * The first screen. Browsers will not play any sound until the user has pressed
 * a key or tapped, so this screen asks for exactly that - any key, anywhere -
 * rather than making a blind user hunt for a small "play" button.
 *
 * On the first visit it also asks the one question that changes how the app
 * should talk: whether a screen reader is already speaking.
 */
import { useEffect } from 'react'
import { getSettings, updateSettings } from '../core/settings'
import { Icon } from './Icon'

const WELCOME = 'Welcome. This audiobook reads your textbook aloud, and you can interrupt it at any time to ask a question. '
  + 'Press Space to play or pause. Press A, or say "ask a question", to ask something. Press H for help. '

let pendingIntro = ''

/** The welcome message, returned once, for the first page to speak. */
export function takeIntro(): string {
  const intro = pendingIntro
  pendingIntro = ''
  return intro
}

export function GestureGate({ onStart }: { onStart: () => void }) {
  const firstVisit = !getSettings().onboarded

  const start = (screenReader?: boolean) => {
    if (firstVisit) {
      const usesScreenReader = screenReader ?? false
      updateSettings({ onboarded: true, screenReaderMode: usesScreenReader })
      if (!usesScreenReader) pendingIntro = WELCOME
    }
    onStart()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Leave navigation and modifier keys alone so screen-reader commands keep working.
      if (['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Insert', 'Escape'].includes(event.key)) return
      if (event.ctrlKey || event.altKey || event.metaKey) return
      const activates = event.key === 'Enter' || event.key === ' '
      if (activates && (event.target as HTMLElement).closest('button')) return // the focused button handles these itself
      event.preventDefault()
      start(firstVisit && event.key.toLowerCase() === 's')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-5 py-10">
      <div className="flex items-center gap-4 text-accent">
        <Icon name="book" size="3.5rem" />
        <h1 className="text-4xl text-fg sm:text-5xl">Accessible Audiobook</h1>
      </div>
      <p className="text-xl text-muted">
        Listen to your textbook. Interrupt it with your voice whenever you have a question. It answers from the book,
        then carries on from exactly where you stopped.
      </p>
      {firstVisit ? (
        <div className="flex flex-col gap-4">
          <button type="button" autoFocus className="btn btn-primary btn-xl justify-start text-left" onClick={() => start(false)}>
            <Icon name="play" size="2.2rem" />
            <span className="flex-1">Start with spoken guidance</span>
            <span className="kbd" aria-hidden="true">Enter</span>
          </button>
          <button type="button" className="btn btn-xl justify-start text-left" onClick={() => start(true)}>
            <Icon name="keyboard" size="2.2rem" />
            <span className="flex-1">I use a screen reader. Keep the app&rsquo;s own prompts quiet.</span>
            <span className="kbd" aria-hidden="true">S</span>
          </button>
          <p className="text-muted">
            Press Enter for spoken guidance, or S if you use a screen reader. You can change this later in Settings.
            Headphones are recommended, so the microphone does not pick up the audiobook.
          </p>
        </div>
      ) : (
        <button type="button" autoFocus className="btn btn-primary btn-xl" onClick={() => start()}>
          <Icon name="play" size="2.2rem" />
          Press any key, or tap here, to continue
        </button>
      )}
    </main>
  )
}
