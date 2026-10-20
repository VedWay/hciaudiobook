/**
 * The audiobook player. This file only wires things together: the controller
 * (core/controller.ts) owns the behaviour, and every button, key and voice
 * command sends it the same Intent.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAnnounce } from '../accessibility/Announcer'
import { setFocusSpeaker } from '../accessibility/focusSpeech'
import { useShortcuts } from '../accessibility/useShortcuts'
import { HelpContent } from '../components/HelpContent'
import { Icon } from '../components/Icon'
import { ActionButton, AnswerPanel, CommandBar, MicStatus, Modal, sleepLabel, StatusHero, Stepper, Transcript } from '../components/PlayerParts'
import { ContentsPanel, NotesPanel } from '../components/StudyPanels'
import { createSTT, getTTS, voiceOptions } from '../core/audio'
import { setLastBook } from '../core/libraryVoice'
import { AudiobookController, type ControllerState, type Phase } from '../core/controller'
import { earcons } from '../core/earcons'
import type { Intent } from '../core/intents'
import { PHASES } from '../core/phaseInfo'
import { getSettings, updateSettings, useSettings } from '../core/settings'
import { useCapabilities } from '../hooks/useCapabilities'
import { api } from '../services/api'
import { TrialLogger } from '../services/trialLogger'
import type { EvalTask } from '../types'

const IN_QUESTION = new Set<Phase>(['PAUSING', 'CAPTURE_CONTEXT', 'LISTENING', 'TRANSCRIBING', 'RETRIEVING', 'GENERATING',
  'SPEAKING_ANSWER', 'FOLLOW_UP', 'RESUME_CONFIRMATION', 'STT_FAILED', 'RAG_FAILED', 'LLM_FAILED', 'TTS_FAILED', 'NETWORK_ERROR'])

const noSubscription = () => () => undefined
const noState = () => null

/** Save the study sheet for a book (notes, bookmarks, questions and answers) as a file. */
async function downloadStudyNotes(bookId: string): Promise<void> {
  const url = URL.createObjectURL(await api.studyNotes(bookId))
  const link = Object.assign(document.createElement('a'), { href: url, download: `${bookId}-study-notes.md` })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

interface Trial {
  id: number
  condition: 'A' | 'B'
  participant: string
  task: EvalTask
}

/** Evaluation trials are opened as /read/<book>?trial=<id>&condition=A|B&task=T1&participant=P01 */
function useTrial(): { trial: Trial | null; waiting: boolean } {
  const [params] = useSearchParams()
  const id = Number(params.get('trial'))
  const taskId = params.get('task')
  const [task, setTask] = useState<EvalTask | null>(null)
  useEffect(() => {
    if (!id) return
    let alive = true
    api.evalDesign().then((design) => { if (alive) setTask(design.tasks.find((t) => t.id === taskId) ?? null) }).catch(() => undefined)
    return () => { alive = false }
  }, [id, taskId])
  const condition = params.get('condition') === 'A' ? 'A' : 'B'
  const participant = params.get('participant') ?? ''
  const trial = useMemo(() => (id && task ? { id, condition, participant, task } as Trial : null), [id, task, condition, participant])
  return { trial, waiting: !!id && !task }
}

export default function Player() {
  const { bookId = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const announce = useAnnounce()
  const capabilities = useCapabilities()
  const settings = useSettings()
  const { trial, waiting } = useTrial()

  const [controller, setController] = useState<AudiobookController | null>(null)
  const [cannotSpeak, setCannotSpeak] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const logger = useMemo(() => new TrialLogger(), [trial?.id])
  const playButton = useRef<HTMLButtonElement>(null)
  const commandInput = useRef<HTMLInputElement>(null)
  const autoplay = !trial && (location.state as { autoplay?: boolean } | null)?.autoplay === true

  useEffect(() => {
    if (capabilities === undefined || waiting) return
    const tts = getTTS(capabilities)
    if (!tts) {
      setCannotSpeak(true)
      return
    }
    const baseline = trial?.condition === 'A'
    const instance = new AudiobookController({
      api, tts, earcons,
      stt: baseline ? null : createSTT(capabilities),
      settings: getSettings, updateSettings, voice: voiceOptions, announce,
      navigate: (page) => navigate(page === 'library' ? '/' : `/${page}`),
      interpret: capabilities && !capabilities.llm_is_local_fallback && !baseline
        ? (utterance, state, book, reading = '') => api.interpret({ utterance, page: 'player', state, books: book ? [book] : [], reading: reading.slice(-1200) })
        : undefined,
      exportNotes: () => downloadStudyNotes(bookId),
      log: trial ? logger.log : undefined,
      // A trial measures one interaction only, so the study tools are off in both conditions.
      mode: trial ? { assistant: !baseline, voice: !baseline, persist: false, studyTools: false } : undefined,
    })
    setController(instance)
    if (!trial) setLastBook(bookId) // so "continue" on any other screen comes back here
    // The device voice sounds robotic next to the natural one: say why it changed, and that it is temporary.
    const notice = "The natural voice is unavailable, so I'm using this device's voice for now. I'll try the natural one again shortly."
    tts.onFallback = () => {
      announce(notice, true)
      const s = getSettings()
      if (!trial && !s.screenReaderMode && s.verbosity !== 'earcons') setTimeout(() => void instance.speakAside(notice), 0)
    }
    const start = trial ? { chapterIndex: trial.task.chapter_index, section: trial.task.section } : undefined
    void instance.load(bookId, start).then(() => {
      playButton.current?.focus()
      if (autoplay) void instance.begin()
      else if (!trial) void instance.announceReady()
    })
    return () => {
      tts.onFallback = undefined
      instance.dispose()
      setController(null)
    }
    // settings.speechEngine: switching between browser and server voices needs a new engine.
    // settings.listenEngine: likewise for the microphone.
  }, [bookId, capabilities, waiting, trial, settings.speechEngine, settings.listenEngine, announce, navigate, logger, autoplay])

  const state = useSyncExternalStore<ControllerState | null>(controller?.subscribe ?? noSubscription, controller?.getState ?? noState)

  // speechLanguage: the recogniser must be restarted to listen in another language or accent.
  useEffect(() => { controller?.startCommandListening() }, [controller, settings.micMode, settings.speechLanguage])

  // While a book is open, the names of focused controls are spoken through the controller,
  // which pauses the narrator for them and carries on from the same word.
  useEffect(() => {
    if (!controller) return
    setFocusSpeaker((text) => void controller.speakAside(text))
    return () => setFocusSpeaker(null)
  }, [controller])

  // Never lose the reader's place: save when the tab is hidden or closed.
  useEffect(() => {
    if (!controller) return
    const save = () => { if (document.visibilityState === 'hidden') controller.saveNow() }
    document.addEventListener('visibilitychange', save)
    window.addEventListener('pagehide', save)
    return () => {
      document.removeEventListener('visibilitychange', save)
      window.removeEventListener('pagehide', save)
    }
  }, [controller])

  useEffect(() => { if (state?.typedPrompt) commandInput.current?.focus() }, [state?.typedPrompt])

  const phase = state?.phase ?? 'LOADING'
  const title = state?.book?.title
  useEffect(() => {
    if (title) document.title = `${PHASES[phase].label} - ${title}`
  }, [phase, title])

  const ready = !!controller && !!state?.book && phase !== 'LOADING'
  const assistant = trial?.condition !== 'A'
  const studyTools = !trial // find, contents, notes, skim, sleep timer: not part of either evaluated system
  const run = (intent: Intent, source: 'key' | 'touch' = 'touch') => () => void controller?.command(intent, source)
  const key = (intent: Intent) => run(intent, 'key')
  const openHelp = () => {
    void controller?.pause()
    setHelpOpen(true)
  }
  const focusCommand = () => commandInput.current?.focus()

  useShortcuts({
    Space: () => controller?.toggle('key'),
    k: () => controller?.toggle('key'),
    r: key({ type: 'repeat' }),
    s: key({ type: 'stop' }),
    c: key({ type: 'resume' }),
    w: key({ type: 'where' }),
    b: key({ type: 'bookmark' }),
    p: key({ type: 'nav', unit: 'section', delta: -1 }),
    n: key({ type: 'nav', unit: 'section', delta: 1 }),
    ArrowLeft: key({ type: 'seek', seconds: -10 }),
    ArrowRight: key({ type: 'seek', seconds: 10 }),
    'Shift+ArrowLeft': key({ type: 'seek', seconds: -30 }),
    'Shift+ArrowRight': key({ type: 'seek', seconds: 30 }),
    '[': key({ type: 'speed', change: 'down' }),
    ']': key({ type: 'speed', change: 'up' }),
    '-': key({ type: 'volume', change: 'down' }),
    '=': key({ type: 'volume', change: 'up' }),
    '+': key({ type: 'volume', change: 'up' }),
    t: focusCommand,
    '/': focusCommand,
    h: openHelp,
    '?': openHelp,
    Escape: key({ type: 'cancel' }),
    ...(assistant ? {
      a: key({ type: 'ask' }),
      e: key({ type: 'qa', intent: 'explain', question: 'Explain that' }),
      x: key({ type: 'qa', intent: 'example', question: 'Give me an example' }),
      u: key({ type: 'qa', intent: 'summarize', question: 'Summarize this section', scope: 'section' }),
      q: key({ type: 'quiz' }),
      m: () => void controller?.toggleMic(),
    } : {}),
    ...(studyTools ? {
      i: () => void controller?.command({ type: 'skim', on: !controller.getState().skim }, 'key'),
      f: key({ type: 'find', query: '' }),
      o: key({ type: 'contents' }),
      j: key({ type: 'return' }),
      z: () => void controller?.cycleSleep('key'),
      d: key({ type: 'note', text: '' }),
      l: key({ type: 'readNotes' }),
    } : {}),
  }, ready)

  if (cannotSpeak) {
    return (
      <div className="card flex flex-col gap-3" role="alert">
        <h1 className="m-0 text-3xl">This browser cannot read aloud</h1>
        <p className="m-0 text-xl">Speech is not available in this browser. Please open the audiobook in Chrome, Edge or Safari.</p>
        <Link to="/" className="btn self-start"><Icon name="arrowLeft" /> Back to my books</Link>
      </div>
    )
  }
  if (capabilities === null || state?.loadError) {
    return (
      <div className="card flex flex-col gap-3" role="alert">
        <h1 className="m-0 text-3xl">The book could not be opened</h1>
        <p className="m-0 text-xl">{state?.loadError ?? 'The server could not be reached. Check that it is running, then try again.'}</p>
        <Link to="/" className="btn self-start"><Icon name="arrowLeft" /> Back to my books</Link>
      </div>
    )
  }
  if (!ready || !state || !controller) {
    return <h1 className="text-3xl" aria-live="polite">Opening your book&hellip;</h1>
  }

  const active = phase === 'PLAYING' || IN_QUESTION.has(phase)
  const micOn = state.mic === 'commands' || state.mic === 'question'
  const playLabel = active ? 'Pause' : phase === 'IDLE' ? 'Start reading' : phase === 'FINISHED' ? 'Read again' : 'Continue reading'

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 text-3xl">{state.book!.title}</h1>
        <Link to="/" className="btn btn-quiet"><Icon name="arrowLeft" /> My books</Link>
      </div>

      {trial && <TrialBar trial={trial} logger={logger} controller={controller} onDone={() => navigate('/evaluation')} />}

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <StatusHero state={state} />

          {/* role="application": screen readers pass single-key shortcuts straight through while focus is in here. */}
          <section role="application" aria-label="Audiobook controls. Space plays and pauses. Press H for all shortcuts." className="card flex flex-col gap-4">
            <div className={`grid gap-3 ${assistant ? 'sm:grid-cols-2' : ''}`}>
              <ActionButton ref={playButton} icon={active ? 'pause' : 'play'} label={playLabel} shortcut="Space"
                className="btn-primary btn-xl" onClick={() => controller.toggle('touch')} />
              {assistant && (
                <ActionButton icon="mic" label="Ask a question" shortcut="A" className="btn-xl" onClick={run({ type: 'ask' })} />
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <ActionButton icon="back" label="Back 10 seconds" onClick={run({ type: 'seek', seconds: -10 })} />
              <ActionButton icon="repeat" label="Repeat" shortcut="R" onClick={run({ type: 'repeat' })} />
              <ActionButton icon="forward" label="Forward 10 seconds" onClick={run({ type: 'seek', seconds: 10 })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ActionButton icon="skipPrev" label="Previous section" shortcut="P" onClick={run({ type: 'nav', unit: 'section', delta: -1 })} />
              <ActionButton icon="skipNext" label="Next section" shortcut="N" onClick={run({ type: 'nav', unit: 'section', delta: 1 })} />
            </div>

            <div className="grid gap-3">
              <Stepper label="Speed" value={`${settings.rate}×`} downLabel="Slower" upLabel="Faster"
                onDown={run({ type: 'speed', change: 'down' })} onUp={run({ type: 'speed', change: 'up' })} />
              <Stepper label="Volume" value={`${Math.round(settings.volume * 100)}%`} downLabel="Quieter" upLabel="Louder"
                onDown={run({ type: 'volume', change: 'down' })} onUp={run({ type: 'volume', change: 'up' })} />
            </div>

            {assistant && (
              <div role="group" aria-labelledby="quick-heading">
                <h2 id="quick-heading" className="m-0 mb-2 text-sm font-bold uppercase tracking-widest text-muted">About what I just heard</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <ActionButton icon="spark" label="Explain that" shortcut="E" onClick={run({ type: 'qa', intent: 'explain', question: 'Explain that' })} />
                  <ActionButton icon="spark" label="Explain simply" onClick={run({ type: 'qa', intent: 'simplify', question: 'Explain this simply' })} />
                  <ActionButton icon="spark" label="Give an example" shortcut="X" onClick={run({ type: 'qa', intent: 'example', question: 'Give me an example' })} />
                  <ActionButton icon="spark" label="Define this" onClick={run({ type: 'qa', intent: 'define', question: 'Define this', term: '' })} />
                  <ActionButton icon="spark" label="Summarize section" shortcut="U" onClick={run({ type: 'qa', intent: 'summarize', question: 'Summarize this section', scope: 'section' })} />
                  <ActionButton icon="help" label="Quiz me" shortcut="Q" onClick={run({ type: 'quiz' })} />
                </div>
              </div>
            )}

            {studyTools && (
              <div role="group" aria-labelledby="study-heading">
                <h2 id="study-heading" className="m-0 mb-2 text-sm font-bold uppercase tracking-widest text-muted">Study tools</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <ActionButton icon="skim" label="Skim" shortcut="I" pressed={state.skim} onClick={run({ type: 'skim', on: !state.skim })} />
                  <ActionButton icon="search" label="Find in book" shortcut="F" onClick={run({ type: 'find', query: '' })} />
                  <ActionButton icon="list" label="Read contents" shortcut="O" onClick={run({ type: 'contents' })} />
                  <ActionButton icon="undo" label="Return to my place" shortcut="J" unavailable={!state.canReturn} onClick={run({ type: 'return' })} />
                  <ActionButton icon="note" label="Take a note" shortcut="D" onClick={run({ type: 'note', text: '' })} />
                  <ActionButton icon="moon" label={sleepLabel(state) || 'Sleep timer: off'} shortcut="Z" pressed={!!sleepLabel(state)}
                    onClick={() => void controller.cycleSleep('touch')} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <ActionButton icon="search" label="Where am I?" shortcut="W" onClick={run({ type: 'where' })} />
              {!trial && <ActionButton icon="bookmark" label="Bookmark" shortcut="B" onClick={run({ type: 'bookmark' })} />}
              {assistant && state.mic !== 'unavailable' && (
                <ActionButton icon={micOn ? 'mic' : 'micOff'} label="Microphone" shortcut="M" pressed={micOn} onClick={() => void controller.toggleMic()} />
              )}
              <ActionButton icon="stop" label="Stop" shortcut="S" onClick={run({ type: 'stop' })} />
              <ActionButton icon="help" label="Help" shortcut="H" onClick={openHelp} />
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-5">
          {assistant && (
            <AnswerPanel state={state} capabilities={capabilities} inFlow={IN_QUESTION.has(phase)}
              onReplay={run({ type: 'replayAnswer' })} onContinue={run({ type: 'resume' })} onStayPaused={run({ type: 'stayPaused' })} />
          )}
          <Transcript state={state} highlightWords={settings.highlightWords} />
          {assistant && <MicStatus mic={state.mic} />}
          {state.heard && assistant && (
            <p className="m-0 text-muted">Last heard: &ldquo;{state.heard}&rdquo;{state.heardNote && <> &mdash; {state.heardNote}</>}</p>
          )}
          <div onKeyDown={(event) => { if (event.key === 'Escape') playButton.current?.focus() }}>
            <CommandBar ref={commandInput} waitingFor={state.typedPrompt ? state.listeningFor : ''} assistant={assistant}
              onSubmit={(text) => { controller.submitText(text); playButton.current?.focus() }} />
          </div>
        </div>
      </div>

      {studyTools && (
        <ContentsPanel book={state.book!} chapterIndex={state.chapterIndex} section={state.items[state.index]?.sectionTitle ?? ''}
          onHeading={(chapterIndex, section) => void controller.gotoHeading(chapterIndex, section, 'touch')}
          onFind={(query) => void controller.command({ type: 'find', query }, 'typed')} />
      )}

      {studyTools && (
        <NotesPanel notes={state.notes}
          onAdd={(text) => void controller.command({ type: 'note', text }, 'typed')}
          onGoto={(note) => void controller.gotoNote(note)}
          onDelete={(note) => void api.deleteNote(bookId, note.id).then(() => controller.removeNote(note.id))}
          onExport={run({ type: 'exportNotes' })} />
      )}

      {!trial && (
        <details className="card">
          <summary className="cursor-pointer text-xl font-bold">Bookmarks ({state.bookmarks.length})</summary>
          {state.bookmarks.length === 0
            ? <p className="mb-0">No bookmarks yet. Press B, or say &ldquo;bookmark this&rdquo;, to save your place.</p>
            : (
              <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
                {state.bookmarks.map((bookmark) => (
                  <li key={bookmark.id} className="flex flex-wrap items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <strong>{bookmark.section || bookmark.chapter}</strong>{bookmark.page ? `, page ${bookmark.page}` : ''}
                      <span className="block text-muted">{bookmark.label}</span>
                    </span>
                    <button type="button" className="btn" onClick={() => void controller.gotoBookmark(bookmark)}>Go to bookmark</button>
                    <button type="button" className="btn" aria-label={`Delete bookmark in ${bookmark.section || bookmark.chapter}`}
                      onClick={() => void api.deleteBookmark(bookId, bookmark.id).then(() => controller.removeBookmark(bookmark.id))}>
                      <Icon name="trash" /> Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </details>
      )}

      {assistant && state.history.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-xl font-bold">Questions asked this session ({state.history.length})</summary>
          <dl className="mb-0 mt-3">
            {state.history.map((turn, i) => (
              <div key={i} className="mb-4">
                <dt className="font-bold">&ldquo;{turn.question}&rdquo;</dt>
                <dd className="m-0 text-muted">{turn.answer}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <details className="card">
        <summary className="cursor-pointer text-xl font-bold">Interaction trace (for demonstrations)</summary>
        <p className="text-muted">
          Each state the system passed through, most recent last. This is the interrupt &rarr; ask &rarr; answer &rarr; resume
          state machine at work.
        </p>
        <ol className="m-0 flex list-none flex-wrap gap-2 p-0">
          {state.trace.map((step, i) => (
            <li key={`${step.at}-${i}`} className="kbd">{step.phase}</li>
          ))}
        </ol>
      </details>

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Help">
        <div className="mb-5 flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary" onClick={run({ type: 'help' })}><Icon name="speech" /> Read the main commands aloud</button>
        </div>
        <HelpContent headingLevel={3} />
      </Modal>
    </div>
  )
}

/** Researcher strip shown during an evaluation trial. */
function TrialBar({ trial, logger, controller, onDone }: { trial: Trial; logger: TrialLogger; controller: AudiobookController; onDone: () => void }) {
  const [stage, setStage] = useState<'ready' | 'running' | 'scoring'>('ready')
  const [duration, setDuration] = useState(0)
  const [comprehension, setComprehension] = useState('1')
  const [completed, setCompleted] = useState(true)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const baseline = trial.condition === 'A'

  const start = () => {
    logger.start()
    setStage('running')
    controller.play()
  }
  const end = () => {
    setDuration(logger.elapsed())
    void controller.pause()
    setStage('scoring')
  }
  const save = async () => {
    try {
      await api.evalFinishTrial(trial.id, { duration_ms: duration, events: logger.events, completed, comprehension: Number(comprehension), notes })
      onDone()
    } catch {
      setError('The trial could not be saved. Check the connection and try again.')
    }
  }

  useShortcuts({
    F8: () => { if (stage === 'running' && baseline) controller.markAnswerFound() },
    F9: () => { if (stage === 'running') end() },
  })

  return (
    <section aria-labelledby="trial-heading" className="card flex flex-col gap-3 border-accent">
      <h2 id="trial-heading" className="m-0 text-xl">
        Evaluation trial: {trial.participant} &bull; System {trial.condition} ({baseline ? 'traditional audiobook' : 'RAG audiobook'}) &bull; Task {trial.task.id}
      </h2>
      <p className="m-0 text-lg"><strong>Task for the participant:</strong> {trial.task.goal}</p>
      <p className="m-0 text-muted"><strong>Answer key (researcher only):</strong> {trial.task.answer_key}</p>
      {stage === 'ready' && (
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary" onClick={start}>Start task and begin reading</button>
          <p className="m-0 self-center text-muted">Read the task to the participant first. Timing starts when you press Start.</p>
        </div>
      )}
      {stage === 'running' && (
        <div className="flex flex-wrap gap-3">
          {baseline && (
            <button type="button" className="btn" onClick={() => controller.markAnswerFound()}>
              Mark: answer found <span className="kbd" aria-hidden="true">F8</span>
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={end}>End task <span className="kbd" aria-hidden="true">F9</span></button>
          <p className="m-0 self-center text-muted">
            {baseline ? 'Press F8 when the participant has found the answer; end the task once they are reading again from their place.'
              : 'The answer and resume moments are logged automatically. End the task once reading has resumed.'}
          </p>
        </div>
      )}
      {stage === 'scoring' && (
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <p className="m-0">Ask: &ldquo;{trial.task.question}&rdquo; Then score the spoken answer against the key.</p>
          <fieldset className="m-0 flex flex-wrap gap-4 border-0 p-0">
            <legend className="mb-1 font-bold">Comprehension</legend>
            {[['1', 'Correct'], ['0.5', 'Partly correct'], ['0', 'Incorrect or no answer']].map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input type="radio" name="comprehension" value={value} checked={comprehension === value} onChange={() => setComprehension(value)} /> {label}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={completed} onChange={(event) => setCompleted(event.target.checked)} />
            The participant completed the task without the researcher&rsquo;s help
          </label>
          <label className="flex flex-col gap-1 font-bold">
            Observation notes
            <textarea className="field font-normal" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          {error && <p role="alert" className="m-0 font-bold">{error}</p>}
          <button type="submit" className="btn btn-primary self-start">Save trial</button>
        </form>
      )}
    </section>
  )
}
