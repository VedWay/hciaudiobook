/**
 * Researcher dashboard for the within-subjects comparison:
 *   System A - traditional audiobook (play, pause, seek, section navigation)
 *   System B - the RAG audiobook (interrupt, ask, answer, resume)
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Modal } from '../components/PlayerParts'
import { useCapabilities } from '../hooks/useCapabilities'
import { api, ApiError, researcherPasscode } from '../services/api'
import type { EvalDesign, EvalParticipant, EvalSummary, EvalTask, Stat } from '../types'

type Condition = 'A' | 'B'
const SYSTEM = { A: 'Traditional audiobook', B: 'RAG audiobook' } as const

const METRICS: { key: string; label: string; unit: string; better: 'lower' | 'higher'; max?: number }[] = [
  { key: 'task_time_s', label: 'Task completion time', unit: 's', better: 'lower' },
  { key: 'time_to_answer_s', label: 'Time to find the answer', unit: 's', better: 'lower' },
  { key: 'time_to_resume_s', label: 'Time to resume reading', unit: 's', better: 'lower' },
  { key: 'interactions', label: 'Number of interactions', unit: '', better: 'lower' },
  { key: 'resume_error_sentences', label: 'Distance from original place on resuming', unit: 'sentences', better: 'lower' },
  { key: 'comprehension', label: 'Comprehension score', unit: 'of 1', better: 'higher', max: 1 },
  { key: 'tlx', label: 'Perceived workload (NASA-TLX, raw)', unit: 'of 100', better: 'lower', max: 100 },
  { key: 'sus', label: 'Usability (SUS)', unit: 'of 100', better: 'higher', max: 100 },
  { key: 'satisfaction', label: 'Satisfaction', unit: 'of 7', better: 'higher', max: 7 },
]

// Blind users are not one group: record what differs, and report results alongside it.
const PROFILE_FIELDS: { key: string; label: string; options: string[] }[] = [
  { key: 'vision', label: 'Vision', options: ['Totally blind', 'Light perception only', 'Low vision', 'Prefer not to say'] },
  { key: 'onset', label: 'Onset of vision loss', options: ['From birth', 'In childhood', 'As an adult', 'Prefer not to say'] },
  { key: 'screen_reader', label: 'Main screen reader', options: ['NVDA', 'JAWS', 'VoiceOver', 'TalkBack', 'Other', 'None'] },
  { key: 'braille', label: 'Braille use', options: ['Daily', 'Sometimes', 'Not a braille reader'] },
  { key: 'audiobook_use', label: 'Audiobook or DAISY use', options: ['Daily', 'Weekly', 'Rarely', 'Never'] },
  { key: 'voice_assistant_use', label: 'Voice assistant use', options: ['Daily', 'Weekly', 'Rarely', 'Never'] },
]

function tasksFor(participant: EvalParticipant, condition: Condition, design: EvalDesign): EvalTask[] {
  const position = participant.condition_order.indexOf(condition)
  return design.tasks.filter((task) => task.set === participant.task_sets[position])
}

export default function Evaluation() {
  const navigate = useNavigate()
  const capabilities = useCapabilities()
  const [design, setDesign] = useState<EvalDesign | null>(null)
  const [participants, setParticipants] = useState<EvalParticipant[]>([])
  const [summary, setSummary] = useState<EvalSummary | null>(null)
  const [locked, setLocked] = useState(false)
  const [message, setMessage] = useState('')
  const [form, setForm] = useState<{ participant: EvalParticipant; condition: Condition } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [d, p, s] = await Promise.all([api.evalDesign(), api.evalParticipants(), api.evalSummary()])
      setDesign(d)
      setParticipants(p)
      setSummary(s)
      setLocked(false)
      setMessage('')
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) setLocked(true)
      else setMessage('The evaluation data could not be loaded. Check that the server is running.')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const runTrial = async (participant: EvalParticipant, condition: Condition, task: EvalTask) => {
    const trial = await api.evalCreateTrial(participant.id, condition, task.id)
    navigate(`/read/${design!.book_id}?trial=${trial.id}&condition=${condition}&task=${task.id}&participant=${participant.code}`)
  }

  const exportCsv = async () => {
    const url = URL.createObjectURL(await api.evalExport())
    const link = Object.assign(document.createElement('a'), { href: url, download: 'evaluation.csv' })
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 text-4xl">Evaluation dashboard</h1>
        <p className="m-0 mt-2 text-xl text-muted">
          For researchers. Compares System A, a traditional audiobook, with System B, the RAG audiobook, using the
          same participants, the same book and matched tasks.
        </p>
      </div>

      {locked && <PasscodeForm required={!!capabilities?.evaluation_requires_passcode} onSubmit={() => void refresh()} />}
      {message && <p role="alert" className="card m-0 text-xl font-bold">{message}</p>}

      {!locked && design && summary && (
        <>
          <Results summary={summary} />

          <section aria-labelledby="participants-heading" className="card flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="participants-heading" className="m-0 text-2xl">Participants ({participants.length})</h2>
              <button type="button" className="btn" onClick={() => void exportCsv()}><Icon name="chart" /> Export all trials as CSV</button>
            </div>
            <NewParticipant onCreated={() => void refresh()} />
            {participants.length === 0 && <p className="m-0 text-muted">No participants yet. Add one to see their counterbalanced session plan.</p>}
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {participants.map((participant) => (
                <ParticipantCard key={participant.id} participant={participant} design={design}
                  onRun={runTrial} onQuestionnaires={(condition) => setForm({ participant, condition })}
                  onDelete={async () => { await api.evalDeleteParticipant(participant.id); await refresh() }} />
              ))}
            </ul>
          </section>

          <Method />

          <Modal open={!!form} onClose={() => setForm(null)}
            title={form ? `Questionnaires: ${form.participant.code}, System ${form.condition}` : 'Questionnaires'}>
            {form && <Questionnaires participant={form.participant} condition={form.condition} design={design}
              onSaved={() => { setForm(null); void refresh() }} />}
          </Modal>
        </>
      )}
    </div>
  )
}

function PasscodeForm({ required, onSubmit }: { required: boolean; onSubmit: () => void }) {
  const [value, setValue] = useState('')
  return (
    <form className="card flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); researcherPasscode(value); onSubmit() }}>
      <label className="flex flex-col gap-1 text-lg font-bold">
        Researcher passcode
        <input className="field font-normal" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" />
      </label>
      <p className="m-0 text-muted">{required ? 'Participant data is protected. Enter the passcode set in the server configuration.' : 'That passcode was not accepted.'}</p>
      <button type="submit" className="btn btn-primary self-start">Unlock</button>
    </form>
  )
}

/** Small multiples: one two-bar comparison per measure, each on its own scale, plus the same numbers as a table. */
function Results({ summary }: { summary: EvalSummary }) {
  const stat = (condition: Condition, key: string) => summary.conditions[condition][key] as Stat | null
  const hasData = summary.conditions.A.trials + summary.conditions.B.trials > 0
  const format = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1))

  return (
    <section aria-labelledby="results-heading" className="card flex flex-col gap-5">
      <div>
        <h2 id="results-heading" className="m-0 text-2xl">Results so far</h2>
        <p className="m-0 text-muted">
          {summary.participants} participant{summary.participants === 1 ? '' : 's'} &bull; {summary.conditions.A.trials} finished trials with System A
          &bull; {summary.conditions.B.trials} with System B. Bars show the mean; hover or focus a bar for the median and spread.
        </p>
      </div>
      {!hasData ? (
        <p className="m-0 text-lg">No finished trials yet. Results appear here as soon as the first trial is saved.</p>
      ) : (
        <>
          <p className="m-0 font-bold" aria-hidden="true">
            <span className="mr-6"><span className="swatch bar" data-series="A" />System A: {SYSTEM.A}</span>
            <span><span className="swatch bar" data-series="B" />System B: {SYSTEM.B}</span>
          </p>
          <div className="grid gap-x-10 gap-y-6 md:grid-cols-2" role="list" aria-label="Charts comparing System A and System B">
            {METRICS.map((metric) => {
              const a = stat('A', metric.key)
              const b = stat('B', metric.key)
              const scale = metric.max ?? Math.max(a?.mean ?? 0, b?.mean ?? 0, 0.0001)
              return (
                <div key={metric.key} role="listitem">
                  <h3 className="m-0 text-lg">{metric.label}</h3>
                  <p className="m-0 mb-2 text-sm text-muted">{metric.better === 'lower' ? 'Lower is better' : 'Higher is better'}{metric.unit && ` • ${metric.unit}`}</p>
                  {(['A', 'B'] as const).map((condition) => {
                    const value = condition === 'A' ? a : b
                    return (
                      <div key={condition} className="bar-row mb-2 grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-3" tabIndex={0}
                        aria-label={value ? `System ${condition}: mean ${format(value.mean)}, median ${format(value.median)}, standard deviation ${format(value.sd)}, ${value.n} values` : `System ${condition}: no data yet`}>
                        <span className="font-bold">System {condition}</span>
                        <span className="bar-track"><span className="bar" data-series={condition} style={{ width: value ? `${Math.min(100, (value.mean / scale) * 100)}%` : '0' }} /></span>
                        <span className="text-right font-bold">{value ? format(value.mean) : '–'}</span>
                        {value && <span className="tip" aria-hidden="true">Median {format(value.median)} &bull; SD {format(value.sd)} &bull; n = {value.n}</span>}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          <details>
            <summary className="cursor-pointer text-lg font-bold">Show these results as a table</summary>
            <div className="overflow-x-auto">
              <table className="mt-3 w-full border-collapse text-left">
                <caption className="sr-only">Mean, median, standard deviation and count for each measure, by system</caption>
                <thead>
                  <tr>
                    <th scope="col" className="border-b-2 border-line p-2">Measure</th>
                    <th scope="col" className="border-b-2 border-line p-2">System A: mean (median, SD, n)</th>
                    <th scope="col" className="border-b-2 border-line p-2">System B: mean (median, SD, n)</th>
                  </tr>
                </thead>
                <tbody>
                  {METRICS.map((metric) => (
                    <tr key={metric.key}>
                      <th scope="row" className="border-b border-line p-2 font-normal">{metric.label}{metric.unit && ` (${metric.unit})`}</th>
                      {(['A', 'B'] as const).map((condition) => {
                        const value = stat(condition, metric.key)
                        return <td key={condition} className="border-b border-line p-2">{value ? `${format(value.mean)} (${format(value.median)}, ${format(value.sd)}, ${value.n})` : 'No data'}</td>
                      })}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="p-2 font-normal">Tasks completed without help</th>
                    {(['A', 'B'] as const).map((condition) => {
                      const rate = summary.conditions[condition].completion_rate
                      return <td key={condition} className="p-2">{rate === null ? 'No data' : `${Math.round(rate * 100)}%`}</td>
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
          <p className="m-0 text-muted">
            These are descriptive statistics. With a small sample, test paired differences with the Wilcoxon signed-rank
            test on the exported CSV, and report effect sizes alongside each participant&rsquo;s profile.
          </p>
        </>
      )}
    </section>
  )
}

function NewParticipant({ onCreated }: { onCreated: () => void }) {
  const [profile, setProfile] = useState<Record<string, string>>({})
  return (
    <details>
      <summary className="btn inline-flex cursor-pointer"><Icon name="plus" /> Add a participant</summary>
      <form className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={async (event) => {
        event.preventDefault()
        await api.evalCreateParticipant(profile)
        setProfile({})
        onCreated()
      }}>
        {PROFILE_FIELDS.map((field) => (
          <label key={field.key} className="flex flex-col gap-1 font-bold">
            {field.label}
            <select className="field font-normal" value={profile[field.key] ?? ''} onChange={(event) => setProfile({ ...profile, [field.key]: event.target.value })}>
              <option value="">Not recorded</option>
              {field.options.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
        ))}
        <p className="m-0 text-muted sm:col-span-2 lg:col-span-3">
          Participants get an anonymous code. Do not record names here. The order of systems and task sets is
          counterbalanced automatically.
        </p>
        <button type="submit" className="btn btn-primary self-start">Create participant</button>
      </form>
    </details>
  )
}

function ParticipantCard({ participant, design, onRun, onQuestionnaires, onDelete }: {
  participant: EvalParticipant; design: EvalDesign
  onRun: (participant: EvalParticipant, condition: Condition, task: EvalTask) => Promise<void>
  onQuestionnaires: (condition: Condition) => void; onDelete: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const profile = PROFILE_FIELDS.map((f) => participant.profile[f.key]).filter(Boolean).join(' • ')
  return (
    <li className="rounded-2xl border-2 border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-xl">{participant.code}</h3>
        <p className="m-0 text-muted">{profile || 'No profile recorded'}</p>
      </div>
      <ol className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
        {(participant.condition_order.split('') as Condition[]).map((condition, position) => {
          const scores = participant.questionnaires.filter((q) => q.condition === condition)
          return (
            <li key={condition}>
              <p className="m-0 font-bold">{position === 0 ? 'First' : 'Second'}: System {condition} ({SYSTEM[condition]})</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {tasksFor(participant, condition, design).map((task) => {
                  const done = participant.trials.find((t) => t.condition === condition && t.task_id === task.id && t.finished)
                  return (
                    <button key={task.id} type="button" className="btn" onClick={() => void onRun(participant, condition, task)}>
                      <Icon name={done ? 'check' : 'play'} />
                      {done ? `Task ${task.id} done (${done.metrics.task_time_s}s). Run again` : `Run task ${task.id}: ${task.question}`}
                    </button>
                  )
                })}
                <button type="button" className="btn" onClick={() => onQuestionnaires(condition)}>
                  <Icon name={scores.length === 3 ? 'check' : 'chart'} />
                  Questionnaires ({scores.length} of 3)
                </button>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="mt-3">
        {confirming ? (
          <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`Delete ${participant.code}?`}>
            <strong>Delete all data for {participant.code}?</strong>
            <button type="button" className="btn" onClick={() => void onDelete()}>Yes, delete</button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="btn btn-quiet" onClick={() => setConfirming(true)}>
            <Icon name="trash" /> Withdraw participant and delete their data
          </button>
        )}
      </div>
    </li>
  )
}

/** NASA-TLX (raw), SUS and one satisfaction item. The researcher reads each item aloud and enters the spoken answer. */
function Questionnaires({ participant, condition, design, onSaved }: {
  participant: EvalParticipant; condition: Condition; design: EvalDesign; onSaved: () => void
}) {
  const [tlx, setTlx] = useState<number[]>(design.tlx_items.map(() => 50))
  const [sus, setSus] = useState<number[]>(design.sus_items.map(() => 3))
  const [satisfaction, setSatisfaction] = useState(4)
  const [error, setError] = useState('')
  const replace = (list: number[], index: number, value: number) => list.map((v, i) => (i === index ? value : v))

  const save = async () => {
    try {
      await api.evalQuestionnaire(participant.id, condition, 'tlx', tlx)
      await api.evalQuestionnaire(participant.id, condition, 'sus', sus)
      await api.evalQuestionnaire(participant.id, condition, 'satisfaction', [satisfaction])
      onSaved()
    } catch {
      setError('The questionnaires could not be saved. Try again.')
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <p className="m-0 text-muted">
        Read each item aloud and enter the participant&rsquo;s spoken answer. Give them time, and offer to repeat the scale.
      </p>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="p-0 text-xl font-bold">Workload (NASA-TLX): 0 is very low, 100 is very high</legend>
        {design.tlx_items.map((item, i) => (
          <label key={item} className="flex flex-col font-bold">
            {item}{item === 'Performance' && ' (0 is perfect, 100 is failure)'}: {tlx[i]}
            <input type="range" min={0} max={100} step={5} value={tlx[i]} onChange={(event) => setTlx(replace(tlx, i, Number(event.target.value)))} />
          </label>
        ))}
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="p-0 text-xl font-bold">Usability (SUS): 1 is strongly disagree, 5 is strongly agree</legend>
        {design.sus_items.map((item, i) => (
          <fieldset key={item} className="m-0 border-0 p-0">
            <legend className="p-0">{i + 1}. {item}</legend>
            <div className="mt-1 flex flex-wrap gap-4">
              {[1, 2, 3, 4, 5].map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input type="radio" name={`sus-${i}`} checked={sus[i] === value} onChange={() => setSus(replace(sus, i, value))} /> {value}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </fieldset>
      <fieldset className="m-0 border-0 p-0">
        <legend className="p-0 text-xl font-bold">Overall, how satisfied were you with this system? 1 is not at all, 7 is extremely</legend>
        <div className="mt-2 flex flex-wrap gap-4">
          {[1, 2, 3, 4, 5, 6, 7].map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="satisfaction" checked={satisfaction === value} onChange={() => setSatisfaction(value)} /> {value}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="m-0 font-bold">{error}</p>}
      <button type="submit" className="btn btn-primary self-start">Save questionnaires</button>
    </form>
  )
}

function Method() {
  return (
    <section aria-labelledby="method-heading" className="card">
      <h2 id="method-heading" className="m-0 mb-3 text-2xl">How to run a session</h2>
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-6">
        <li>Obtain informed consent in an accessible form (read aloud, or in braille or large print). Explain that the system is being tested, not the participant.</li>
        <li>Add the participant. Record how they normally read and use technology; blind people differ widely in this.</li>
        <li>Let them practise with each system on the Data Structures book until they feel ready. Let them choose speed, voice and verbosity.</li>
        <li>Run the two tasks for the first system shown on their card, then its questionnaires. Repeat for the second system.</li>
        <li>In System A, press F8 the moment the participant has found the answer. In System B this is logged automatically.</li>
        <li>After each task, ask the task&rsquo;s question and score the spoken answer against the key.</li>
        <li>Finish with a short interview: what helped, what got in the way, when they would not want to use voice.</li>
      </ol>
      <p className="mb-0 mt-3 text-muted">
        The full protocol, measures and analysis plan are in docs/HCI_EVALUATION.md.
      </p>
    </section>
  )
}
