import type { RunRecord, RunsDocument } from '../adapters/dsh/settings-observer.js'

/* A tiny external store for the panel: one snapshot of the runs document,
   refreshed through a caller-supplied reader. React reads it with
   useSyncExternalStore; nothing here knows about React or dsh. */

export interface RunsSnapshot {
  readonly runs: ReadonlyArray<readonly [id: string, run: RunRecord]>
  readonly running: number
  readonly read: boolean
  readonly error: string | null
}

const EMPTY: RunsSnapshot = { runs: [], running: 0, read: false, error: null }

export class RunsStore {
  private snapshot: RunsSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private inflight: Promise<void> | undefined

  constructor(private readonly read: () => Promise<RunsDocument | null>) {}

  getSnapshot = (): RunsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Coalesces concurrent refreshes; a refresh requested mid-flight runs once more after. */
  refresh = (): Promise<void> => {
    if (this.inflight) return this.inflight.then(() => this.refresh())
    this.inflight = this.read()
      .then(doc => {
        this.publish(fold(doc))
      })
      .catch((error: unknown) => {
        this.publish({ ...this.snapshot, read: true, error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  reset(): void {
    this.publish(EMPTY)
  }

  private publish(next: RunsSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

export function fold(doc: RunsDocument | null): RunsSnapshot {
  const entries = Object.entries(doc?.runs ?? {})
  // Live first by start, then finished newest first — the same order dsh's own jobs list uses.
  entries.sort(([, a], [, b]) => {
    const liveA = a.status === 'running' ? 0 : 1
    const liveB = b.status === 'running' ? 0 : 1
    if (liveA !== liveB) return liveA - liveB
    return liveA === 0
      ? a.startedAt.localeCompare(b.startedAt)
      : (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')
  })
  return {
    runs: entries,
    running: entries.filter(([, r]) => r.status === 'running').length,
    read: true,
    error: null,
  }
}
