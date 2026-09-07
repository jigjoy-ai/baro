import { type BaroEvent, describe, isMilestone, numberField, stringField } from './protocol.js'

/* The run as the delegation sees it: a bounded fold of the stream into the
   facts a result or a panel needs. Bounded on purpose — a long run emits
   thousands of activity lines, and a result diagnostic has a 4 KiB ceiling. */

/** How a run ended, in a vocabulary a host can map onto its own. */
export type Terminal = 'completed' | 'error' | 'max-tokens' | 'aborted'

/* `done.abort_code` is a classification only when every failed story agreed
   on one code; a prose-only abort is `error`, never guessed further. */
export function classifyDone(done: BaroEvent): Terminal {
  if (done.success === true) return 'completed'
  return done.abort_code === 'token_ceiling' ? 'max-tokens' : 'error'
}

export function resolveTerminal(aborted: boolean, exitCode: number | null, done: BaroEvent | undefined): Terminal {
  if (aborted) return 'aborted'
  if (done) return classifyDone(done)
  // No `done` line: the process died before baro could classify anything.
  return exitCode === 0 ? 'completed' : 'error'
}

export interface RunSummary {
  readonly protocol: number | undefined
  readonly project: string | undefined
  readonly storiesTotal: number
  readonly completed: number
  readonly total: number
  readonly prUrl: string | undefined
  readonly done: BaroEvent | undefined
  /** Milestone lines in arrival order, oldest dropped past the limit. */
  readonly milestones: readonly string[]
}

export class RunTracker {
  private protocol: number | undefined
  private project: string | undefined
  private storiesTotal = 0
  private completed = 0
  private total = 0
  private prUrl: string | undefined
  private done: BaroEvent | undefined
  private readonly milestones: string[] = []

  constructor(private readonly limit = 200) {}

  accept(event: BaroEvent): void {
    switch (event.type) {
      case 'init':
        this.protocol = numberField(event, 'protocol')
        this.project = stringField(event, 'project')
        this.storiesTotal = Array.isArray(event.stories) ? event.stories.length : 0
        break
      case 'progress': {
        const completed = numberField(event, 'completed', 'done')
        const total = numberField(event, 'total')
        if (completed !== undefined) this.completed = completed
        if (total !== undefined) this.total = total
        break
      }
      case 'push_status':
      case 'finalize_complete': {
        const url = stringField(event, 'pr_url', 'url')
        if (url) this.prUrl = url
        break
      }
      case 'done':
        this.done = event
        break
    }
    if (isMilestone(event)) {
      this.milestones.push(describe(event))
      if (this.milestones.length > this.limit) this.milestones.shift()
    }
  }

  summary(): RunSummary {
    return {
      protocol: this.protocol,
      project: this.project,
      storiesTotal: this.storiesTotal,
      completed: this.completed,
      total: this.total,
      prUrl: this.prUrl,
      done: this.done,
      milestones: [...this.milestones],
    }
  }
}

/** The snapshot a panel reads: headline facts, then the milestone log. */
export function renderProgress(summary: RunSummary): string {
  const head = [
    summary.project ? `project: ${summary.project}` : undefined,
    summary.total > 0
      ? `progress: ${summary.completed}/${summary.total}`
      : summary.storiesTotal
        ? `stories: ${summary.storiesTotal}`
        : undefined,
    summary.prUrl ? `pr: ${summary.prUrl}` : undefined,
  ].filter((line): line is string => line !== undefined)
  return [...head, ...(head.length ? [''] : []), ...summary.milestones].join('\n')
}

/** The prose a delegating agent receives back. */
export function renderOutcome(summary: RunSummary, terminal: Terminal): string {
  const done = summary.done
  const lines: string[] = []
  if (done) {
    const code = stringField(done, 'abort_code')
    lines.push(done.success === true ? 'baro run succeeded.' : `baro run failed${code ? ` (${code})` : ''}.`)
    const reason = stringField(done, 'abort_reason')
    if (reason) lines.push(reason)
    const stats = done.stats as Record<string, unknown> | undefined
    if (stats) {
      lines.push(`stories completed: ${String(stats.stories_completed ?? '?')}, skipped: ${String(stats.stories_skipped ?? '?')}`)
    }
    const verification = stringField(done, 'verification_status')
    if (verification) lines.push(`verification: ${verification}`)
  } else {
    lines.push(`baro run ended without a result (${terminal}).`)
  }
  if (summary.prUrl) lines.push(`pull request: ${summary.prUrl}`)
  const tail = summary.milestones.slice(-12)
  if (tail.length) lines.push('', 'milestones:', ...tail)
  return lines.join('\n')
}
