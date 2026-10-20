/**
 * Screen-reader live regions.
 *
 * The app has its own voice, so routine status messages are only pushed to the
 * live region when the user has said they use a screen reader (otherwise two
 * voices would talk at once). Urgent messages that the app's voice cannot
 * deliver - for example "the voice stopped working" - always go through.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { getSettings } from '../core/settings'

type Announce = (text: string, urgent?: boolean) => void

const AnnouncerContext = createContext<Announce>(() => undefined)

export function useAnnounce(): Announce {
  return useContext(AnnouncerContext)
}

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')
  const flip = useRef(false)

  const announce = useCallback<Announce>((text, urgent = false) => {
    if (!urgent && !getSettings().screenReaderMode) return
    // Screen readers ignore a live region whose text did not change, so identical
    // consecutive messages alternate a trailing no-break space.
    flip.current = !flip.current
    const value = flip.current ? text : `${text} `
    if (urgent) setAssertive(value)
    else setPolite(value)
  }, [])

  const regions = useMemo(() => (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{polite}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{assertive}</div>
    </>
  ), [polite, assertive])

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      {regions}
    </AnnouncerContext.Provider>
  )
}
