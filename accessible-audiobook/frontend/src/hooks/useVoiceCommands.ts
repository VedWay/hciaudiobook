import { useCallback, useEffect, useRef, useState } from 'react'
import { createSTT, lastSpokenByUi } from '../core/audio'
import { isLikelyEcho } from '../core/echo'
import { isCommand, parseIntent } from '../core/intents'
import { useSettings } from '../core/settings'
import type { Capabilities } from '../types'

export type VoiceStatus = 'listening' | 'off' | 'unsupported' | 'blocked' | 'network' | 'error'

export interface VoiceCommands {
  status: VoiceStatus
  /** The browser's own error name when status is 'network' or 'error'. */
  detail: string
  heard: string
  retry: () => void
}

/**
 * Always-on voice commands for pages other than the player (which has its own
 * listener inside the controller). The handler is called with each recognised
 * phrase; the returned status, error detail and last-heard phrase let the page
 * show whether the microphone is working and what it understood.
 */
export function useVoiceCommands(onPhrase: (text: string) => void, enabled = true, capabilities: Capabilities | null = null): VoiceCommands {
  const { micMode, speechLanguage, listenEngine } = useSettings()
  const serverSTT = capabilities?.server_stt ?? null
  const handler = useRef(onPhrase)
  const [status, setStatus] = useState<VoiceStatus>('off')
  const [detail, setDetail] = useState('')
  const [heard, setHeard] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { handler.current = onPhrase })

  useEffect(() => {
    // The same listener as the player: echo-cancelled microphone + Whisper when the server offers it.
    const stt = createSTT(capabilities)
    if (!stt || !stt.continuous) return setStatus('unsupported')
    if (!enabled || micMode !== 'always') return setStatus('off')
    // Start a moment later: the browser allows one recogniser at a time, and the
    // previous page's (or React's development double-mount's) may still be closing.
    const timer = setTimeout(() => {
      setStatus('listening')
      setDetail('')
      stt.start('continuous', {
        onFinal: (first, alternatives = []) => {
          // If any of the recogniser's guesses is a definite command ("paws" / "pause"), that is the one meant.
          const text = [first, ...alternatives].find((guess) => isCommand(parseIntent(guess))) ?? first
          if (isLikelyEcho(text, lastSpokenByUi())) return
          setHeard(text)
          handler.current(text)
        },
        onError: (code, browserError = '') => {
          setDetail(browserError)
          setStatus(code === 'not-allowed' ? 'blocked' : code === 'network' ? 'network' : 'error')
        },
      })
    }, 400)
    return () => {
      clearTimeout(timer)
      stt.stop()
    }
    // speechLanguage, listenEngine, serverSTT: each needs the listener to be started afresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `capabilities` is read only for server_stt
  }, [enabled, micMode, speechLanguage, listenEngine, serverSTT, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { status, detail, heard, retry }
}
