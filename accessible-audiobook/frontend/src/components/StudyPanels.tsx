/** The on-screen side of the study tools: the table of contents with search, and notes. */
import { useState } from 'react'
import type { BookDetail, Note } from '../types'
import { Icon } from './Icon'

/**
 * Table of contents and "find in this book". Everything here can also be done by
 * voice ("read the contents", "go to the section on page faults", "find ..."); the
 * panel is for people who prefer to see the structure or to pick with the keyboard.
 */
export function ContentsPanel({ book, chapterIndex, section, onHeading, onFind }: {
  book: BookDetail
  chapterIndex: number
  /** Title of the section being read ('' in a chapter's opening paragraphs). */
  section: string
  onHeading: (chapterIndex: number, section: string | null) => void
  onFind: (query: string) => void
}) {
  const [query, setQuery] = useState('')
  return (
    <details className="card" id="contents">
      <summary className="cursor-pointer text-xl font-bold">Contents and search</summary>
      <form className="mt-4 flex flex-wrap items-end gap-2" role="search" onSubmit={(event) => {
        event.preventDefault()
        if (query.trim()) onFind(query.trim())
        setQuery('')
      }}>
        <label htmlFor="find-in-book" className="flex min-w-56 flex-1 flex-col gap-1 font-bold">
          Find in this book
          <input id="find-in-book" className="field font-normal" value={query} onChange={(event) => setQuery(event.target.value)}
            autoComplete="off" placeholder="For example: the dirty bit" />
        </label>
        <button type="submit" className="btn"><Icon name="search" /> Find</button>
      </form>
      <nav aria-label="Table of contents" className="mt-4">
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {book.chapters.map((chapter) => {
            const here = chapter.index === chapterIndex
            return (
              <li key={chapter.id}>
                <button type="button" className={`btn w-full justify-start text-left ${here ? 'border-accent' : ''}`}
                  aria-current={here && !section ? 'location' : undefined} onClick={() => onHeading(chapter.index, null)}>
                  <Icon name="book" />
                  <span className="flex-1">{chapter.title}</span>
                  {chapter.start_page > 0 && <span className="text-muted">page {chapter.start_page}</span>}
                </button>
                <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0 pl-6">
                  {chapter.sections.filter((s) => s.title).map((s) => {
                    const current = here && s.title === section
                    return (
                      <li key={s.id}>
                        <button type="button" className={`btn btn-quiet w-full justify-start text-left ${current ? 'border-accent' : ''}`}
                          aria-current={current ? 'location' : undefined} onClick={() => onHeading(chapter.index, s.title)}>
                          <span className="flex-1">{s.title}</span>
                          {current && <span className="font-normal text-muted">you are here</span>}
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </li>
            )
          })}
        </ol>
      </nav>
    </details>
  )
}

/** Notes pinned to places in the book, with a typed way to add one and the study-sheet download. */
export function NotesPanel({ notes, onAdd, onGoto, onDelete, onExport }: {
  notes: Note[]
  onAdd: (text: string) => void
  onGoto: (note: Note) => void
  onDelete: (note: Note) => void
  onExport: () => void
}) {
  const [text, setText] = useState('')
  return (
    <details className="card" id="notes">
      <summary className="cursor-pointer text-xl font-bold">Notes ({notes.length})</summary>
      <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault()
        if (text.trim()) onAdd(text.trim())
        setText('')
      }}>
        <label htmlFor="new-note" className="flex min-w-56 flex-1 flex-col gap-1 font-bold">
          Add a note at the sentence being read
          <input id="new-note" className="field font-normal" value={text} maxLength={2000} onChange={(event) => setText(event.target.value)}
            autoComplete="off" aria-describedby="note-hint" />
        </label>
        <button type="submit" className="btn"><Icon name="plus" /> Save note</button>
      </form>
      <p id="note-hint" className="m-0 mt-1 text-muted">By voice: say &ldquo;take a note&rdquo;, or &ldquo;note that&rdquo; followed by your note.</p>

      {notes.length > 0 && (
        <ol className="m-0 mt-4 flex list-none flex-col gap-4 p-0">
          {notes.map((note, i) => (
            <li key={note.id} className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="m-0 text-lg font-bold">{i + 1}. {note.text}</p>
                <p className="m-0 text-muted">
                  {note.section || note.chapter}{note.page ? `, page ${note.page}` : ''}. The book was saying: &ldquo;{note.quote}&rdquo;
                </p>
              </div>
              <button type="button" className="btn" aria-label={`Go to note ${i + 1}`} onClick={() => onGoto(note)}>Go to place</button>
              <button type="button" className="btn" aria-label={`Delete note ${i + 1}`} onClick={() => onDelete(note)}><Icon name="trash" /> Delete</button>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn" onClick={onExport}><Icon name="download" /> Download study notes</button>
        <p className="m-0 flex-1 text-muted">
          One text file with your notes, bookmarks, and every question and answer for this book. It opens in any
          editor and reads well with a screen reader or a braille display.
        </p>
      </div>
    </details>
  )
}
