/** Typed client for the FastAPI backend. No API keys ever live in the frontend. */
import type {
  AskBody, AskContext, AskEvent, BookDetail, BookSummary, Bookmark, Capabilities, ChapterContent, EvalDesign,
  EvalParticipant, EvalSummary, EvalTask, FindMatch, HistoryMessage, Note, PlaybackSession, PlaybackUpdate, QuizQuestion,
  TrialEvent, VoiceCatalogue,
} from '../types'

const BASE = import.meta.env.VITE_API_URL ?? ''
const TOKEN_KEY = 'aa.token'
const PASSCODE_KEY = 'aa.researcher'

export type Interpretation =
  | { kind: 'command'; command: string }
  | { kind: 'question'; question: string }
  | { kind: 'reply'; text: string }
  /** `failed`: the model could not be asked, as opposed to deciding the words were not for the app. */
  | { kind: 'ignore'; failed?: boolean }

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = '') {
    super(message)
    this.status = status
    this.code = code
  }
}

/** The server could not be reached at all (offline, backend down). */
export class NetworkError extends Error {}

let tokenPromise: Promise<string> | null = null

async function guestToken(): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  if (!response.ok) throw new ApiError(response.status, 'Could not start a session.')
  const token = (await response.json()).access_token as string
  localStorage.setItem(TOKEN_KEY, token)
  return token
}

function getToken(): Promise<string> {
  const stored = localStorage.getItem(TOKEN_KEY)
  if (stored) return Promise.resolve(stored)
  tokenPromise ??= guestToken().finally(() => { tokenPromise = null })
  return tokenPromise
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function researcherPasscode(value?: string): string {
  if (value !== undefined) sessionStorage.setItem(PASSCODE_KEY, value)
  return sessionStorage.getItem(PASSCODE_KEY) ?? ''
}

async function send(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers)
  let response: Response
  try {
    headers.set('Authorization', `Bearer ${await getToken()}`)
    const passcode = researcherPasscode()
    if (passcode && path.startsWith('/api/eval')) headers.set('X-Researcher-Passcode', passcode)
    response = await fetch(`${BASE}${path}`, { ...init, headers })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof ApiError) throw error
    throw new NetworkError('The server could not be reached.')
  }
  if (response.status === 401 && retry) {
    // The stored token expired or the database was reset: start a fresh guest session once.
    localStorage.removeItem(TOKEN_KEY)
    return send(path, init, false)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = body?.detail
    const message = typeof detail === 'string' ? detail : detail?.message ?? `Request failed (${response.status}).`
    throw new ApiError(response.status, message, typeof detail === 'object' ? detail?.code ?? '' : '')
  }
  return response
}

async function json<T>(path: string, method = 'GET', body?: unknown, extra: RequestInit = {}): Promise<T> {
  const response = await send(path, {
    method, ...extra,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.status === 204 ? (undefined as T) : response.json()
}

async function* askStream(bookId: string, body: AskBody, signal: AbortSignal): AsyncGenerator<AskEvent> {
  const response = await send(`/api/books/${bookId}/ask/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as AskEvent
      if (done) break
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new NetworkError('The connection was lost while answering.')
  }
  if (buffer.trim()) yield JSON.parse(buffer) as AskEvent
}

export const api = {
  config: () => json<Capabilities>('/api/config'),
  me: () => json<{ id: string; display_name: string; email: string | null; is_guest: boolean }>('/api/auth/me'),
  register: (email: string, password: string, display_name: string) =>
    json<{ access_token: string }>('/api/auth/register', 'POST', { email, password, display_name }),
  login: (email: string, password: string) => json<{ access_token: string }>('/api/auth/login', 'POST', { email, password }),

  listBooks: () => json<BookSummary[]>('/api/books'),
  getBook: (id: string) => json<BookDetail>(`/api/books/${id}`),
  getChapter: (id: string, index: number) => json<ChapterContent>(`/api/books/${id}/chapters/${index}`),
  deleteBook: (id: string) => json<void>(`/api/books/${id}`, 'DELETE'),
  async uploadBook(file: File, title: string): Promise<BookSummary> {
    const form = new FormData()
    form.append('file', file)
    form.append('title', title)
    return (await send('/api/books', { method: 'POST', body: form })).json()
  },

  getSession: (id: string) => json<PlaybackSession>(`/api/books/${id}/session`),
  /** keepalive lets the final save complete even while the page is closing. */
  saveSession: (id: string, body: PlaybackUpdate, keepalive = false) =>
    json<PlaybackSession>(`/api/books/${id}/session`, 'PUT', body, { keepalive }),
  restartBook: (id: string) => json<PlaybackSession>(`/api/books/${id}/session`, 'DELETE'),

  askStream,
  quiz: (id: string, context: AskContext) => json<QuizQuestion>(`/api/books/${id}/quiz`, 'POST', { context }),
  quizCheck: (id: string, quiz: QuizQuestion, answer: string) =>
    json<{ verdict: 'correct' | 'partly' | 'incorrect'; feedback: string }>(`/api/books/${id}/quiz/check`, 'POST', { ...quiz, answer }),
  questions: (id: string) => json<HistoryMessage[]>(`/api/books/${id}/questions`),

  /** Ask the language model what an unrecognised spoken request means. */
  interpret: (body: { utterance: string; page: string; state: string; books: string[]; reading?: string }) =>
    json<Interpretation>('/api/assistant/interpret', 'POST', body),

  bookmarks: (id: string) => json<Bookmark[]>(`/api/books/${id}/bookmarks`),
  addBookmark: (id: string, chunk_id: number, sentence_index: number, label: string) =>
    json<Bookmark>(`/api/books/${id}/bookmarks`, 'POST', { chunk_id, sentence_index, label }),
  deleteBookmark: (id: string, bookmarkId: number) => json<void>(`/api/books/${id}/bookmarks/${bookmarkId}`, 'DELETE'),

  notes: (id: string) => json<Note[]>(`/api/books/${id}/notes`),
  addNote: (id: string, chunk_id: number, sentence_index: number, text: string) =>
    json<Note>(`/api/books/${id}/notes`, 'POST', { chunk_id, sentence_index, text }),
  deleteNote: (id: string, noteId: number) => json<void>(`/api/books/${id}/notes/${noteId}`, 'DELETE'),
  /** "Find the part about ...": the best-matching places in the book, best first. */
  find: (id: string, query: string) => json<{ matches: FindMatch[] }>(`/api/books/${id}/find`, 'POST', { query }),
  /** Notes, bookmarks and questions for one book as a Markdown document. */
  async studyNotes(id: string): Promise<Blob> {
    return (await send(`/api/books/${id}/study-notes`)).blob()
  },

  async transcribe(audio: Blob, language = 'en'): Promise<string> {
    const form = new FormData()
    form.append('audio', audio, 'question')
    form.append('language', language)
    return (await (await send('/api/speech/transcribe', { method: 'POST', body: form })).json()).text
  },
  /** Audio for one sentence plus [milliseconds, character index] for each word in it. */
  async synthesize(text: string, role: 'narrator' | 'assistant', voice?: string): Promise<{ audio: Blob; words: [number, number][] }> {
    const response = await send('/api/speech/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, role, voice: voice || null }),
    })
    let words: [number, number][] = []
    try {
      words = JSON.parse(response.headers.get('X-Word-Timings') ?? '[]')
    } catch {
      // No timings: the player estimates the position instead.
    }
    return { audio: await response.blob(), words }
  },

  /** The natural voices the listener can choose between. */
  voices: () => json<VoiceCatalogue>('/api/speech/voices'),

  evalDesign: () => json<EvalDesign>('/api/eval/design'),
  evalParticipants: () => json<EvalParticipant[]>('/api/eval/participants'),
  evalCreateParticipant: (profile: Record<string, string>) => json<EvalParticipant>('/api/eval/participants', 'POST', { profile }),
  evalDeleteParticipant: (id: number) => json<void>(`/api/eval/participants/${id}`, 'DELETE'),
  evalCreateTrial: (participant_id: number, condition: 'A' | 'B', task_id: string) =>
    json<{ id: number; condition: 'A' | 'B'; task: EvalTask }>('/api/eval/trials', 'POST', { participant_id, condition, task_id }),
  evalFinishTrial: (id: number, body: { duration_ms: number; events: TrialEvent[]; completed: boolean; comprehension: number | null; notes: string }) =>
    json<{ metrics: Record<string, number | null> }>(`/api/eval/trials/${id}/finish`, 'POST', body),
  evalQuestionnaire: (participant_id: number, condition: 'A' | 'B', kind: 'tlx' | 'sus' | 'satisfaction', responses: number[]) =>
    json<{ score: number }>('/api/eval/questionnaires', 'POST', { participant_id, condition, kind, responses }),
  evalSummary: () => json<EvalSummary>('/api/eval/summary'),
  async evalExport(): Promise<Blob> {
    return (await send('/api/eval/export.csv')).blob()
  },
}

export type Api = typeof api
