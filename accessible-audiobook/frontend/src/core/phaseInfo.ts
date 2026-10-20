import type { IconName } from '../components/Icon'
import type { Phase } from './controller'

export interface PhaseInfo {
  label: string
  hint: string
  tone: 'idle' | 'reading' | 'listening' | 'thinking' | 'answering' | 'danger'
  icon: IconName
}

const PROBLEM: PhaseInfo = { label: 'Something went wrong', hint: 'Explaining what happened.', tone: 'danger', icon: 'alert' }

/** How each state of the interaction is shown: always a word and an icon, never colour alone. */
export const PHASES: Record<Phase, PhaseInfo> = {
  LOADING: { label: 'Opening your book', hint: 'One moment.', tone: 'thinking', icon: 'book' },
  IDLE: { label: 'Ready to read', hint: 'Press Space, or say "start reading".', tone: 'idle', icon: 'play' },
  PLAYING: { label: 'Reading', hint: 'Interrupt any time: press A, or just ask your question.', tone: 'reading', icon: 'book' },
  PAUSED: { label: 'Paused', hint: 'Press Space, or say "continue".', tone: 'idle', icon: 'pause' },
  PAUSING: { label: 'Pausing', hint: 'Keeping your place.', tone: 'listening', icon: 'pause' },
  CAPTURE_CONTEXT: { label: 'Pausing', hint: 'Keeping your place.', tone: 'listening', icon: 'pause' },
  LISTENING: { label: 'Listening', hint: 'Speak now.', tone: 'listening', icon: 'mic' },
  TRANSCRIBING: { label: 'Got it', hint: 'Working out what you said.', tone: 'thinking', icon: 'mic' },
  RETRIEVING: { label: 'Searching your textbook', hint: 'Finding the right part of the book.', tone: 'thinking', icon: 'search' },
  GENERATING: { label: 'Preparing your answer', hint: 'Almost there.', tone: 'thinking', icon: 'spark' },
  SPEAKING_ANSWER: { label: 'Answering', hint: 'Say "stop" to cut the answer short, or "stay paused" to remain here afterwards.', tone: 'answering', icon: 'speech' },
  FOLLOW_UP: { label: 'Any follow-up?', hint: 'Ask another question, or wait to continue.', tone: 'listening', icon: 'mic' },
  RESUME_CONFIRMATION: { label: 'Continuing', hint: 'Going back to where you stopped.', tone: 'reading', icon: 'play' },
  FINISHED: { label: 'End of the book', hint: 'Press Space to hear the last chapter again.', tone: 'idle', icon: 'check' },
  STT_FAILED: { ...PROBLEM, label: 'I could not hear a question' },
  RAG_FAILED: { ...PROBLEM, label: 'The textbook search failed' },
  LLM_FAILED: { ...PROBLEM, label: 'The answer could not be prepared' },
  TTS_FAILED: { ...PROBLEM, label: 'The voice stopped working' },
  NETWORK_ERROR: { ...PROBLEM, label: 'No connection to the server' },
}
