import type { JobHooks, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { RunObserverPort, RunView } from '../../application/delegate-run.js'
import type { Terminal } from '../../domain/run.js'

/* Every run is one unowned `baro-N` job: unowned so the whole frame sees it
   in dsh's own jobs UI, not only the delegating agent. */

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    baro: 'baro'
  }
}

export class JobsObserver implements RunObserverPort {
  constructor(private readonly jobs: JobRegistry) {}

  opened(view: RunView): (terminal: Terminal) => void {
    let settle: ((outcome: JobOutcome) => void) | undefined
    const done = new Promise<JobOutcome>(resolve => {
      settle = resolve
    })
    const hooks: JobHooks = {
      cancel: reason => view.cancel(reason),
      done,
      readOutput: () => view.progress(),
    }
    this.jobs.start({ kind: 'baro', label: view.label, run: () => hooks })
    let settled = false
    return terminal => {
      if (settled) return
      settled = true
      settle?.(toJobOutcome(terminal))
    }
  }
}

function toJobOutcome(terminal: Terminal): JobOutcome {
  switch (terminal) {
    case 'completed':
      return { status: 'completed' }
    case 'aborted':
      return { status: 'killed', detail: 'cancelled' }
    default:
      return { status: 'failed', detail: terminal }
  }
}
