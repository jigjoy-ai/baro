import { type BaroEvent, describe, isMilestone, numberField, stringField } from './protocol.js'

/* The run as the delegation sees it: a bounded fold of the stream into the
   facts a result or a panel needs. Bounded on purpose — a long run emits
   thousands of activity lines, and a result diagnostic has a 4 KiB ceiling. */

/** How a run ended, in a vocabulary a host can map onto its own. */
export type Terminal = 'completed' | 'error' | 'max-tokens' | 'aborted'

/* `done.abort_code` is a classification only when every failed story agreed
   on one code; a prose-only abort is `error`, never guessed further — with one
   exception. baro marks a run unsuccessful when its goal contract keeps open
   invariants even though every story merged and verification passed. For the
   delegating agent that run delivered; calling it an error made the parent
   conclude nothing was produced. It is `completed`, and the text carries the
   open contract. */
export function classifyDone(done: BaroEvent): Terminal {
  if (done.success === true) return 'completed'
  if (done.abort_code === 'token_ceiling') return 'max-tokens'
  return deliveredDespiteContract(done) ? 'completed' : 'error'
}

export function deliveredDespiteContract(done: BaroEvent): boolean {
  if (done.success === true || done.abort_code !== undefined) return false
  const stats = done.stats as Record<string, unknown> | undefined
  const completed = typeof stats?.stories_completed === 'number' ? stats.stories_completed : 0
  const skipped = typeof stats?.stories_skipped === 'number' ? stats.stories_skipped : 0
  return completed > 0 && skipped === 0 && done.verification_status === 'passed'
}

export function resolveTerminal(aborted: boolean, exitCode: number | null, done: BaroEvent | undefined): Terminal {
  if (aborted) return 'aborted'
  if (done) return classifyDone(done)
  // No `done` line: the process died before baro could classify anything.
  return exitCode === 0 ? 'completed' : 'error'
}

/* Where the run is. `init` is the first milestone but arrives minutes in —
   intake is silent on the stream, the architect and planner announce
   themselves with non-milestone events — so a watcher needs the phase, not
   only the certified outcomes. */
export type Phase = 'intake' | 'architect' | 'planning' | 'executing' | 'finalizing' | 'done'

export interface RunSummary {
  readonly protocol: number | undefined
  readonly project: string | undefined
  readonly phase: Phase
  /** Last live-feed line worth a glance (activity, story log), never archived. */
  readonly activity: string | undefined
  readonly storiesTotal: number
  readonly completed: number
  readonly total: number
  readonly prUrl: string | undefined
  readonly done: BaroEvent | undefined
  /** Milestone lines in arrival order, oldest dropped past the limit. */
  readonly milestones: readonly string[]
  /** Bumps whenever anything above moved; cheap change detection for observers. */
  readonly revision: number
}

const ACTIVITY_LIMIT = 140

export class RunTracker {
  private protocol: number | undefined
  private project: string | undefined
  private phase: Phase = 'intake'
  private activity: string | undefined
  private storiesTotal = 0
  private completed = 0
  private total = 0
  private prUrl: string | undefined
  private done: BaroEvent | undefined
  private readonly milestones: string[] = []
  private revision = 0

  constructor(private readonly limit = 200) {}

  accept(event: BaroEvent): void {
    const before = this.revision
    switch (event.type) {
      case 'architect_start':
        this.setPhase('architect')
        this.setActivity('architect is examining the repository')
        break
      case 'architect_complete':
      case 'architect_skipped':
      case 'planning_open':
        this.setPhase('planning')
        this.setActivity('planner is composing the stories')
        break
      case 'plan_fragment': {
        this.setPhase('planning')
        const stories = Array.isArray(event.stories) ? event.stories : []
        this.storiesTotal += stories.length
        const titles = stories.map(s => (typeof s === 'object' && s !== null ? stringField(s as BaroEvent, 'title', 'id') : undefined)).filter(Boolean)
        if (titles.length) this.setActivity(`plan: ${titles.join(', ')}`)
        break
      }
      case 'plan_complete':
      case 'plan_complete_summary':
        this.setPhase('planning')
        this.setActivity('plan complete, starting execution')
        break
      case 'init':
        this.protocol = numberField(event, 'protocol')
        this.project = stringField(event, 'project')
        // Progressive planning inits with an empty graph and fills it by fragments; keep what we counted.
        this.storiesTotal = (Array.isArray(event.stories) ? event.stories.length : 0) || this.storiesTotal
        this.setPhase('executing')
        break
      case 'activity': {
        const text = stringField(event, 'text')
        const id = stringField(event, 'id')
        if (text) this.setActivity(id && id !== 'plan' ? `${id}: ${text}` : text)
        break
      }
      case 'story_log': {
        const line = stringField(event, 'line')
        const id = stringField(event, 'id')
        if (line) this.setActivity(id && id !== 'plan' ? `${id}: ${line}` : line)
        break
      }
      case 'progress': {
        const completed = numberField(event, 'completed', 'done')
        const total = numberField(event, 'total')
        if (completed !== undefined) this.completed = completed
        if (total !== undefined) this.total = total
        break
      }
      case 'finalize_start':
        this.setPhase('finalizing')
        break
      case 'push_status':
      case 'finalize_complete': {
        const url = stringField(event, 'pr_url', 'url')
        if (url) this.prUrl = url
        break
      }
      case 'done':
        this.done = event
        this.setPhase('done')
        break
    }
    if (isMilestone(event)) {
      this.milestones.push(describe(event))
      if (this.milestones.length > this.limit) this.milestones.shift()
      this.revision += 1
    } else if (this.revision === before && (event.type === 'progress' || event.type === 'push_status')) {
      this.revision += 1
    }
  }

  summary(): RunSummary {
    return {
      protocol: this.protocol,
      project: this.project,
      phase: this.phase,
      activity: this.activity,
      storiesTotal: this.storiesTotal,
      completed: this.completed,
      total: this.total,
      prUrl: this.prUrl,
      done: this.done,
      milestones: [...this.milestones],
      revision: this.revision,
    }
  }

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.revision += 1
  }

  private setActivity(text: string): void {
    const next = text.length > ACTIVITY_LIMIT ? `${text.slice(0, ACTIVITY_LIMIT - 1)}…` : text
    if (this.activity === next) return
    this.activity = next
    this.revision += 1
  }
}

/** The snapshot a panel reads: headline facts, then the milestone log. */
export function renderProgress(summary: RunSummary): string {
  const head = [
    `phase: ${summary.phase}`,
    summary.activity ? `activity: ${summary.activity}` : undefined,
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
    const reason = stringField(done, 'abort_reason')
    const stats = done.stats as Record<string, unknown> | undefined
    if (done.success === true) {
      lines.push('baro run succeeded.')
    } else if (deliveredDespiteContract(done)) {
      lines.push('baro run delivered: every story merged and verification passed, but baro left its goal contract open.')
      if (reason) lines.push(`open contract: ${reason}`)
    } else {
      lines.push(`baro run failed${code ? ` (${code})` : ''}.`)
      if (reason) lines.push(reason)
    }
    if (stats) {
      const facts = [
        `stories completed: ${String(stats.stories_completed ?? '?')}, skipped: ${String(stats.stories_skipped ?? '?')}`,
        typeof stats.total_commits === 'number' ? `commits: ${stats.total_commits}` : undefined,
        typeof stats.files_created === 'number' || typeof stats.files_modified === 'number'
          ? `files created: ${String(stats.files_created ?? 0)}, modified: ${String(stats.files_modified ?? 0)}`
          : undefined,
      ].filter((f): f is string => f !== undefined)
      lines.push(...facts)
    }
    const verification = stringField(done, 'verification_status')
    if (verification) lines.push(`verification: ${verification}`)
    if (done.success !== true) lines.push('Changes are committed in the working directory; inspect them with git log.')
  } else {
    lines.push(`baro run ended without a result (${terminal}).`)
  }
  if (summary.prUrl) lines.push(`pull request: ${summary.prUrl}`)
  const tail = summary.milestones.slice(-12)
  if (tail.length) lines.push('', 'milestones:', ...tail)
  return lines.join('\n')
}
