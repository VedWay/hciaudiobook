import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePageVoice, useVoice } from '../accessibility/VoiceAgent'
import { useShortcuts } from '../accessibility/useShortcuts'
import { takeIntro } from '../components/GestureGate'
import { Icon } from '../components/Icon'
import { stopUiSpeech, uiSay } from '../core/audio'
import { earcons } from '../core/earcons'
import { getLastBook, parseLibraryPhrase, setLastBook } from '../core/libraryVoice'
import { getSettings } from '../core/settings'
import { useCapabilities } from '../hooks/useCapabilities'
import { api, ApiError, NetworkError } from '../services/api'
import type { BookDetail, BookSummary } from '../types'

function progressText(book: BookSummary): string {
  if (book.status === 'processing') return 'being prepared'
  if (book.status === 'failed') return 'could not be prepared'
  if (!book.session?.started) return 'not started'
  if (book.session.status === 'finished') return 'finished'
  return `${Math.round(book.session.progress * 100)} percent read`
}

export default function Library() {
  const navigate = useNavigate()
  const { tell } = useVoice()
  const capabilities = useCapabilities()
  const [books, setBooks] = useState<BookSummary[] | null>(null)
  const [error, setError] = useState('')
  const spokeSummary = useRef(false)
  const previous = useRef<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      const list = await api.listBooks()
      setBooks(list)
      setError('')
      for (const book of list) {
        const before = previous.current[book.id]
        if (before === 'processing' && book.status === 'ready') {
          earcons.play('answer')
          tell(`${book.title} is ready to read.`)
        } else if (before === 'processing' && book.status === 'failed') {
          earcons.play('error')
          tell(`${book.title} could not be prepared. ${book.status_detail}`)
        }
        previous.current[book.id] = book.status
      }
    } catch (caught) {
      setError(caught instanceof NetworkError ? 'The server could not be reached. Check that it is running, then try again.' : 'Your books could not be loaded.')
    }
  }, [tell])

  useEffect(() => { void refresh() }, [refresh])

  // While a book is being prepared, keep checking on it.
  const preparing = books?.some((b) => b.status === 'processing') ?? false
  useEffect(() => {
    if (!preparing) return
    const timer = setInterval(() => void refresh(), 1500)
    return () => clearInterval(timer)
  }, [preparing, refresh])

  const ready = (books ?? []).filter((b) => b.status === 'ready')
  const summary = useCallback(() => {
    if (!ready.length) return 'Your library is empty. Add a PDF textbook to begin.'
    return `You have ${ready.length} book${ready.length > 1 ? 's' : ''}. `
      + ready.map((b, i) => `${i + 1}: ${b.title}, ${progressText(b)}.`).join(' ')
      + ' Say "open", then the name or number of a book, or just say "continue".'
  }, [ready])

  // Orientation on arrival. A screen reader user gets this from the page itself instead.
  useEffect(() => {
    if (!books || spokeSummary.current || capabilities === undefined) return
    spokeSummary.current = true
    const s = getSettings()
    const intro = takeIntro()
    if (!s.screenReaderMode && s.verbosity !== 'earcons') void uiSay(`${intro}My books. ${summary()}`, capabilities)
  }, [books, capabilities, summary])

  useEffect(() => stopUiSpeech, [])

  const open = useCallback((book: BookSummary) => {
    stopUiSpeech()
    setLastBook(book.id)
    navigate(`/read/${book.id}`, { state: { autoplay: true } })
  }, [navigate])

  const restart = async (book: BookSummary) => {
    await api.restartBook(book.id)
    open(book)
  }

  // This page's own spoken commands. Anything else falls through to the app-wide voice layer.
  usePageVoice((phrase) => {
    // "open operating systems", "the second one", "start it from the beginning", just the title - or,
    // with no book named, "continue" / "resume" / "start reading" for the book last being read.
    const action = parseLibraryPhrase(phrase, ready, getLastBook())
    if (!action) return false
    switch (action.type) {
      case 'list':
        tell(`My books. ${summary()}`)
        break
      case 'upload':
        document.getElementById('book-file')?.focus()
        tell('The file chooser is focused. Press Enter to pick a book from your computer. Choosing the file itself cannot be done by voice.')
        break
      case 'empty':
        tell('Your library is empty. Add a PDF textbook to begin.')
        break
      case 'which':
        tell(`Which book? ${summary()}`)
        break
      case 'notFound':
        tell(`I could not find a book called ${action.wanted}. Say "list books" to hear your books.`)
        break
      case 'describe': {
        const { book } = action
        tell(`${book.title}${book.author ? `, by ${book.author}` : ''}. ${book.description} ${book.chapter_count} chapters. ${progressText(book)}.`)
        break
      }
      case 'restart':
        void restart(action.book)
        break
      case 'open':
        open(action.book)
    }
    return true
  }, ready.map((book) => book.title))

  useShortcuts(Object.fromEntries(ready.slice(0, 9).map((book, i) => [String(i + 1), () => open(book)])))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 text-4xl">My books</h1>
        <p className="m-0 mt-2 text-xl text-muted">
          Press a book&rsquo;s number to open it, or just say what you want: &ldquo;open operating systems&rdquo;,
          &ldquo;tell me about data structures&rdquo;, &ldquo;bigger text&rdquo;, &ldquo;go to settings&rdquo;.
        </p>
      </div>

      {error && (
        <div className="card flex flex-wrap items-center gap-4" role="alert">
          <Icon name="alert" size="2rem" /><p className="m-0 flex-1 text-xl">{error}</p>
          <button type="button" className="btn" onClick={() => void refresh()}>Try again</button>
        </div>
      )}
      {!books && !error && <p className="text-xl" role="status">Loading your books&hellip;</p>}

      <ol className="m-0 grid list-none gap-5 p-0 lg:grid-cols-2">
        {(books ?? []).map((book) => (
          <BookCard key={book.id} book={book} number={ready.indexOf(book) + 1} onOpen={() => open(book)} onRestart={() => void restart(book)}
            onDelete={async () => { await api.deleteBook(book.id); await refresh(); tell(`${book.title} was removed.`) }} />
        ))}
      </ol>

      <UploadBook maxMb={capabilities?.max_upload_mb ?? 40} onUploaded={(book) => { tell(`${book.title || 'Your book'} is being prepared. I will tell you when it is ready.`); void refresh() }} />
    </div>
  )
}

function BookCard({ book, number, onOpen, onRestart, onDelete }: {
  book: BookSummary; number: number; onOpen: () => void; onRestart: () => void; onDelete: () => Promise<void>
}) {
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [confirming, setConfirming] = useState(false)
  const session = book.session
  const started = !!session?.started
  const percent = Math.round((session?.progress ?? 0) * 100)
  const headingId = `book-${book.id}`

  return (
    <li className="card flex flex-col gap-4" aria-labelledby={headingId}>
      <div className="flex items-start gap-4">
        {book.status === 'ready' && number <= 9 && <span className="kbd text-2xl" aria-hidden="true">{number}</span>}
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="m-0 text-2xl">{book.title || book.id}</h2>
          {book.author && <p className="m-0 text-muted">{book.author}</p>}
        </div>
      </div>

      {book.status === 'processing' && (
        <div role="status">
          <p className="m-0 font-bold">Preparing this book: {book.status_detail || 'starting'}</p>
          <div className="meter mt-2" aria-hidden="true"><span style={{ width: `${Math.round(book.ingest_progress * 100)}%` }} /></div>
        </div>
      )}
      {book.status === 'failed' && (
        <p className="m-0 flex gap-2 font-bold"><Icon name="alert" /> {book.status_detail || 'This book could not be prepared.'}</p>
      )}

      {book.status === 'ready' && (
        <>
          <div>
            <p className="m-0 font-bold">
              {started ? `${percent}% read • Chapter ${session!.chapter_index + 1} of ${book.chapter_count}` : `Not started • ${book.chapter_count} chapters`}
            </p>
            <div className="meter mt-2" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
            {/* Readable already; its pictures are still being described and will appear as they are done. */}
            {book.status_detail && <p className="m-0 mt-2 text-muted">{book.status_detail}</p>}
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary flex-1" onClick={onOpen} aria-describedby={headingId}>
              <Icon name="play" /> {started ? 'Continue reading' : 'Start reading'}
            </button>
            {started && (
              <button type="button" className="btn" onClick={onRestart} aria-describedby={headingId}>
                <Icon name="repeat" /> Start from beginning
              </button>
            )}
          </div>
        </>
      )}

      <details onToggle={(event) => {
        if (event.currentTarget.open && !detail && book.status === 'ready') void api.getBook(book.id).then(setDetail).catch(() => undefined)
      }}>
        <summary className="cursor-pointer font-bold">Book information</summary>
        <div className="mt-2 flex flex-col gap-2">
          {book.description && <p className="m-0">{book.description}</p>}
          <p className="m-0 text-muted">
            {book.total_pages > 0 && `${book.total_pages} pages. `}
            {book.total_chars > 0 && `About ${Math.max(1, Math.round(book.total_chars / 15 / 60))} minutes of listening at normal speed. `}
            {book.is_sample ? 'Sample book.' : 'Uploaded by you.'}
          </p>
          {detail && (
            <ol className="m-0 list-decimal pl-6">
              {detail.chapters.map((chapter) => (
                <li key={chapter.id}>
                  {chapter.title.replace(/^chapter \d+:\s*/i, '')}
                  <span className="text-muted">{chapter.sections.filter((s) => s.title).length > 0 && `: ${chapter.sections.filter((s) => s.title).map((s) => s.title).join(', ')}`}</span>
                </li>
              ))}
            </ol>
          )}
          {!book.is_sample && book.status !== 'processing' && (
            confirming ? (
              <div className="flex flex-wrap items-center gap-3" role="group" aria-label={`Remove ${book.title}?`}>
                <span className="font-bold">Remove this book and your place in it?</span>
                <button type="button" className="btn" onClick={() => void onDelete()}><Icon name="trash" /> Yes, remove</button>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep it</button>
              </div>
            ) : (
              <button type="button" className="btn self-start" onClick={() => setConfirming(true)} aria-describedby={headingId}>
                <Icon name="trash" /> Remove book
              </button>
            )
          )}
        </div>
      </details>
    </li>
  )
}

function UploadBook({ maxMb, onUploaded }: { maxMb: number; onUploaded: (book: BookSummary) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const submit = async () => {
    // Check before uploading, so a mistake costs seconds rather than a failed upload.
    if (!file) return setError('Choose a file first.')
    if (!/\.(pdf|txt|md)$/i.test(file.name)) return setError('Please choose a PDF, TXT or Markdown file.')
    if (file.size > maxMb * 1024 * 1024) return setError(`That file is larger than ${maxMb} megabytes.`)
    setBusy(true)
    setError('')
    try {
      onUploaded(await api.uploadBook(file, title.trim()))
      setFile(null)
      setTitle('')
      if (input.current) input.current.value = ''
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The upload failed. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="upload-heading" className="card">
      <h2 id="upload-heading" className="m-0 mb-1 flex items-center gap-2 text-2xl"><Icon name="upload" /> Add a book</h2>
      <p className="m-0 mb-4 text-muted">
        Upload a textbook as a PDF (or a TXT or Markdown file), up to {maxMb} megabytes. Chapters and sections are found
        automatically. Scanned PDFs without real text cannot be read yet.
      </p>
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit() }} noValidate>
        <label className="flex flex-col gap-1 font-bold">
          Book file
          <input ref={input} id="book-file" type="file" className="field font-normal" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError('') }} aria-describedby={error ? 'upload-error' : undefined} />
        </label>
        <label className="flex flex-col gap-1 font-bold">
          Title <span className="font-normal text-muted">(optional: taken from the document if left empty)</span>
          <input className="field font-normal" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} autoComplete="off" />
        </label>
        {error && <p id="upload-error" role="alert" className="m-0 flex items-center gap-2 font-bold"><Icon name="alert" /> {error}</p>}
        <button type="submit" className="btn btn-primary self-start" aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault() }}>
          <Icon name="upload" /> {busy ? 'Uploading…' : 'Upload and prepare book'}
        </button>
      </form>
    </section>
  )
}
