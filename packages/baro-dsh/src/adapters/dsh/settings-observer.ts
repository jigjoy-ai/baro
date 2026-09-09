import type { RunObserverPort, RunSubscription, RunView } from '../../application/delegate-run.js'
import type { Phase, Terminal } from '../../domain/run.js'

/* The host→browser channel an out-of-tree plugin has: a settings namespace.
   dsh forwards `settings/document-updated` to every client, and the settings
   remote serves the namespace value, so a panel can follow a run without a
   remote of our own (the remote assembly is fixed at dsh build time). Writes
   are throttled — every update persists to settings.yaml. */

export type RunStatus = 'running' | Terminal

export interface RunRecord {
  readonly label: string
  readonly status: RunStatus
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly project: string | null
  readonly phase: Phase
  readonly activity: string | null
  readonly completed: number
  readonly total: number
  readonly prUrl: string | null
  /** Newest last. */
  readonly milestones: readonly string[]
}

export interface RunsDocument {
  readonly runs: Readonly<Record<string, RunRecord>>
}

export interface RunsSink {
  get(): RunsDocument
  update(patch: { runs: Record<string, RunRecord> }): Promise<void>
}

export interface SettingsObserverOptions {
  /** Minimum gap between two persisted updates of one run. */
  readonly throttleMs?: number
  /** Finished runs kept in the document, oldest dropped first. */
  readonly keepFinished?: number
  /** Milestone lines kept per run. */
  readonly tail?: number
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => unknown
}

export class SettingsObserver implements RunObserverPort {
  private readonly throttleMs: number
  private readonly keepFinished: number
  private readonly tail: number
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly sink: RunsSink,
    private readonly onError: (error: unknown) => void,
    options: SettingsObserverOptions = {},
  ) {
    this.throttleMs = options.throttleMs ?? 1_000
    this.keepFinished = options.keepFinished ?? 5
    this.tail = options.tail ?? 8
    this.now = options.now ?? Date.now
    this.schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  }

  opened(view: RunView): RunSubscription {
    let lastWrite = 0
    let pending = false
    let finished: Terminal | undefined

    const record = (): RunRecord => {
      const s = view.summary()
      return {
        label: view.label,
        status: finished ?? 'running',
        startedAt: view.startedAt,
        finishedAt: finished ? new Date(this.now()).toISOString() : null,
        project: s.project ?? null,
        phase: s.phase,
        activity: s.activity ?? null,
        completed: s.completed,
        total: s.total || s.storiesTotal,
        prUrl: s.prUrl ?? null,
        milestones: s.milestones.slice(-this.tail),
      }
    }
    const write = () => {
      pending = false
      lastWrite = this.now()
      this.persist(view.id, record())
    }
    const request = () => {
      if (pending) return
      const wait = this.throttleMs - (this.now() - lastWrite)
      if (wait <= 0) {
        write()
        return
      }
      pending = true
      this.schedule(write, wait)
    }

    write()
    return {
      changed: request,
      closed: terminal => {
        finished = terminal
        pending = false
        write()
      },
    }
  }

  /** Serialized read-modify-write: two runs updating at once must not lose each other. */
  private persist(id: string, next: RunRecord): void {
    this.chain = this.chain
      .then(async () => {
        const current = this.sink.get().runs
        const runs: Record<string, RunRecord> = { ...current, [id]: next }
        prune(runs, this.keepFinished)
        await this.sink.update({ runs })
      })
      .catch(this.onError)
  }
}

function prune(runs: Record<string, RunRecord>, keepFinished: number): void {
  const finished = Object.entries(runs)
    .filter(([, r]) => r.status !== 'running')
    .sort(([, a], [, b]) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
  for (const [id] of finished.slice(0, Math.max(0, finished.length - keepFinished))) delete runs[id]
}
