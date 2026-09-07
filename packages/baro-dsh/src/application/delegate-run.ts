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
  ) {}

  start(request: RunRequest): Delegation {
    if (!request.goal.trim()) throw new Error('baro needs a goal — the delegation prompt is empty')
    const tracker = new RunTracker()
    const child = this.process.start(request)

    let aborted = false
    const cancel = (reason?: string) => {
      aborted = true
      child.terminate()
      void reason
    }
    const closed = this.observer?.opened({
      label: request.label,
      progress: () => renderProgress(tracker.summary()),
      cancel,
    })

    const followed = (async () => {
      for await (const line of child.lines) {
        const event = parseLine(line)
        if (event) tracker.accept(event)
      }
    })()

    const outcome = (async (): Promise<DelegationOutcome> => {
      const { exitCode } = await child.exited
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
        await child.waitForExit()
      },
    }
  }
}
