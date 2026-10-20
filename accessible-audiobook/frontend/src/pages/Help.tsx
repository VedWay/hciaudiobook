import { useEffect } from 'react'
import { useAnnounce } from '../accessibility/Announcer'
import { HelpContent, SPOKEN_HELP } from '../components/HelpContent'
import { Icon } from '../components/Icon'
import { stopUiSpeech, uiSay } from '../core/audio'
import { getSettings } from '../core/settings'
import { useCapabilities } from '../hooks/useCapabilities'

export default function Help() {
  const capabilities = useCapabilities()
  const announce = useAnnounce()
  useEffect(() => stopUiSpeech, [])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 text-4xl">Help</h1>
        <p className="m-0 mt-2 text-xl text-muted">
          This audiobook reads your textbook aloud. At any moment you can interrupt it to ask a question. It pauses,
          answers from the book, and then carries on from exactly where you stopped.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" onClick={() => {
          if (getSettings().screenReaderMode) announce(SPOKEN_HELP, true)
          else void uiSay(SPOKEN_HELP, capabilities)
        }}>
          <Icon name="speech" /> Read the main commands aloud
        </button>
        <button type="button" className="btn" onClick={stopUiSpeech}><Icon name="stop" /> Stop speaking</button>
      </div>

      <section aria-labelledby="help-how" className="card">
        <h2 id="help-how" className="m-0 mb-3 text-2xl">How a question works</h2>
        <ol className="m-0 flex list-decimal flex-col gap-2 pl-6 text-lg">
          <li>While the book is reading, press <span className="kbd">A</span>, say &ldquo;ask a question&rdquo;, or simply ask your question out loud.</li>
          <li>The book pauses and remembers the exact word it reached. A rising tone means the microphone is listening.</li>
          <li>You hear &ldquo;Searching your textbook&rdquo;, with a soft ticking sound while it works.</li>
          <li>The answer is spoken in a different voice from the narrator, so you can tell them apart. It is also shown on screen.</li>
          <li>You hear &ldquo;Continuing from where you stopped&rdquo;, and the book carries on from that same word.</li>
        </ol>
        <p className="mb-0 mt-3 text-muted">
          If something goes wrong, the app tells you what happened in plain words and returns you to the book. You never
          lose your place.
        </p>
      </section>

      <div className="card"><HelpContent /></div>

      <section aria-labelledby="help-sounds" className="card">
        <h2 id="help-sounds" className="m-0 mb-3 text-2xl">What the sounds mean</h2>
        <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {[
            ['Two rising notes', 'The microphone is open. Speak now.'],
            ['Two falling notes', 'Your words were heard.'],
            ['Soft repeated tick', 'Working on your answer.'],
            ['Three rising notes', 'The answer is ready, or a new book is ready.'],
            ['One low note', 'Paused.'],
            ['Low double buzz', 'Something went wrong. An explanation follows.'],
            ['Short high blip', 'A setting changed, or the place moved.'],
          ].map(([sound, meaning]) => (
            <div key={sound} className="contents"><dt className="font-bold">{sound}</dt><dd className="m-0 text-muted">{meaning}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  )
}
