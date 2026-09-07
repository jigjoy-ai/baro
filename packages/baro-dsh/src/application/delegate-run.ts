import { parseLine } from '../domain/protocol.js'
import { RunTracker, type RunSummary, type Terminal, renderOutcome, renderProgress, resolveTerminal } from '../domain/run.js'

/* The one use case: hand baro a goal, follow the run, report how it ended.
   Host-agnostic by construction — the ports below are the only way in or
   out, so the same use case serves dsh today and any other harness later. */

export interface RunRequest {
  readonly goal: string
  readonly cwd: string
  readonly label: string
  readonly runId: string
  readonly signal: AbortSignal
}

export interface RunProcess {
  /** stdout, one protocol line per element. */
  readonly lines: AsyncIterable<string>
  readonly exited: Promise<{ exitCode: number | null }>
  terminate(): void
  waitForExit(): Promise<unknown>
}

export interface RunProcessPort {
  start(request: RunRequest): RunProcess
}

export interface RunView {
  readonly label: string
  progress(): string
  cancel(reason?: string): void
}

/** Where a human watches a run (a jobs panel). Optional: a run without an observer still completes. */
export interface RunObserverPort {
  opened(view: RunView): (terminal: Terminal) => void
}

export interface DelegationOutcome {
  readonly terminal: Terminal
  readonly text: string
  readonly summary: RunSummary
}

export interface Delegation {
  readonly outcome: Promise<DelegationOutcome>
  cancel(reason?: string): void
  dispose(): Promise<void>
}

export class DelegateRun {
  constructor(
    private readonly process: RunProcessPort,
    private readonly observer: RunObserverPort | undefined,
    private readonly onObserverFailure?: (error: unknown) => void,
  ) {}

  start(request: RunRequest): Delegation {
    if (!request.goal.trim()) throw new Error('baro needs a goal — the delegation prompt is empty')
    const tracker = new RunTracker()

    let child: RunProcess | undefined
    let aborted = false
    const cancel = (reason?: string) => {
      aborted = true
      child?.terminate()
      void reason
    }
    // The observer opens before the process starts, and its failure is not the
    // run's failure: a panel that cannot be shown must never orphan a child or
    // turn a deliverable delegation into an error.
    let closed: ((terminal: Terminal) => void) | undefined
    try {
      closed = this.observer?.opened({
        label: request.label,
        progress: () => renderProgress(tracker.summary()),
        cancel,
      })
    } catch (error) {
      this.onObserverFailure?.(error)
    }
    child = this.process.start(request)

    const started = child
    const followed = (async () => {
      for await (const line of started.lines) {
        const event = parseLine(line)
        if (event) tracker.accept(event)
      }
    })()

    const outcome = (async (): Promise<DelegationOutcome> => {
      const { exitCode } = await started.exited
      await followed.catch(() => undefined)
      const summary = tracker.summary()
      const terminal = resolveTerminal(aborted || request.signal.aborted, exitCode, summary.done)
      closed?.(terminal)
      return { terminal, text: renderOutcome(summary, terminal), summary }
    })()

    return {
      outcome,
      cancel,
      dispose: async () => {
        cancel('disposed')
        await started.waitForExit()
      },
    }
  }
}
