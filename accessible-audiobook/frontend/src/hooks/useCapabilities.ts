import { useEffect, useState } from 'react'
import { api } from '../services/api'
import type { Capabilities } from '../types'

let cached: Capabilities | null = null
let inflight: Promise<Capabilities> | null = null

/** Which providers the backend has configured. `undefined` while loading, `null` if the server is unreachable. */
export function useCapabilities(): Capabilities | null | undefined {
  const [capabilities, setCapabilities] = useState<Capabilities | null | undefined>(cached ?? undefined)
  useEffect(() => {
    if (cached) return
    let alive = true
    inflight ??= api.config().then((value) => (cached = value)).finally(() => { inflight = null })
    inflight.then((value) => { if (alive) setCapabilities(value) }, () => { if (alive) setCapabilities(null) })
    return () => { alive = false }
  }, [])
  return capabilities
}
