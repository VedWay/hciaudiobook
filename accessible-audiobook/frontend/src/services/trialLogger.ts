import type { TrialEvent } from '../types'

/** Timestamps interaction events for one evaluation trial, relative to the moment the task started. */
export class TrialLogger {
  events: TrialEvent[] = []
  private startedAt: number | null = null

  start(): void {
    this.startedAt = performance.now()
    this.events = []
  }

  get running(): boolean {
    return this.startedAt !== null
  }

  elapsed(): number {
    return this.startedAt === null ? 0 : Math.round(performance.now() - this.startedAt)
  }

  log = (type: string, data?: Record<string, unknown>): void => {
    if (this.startedAt === null) return // nothing counts until the researcher starts the task
    this.events.push({ t: this.elapsed(), type, data })
  }
}
