export interface PlaybackSession {
  book_id: string
  chapter_id: number | null
  chapter_index: number
  chunk_id: number | null
  sentence_index: number
  character_offset: number
  audio_time: number
  playback_speed: number
  status: string
  started: boolean
  progress: number
  /** ISO time the position was last saved ('' from older servers). */
  last_updated?: string
}

export interface BookSummary {
  id: string
  title: string
  author: string
  description: string
  total_pages: number
  total_chunks: number
  total_chars: number
  chapter_count: number
  status: 'processing' | 'ready' | 'failed'
  status_detail: string
  ingest_progress: number
  is_sample: boolean
  session: PlaybackSession | null
}

export interface ChapterOutline {
  id: number
  index: number
  title: string
  start_page: number
  char_count: number
  sections: { id: number; index: number; title: string }[]
}

export interface BookDetail extends BookSummary {
  chapters: ChapterOutline[]
}

export interface ChapterContent {
  id: number
  index: number
  title: string
  sections: {
    id: number
    index: number
    title: string
    /** paragraph_starts: indices into `sentences` where a paragraph begins (used for skimming). */
    chunks: { id: number; chunk_index: number; page: number; sentences: string[]; paragraph_starts?: number[] }[]
  }[]
}

export interface PlaybackUpdate {
  chunk_id: number
  sentence_index: number
  character_offset: number
  audio_time: number
  playback_speed: number
  status: 'playing' | 'paused' | 'interrupted' | 'stopped' | 'finished'
  reason: 'autosave' | 'interrupt' | 'manual'
}

export type QAIntent = 'question' | 'explain' | 'simplify' | 'example' | 'define' | 'summarize' | 'elaborate'

export interface AskContext {
  chapter: string
  section: string
  page: number
  chunk_id: number | null
  sentence_index: number
  character_offset: number
  current_sentence: string
  recent_context: string
}

export interface AskBody {
  question: string
  intent: QAIntent
  term?: string
  scope?: 'section' | 'chapter'
  answer_length: 'brief' | 'detailed'
  conversation_id: string | null
  context: AskContext
}

export interface Source {
  chunk_id: number
  chapter: string
  section: string
  page: number
  relation: 'current' | 'heard' | 'ahead'
  score: number
}

export type AskEvent =
  | { type: 'stage'; stage: 'retrieving' | 'generating' }
  | { type: 'sources'; sources: Source[]; query: string }
  | { type: 'sentence'; text: string }
  | { type: 'done'; answer: string; conversation_id: string; grounded: boolean; provider: string; sources: Source[]; timings: Record<string, number> }
  | { type: 'error'; code: 'RAG_FAILED' | 'LLM_FAILED'; message: string }

export interface Bookmark {
  id: number
  chunk_id: number
  sentence_index: number
  label: string
  chapter_index: number
  chapter: string
  section: string
  page: number
}

/** A study note pinned to the sentence the student was hearing when they made it. */
export interface Note {
  id: number
  chunk_id: number
  sentence_index: number
  text: string
  chapter_index: number
  chapter: string
  section: string
  page: number
  /** The sentence of the book the note is attached to. */
  quote: string
}

/** One place in the book that matches "find the part about ...". */
export interface FindMatch {
  chunk_id: number
  sentence_index: number
  chapter_index: number
  chapter: string
  section: string
  page: number
  snippet: string
  score: number
}

export interface QuizQuestion {
  question: string
  expected: string
}

export interface Capabilities {
  llm: string
  llm_is_local_fallback: boolean
  embeddings: string
  vector_store: string
  server_stt: string | null
  server_tts: string | null
  /** The vision model that describes a book's pictures, or null when pictures are passed over. */
  picture_descriptions?: string | null
  max_upload_mb: number
  evaluation_requires_passcode: boolean
}

export interface NaturalVoice {
  id: string
  label: string
  locale: string
  gender: string
}

export interface VoiceCatalogue {
  voices: NaturalVoice[]
  defaults: { narrator: string; assistant: string }
}

export interface HistoryMessage {
  id: number
  role: 'student' | 'assistant'
  text: string
  intent: string
  sources: Source[]
}

// --- evaluation ---

export interface EvalTask {
  id: string
  set: string
  chapter_index: number
  section: string
  goal: string
  question: string
  answer_key: string
}

export interface EvalDesign {
  book_id: string
  tasks: EvalTask[]
  tlx_items: string[]
  sus_items: string[]
}

export interface EvalTrialOut {
  id: number
  condition: 'A' | 'B'
  task_id: string
  finished: boolean
  completed: boolean
  comprehension: number | null
  metrics: Record<string, number | null>
  notes: string
}

export interface EvalParticipant {
  id: number
  code: string
  profile: Record<string, string>
  condition_order: 'AB' | 'BA'
  task_sets: 'XY' | 'YX'
  trials: EvalTrialOut[]
  questionnaires: { condition: 'A' | 'B'; kind: 'tlx' | 'sus' | 'satisfaction'; score: number }[]
}

export interface Stat {
  n: number
  mean: number
  median: number
  sd: number
}

export interface EvalSummary {
  participants: number
  conditions: Record<'A' | 'B', { trials: number; completion_rate: number | null } & Record<string, Stat | number | null>>
}

export interface TrialEvent {
  t: number
  type: string
  data?: Record<string, unknown>
}
