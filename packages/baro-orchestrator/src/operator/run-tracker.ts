import { type BaroEvent, describe, isMilestone, numberField, stringField } from "./protocol.js"

/* A bounded fold of one run's stream into what an operator needs to answer
   "what are they doing" and "how did it end". Twin of baro-dsh's domain/run. */

export type Terminal = "completed" | "error" | "max-tokens" | "aborted"

/* A run whose stories all merged with verification passed but whose goal
   contract stayed open delivered for the person who delegated it; calling it
   an error made a parent agent conclude nothing was produced. */
export function classifyDone(done: BaroEvent): Terminal {
    if (done.success === true) return "completed"
    if (done.abort_code === "token_ceiling") return "max-tokens"
    return deliveredDespiteContract(done) ? "completed" : "error"
}

export function deliveredDespiteContract(done: BaroEvent): boolean {
    if (done.success === true || done.abort_code !== undefined) return false
    const stats = done.stats as Record<string, unknown> | undefined
    const completed = typeof stats?.stories_completed === "number" ? stats.stories_completed : 0
    const skipped = typeof stats?.stories_skipped === "number" ? stats.stories_skipped : 0
    return completed > 0 && skipped === 0 && done.verification_status === "passed"
}

export function resolveTerminal(
    aborted: boolean,
    exitCode: number | null,
    done: BaroEvent | undefined,
): Terminal {
    if (aborted) return "aborted"
    if (done) return classifyDone(done)
    return exitCode === 0 ? "completed" : "error"
}

export type Phase = "intake" | "architect" | "planning" | "executing" | "finalizing" | "done"

export type StoryStatus = "pending" | "running" | "suspended" | "done" | "merged" | "failed"

export interface RunStory {
    readonly id: string
    readonly title: string
    readonly status: StoryStatus
}

export interface RunSummary {
    readonly project: string | undefined
    readonly phase: Phase
    readonly activity: string | undefined
    readonly stories: readonly RunStory[]
    readonly abortReason: string | undefined
    readonly storiesTotal: number
    readonly completed: number
    readonly total: number
    readonly prUrl: string | undefined
    readonly done: BaroEvent | undefined
    readonly milestones: readonly string[]
    readonly revision: number
}

const ACTIVITY_LIMIT = 140

export class RunTracker {
    private project: string | undefined
    private phase: Phase = "intake"
    private activity: string | undefined
    private storiesTotal = 0
    private completed = 0
    private total = 0
    private prUrl: string | undefined
    private done: BaroEvent | undefined
    private readonly milestones: string[] = []
    private readonly stories = new Map<string, RunStory>()
    private revision = 0

    constructor(private readonly limit = 200) {}

    private story(event: BaroEvent, status: StoryStatus): void {
        const id = stringField(event, "id", "storyId", "story_id")
        if (!id) return
        const known = this.stories.get(id)
        const title = stringField(event, "title") ?? known?.title ?? ""
        this.stories.set(id, { id, title, status })
        this.revision += 1
    }

    private rememberStories(list: unknown): void {
        if (!Array.isArray(list)) return
        for (const entry of list) {
            if (typeof entry !== "object" || entry === null) continue
            const id = stringField(entry as BaroEvent, "id")
            if (!id || this.stories.has(id)) continue
            this.stories.set(id, { id, title: stringField(entry as BaroEvent, "title") ?? "", status: "pending" })
        }
    }

    /** Returns the milestone line when the event was one. */
    accept(event: BaroEvent): string | null {
        switch (event.type) {
            case "architect_start":
                this.setPhase("architect")
                this.setActivity("architect is examining the repository")
                break
            case "architect_complete":
            case "architect_skipped":
            case "planning_open":
                this.setPhase("planning")
                this.setActivity("planner is composing the stories")
                break
            case "plan_fragment": {
                this.setPhase("planning")
                this.rememberStories(event.stories)
                const stories = Array.isArray(event.stories) ? event.stories : []
                this.storiesTotal += stories.length
                const titles = stories
                    .map((s) =>
                        typeof s === "object" && s !== null
                            ? stringField(s as BaroEvent, "title", "id")
                            : undefined,
                    )
                    .filter(Boolean)
                if (titles.length) this.setActivity(`plan: ${titles.join(", ")}`)
                break
            }
            case "plan_complete":
            case "plan_complete_summary":
                this.setPhase("planning")
                this.setActivity("plan complete, starting execution")
                break
            case "init":
                this.project = stringField(event, "project")
                this.rememberStories(event.stories)
                this.storiesTotal =
                    (Array.isArray(event.stories) ? event.stories.length : 0) || this.storiesTotal
                this.setPhase("executing")
                break
            case "activity": {
                const text = stringField(event, "text")
                const id = stringField(event, "id")
                if (text) this.setActivity(id && id !== "plan" ? `${id}: ${text}` : text)
                break
            }
            case "story_log": {
                const line = stringField(event, "line")
                const id = stringField(event, "id")
                if (line) this.setActivity(id && id !== "plan" ? `${id}: ${line}` : line)
                break
            }
            case "progress": {
                const completed = numberField(event, "completed", "done")
                const total = numberField(event, "total")
                if (completed !== undefined) this.completed = completed
                if (total !== undefined) this.total = total
                break
            }
            case "story_start":
                this.story(event, "running")
                break
            case "story_suspended":
                this.story(event, "suspended")
                break
            case "story_complete":
                this.story(event, "done")
                break
            case "story_merged":
                this.story(event, "merged")
                break
            case "merge_failed":
            case "story_error":
                this.story(event, "failed")
                break
            case "finalize_start":
                this.setPhase("finalizing")
                break
            case "push_status":
            case "finalize_complete": {
                const url = stringField(event, "pr_url", "url")
                if (url) this.prUrl = url
                break
            }
            case "done":
                this.done = event
                this.setPhase("done")
                break
        }
        if (!isMilestone(event)) return null
        const line = describe(event)
        this.milestones.push(line)
        if (this.milestones.length > this.limit) this.milestones.shift()
        this.revision += 1
        return line
    }

    summary(): RunSummary {
        return {
            project: this.project,
            phase: this.phase,
            activity: this.activity,
            stories: [...this.stories.values()],
            abortReason: this.done ? stringField(this.done, "abort_reason") : undefined,
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
    return [...head, ...(head.length ? [""] : []), ...summary.milestones.slice(-12)].join("\n")
}

export function renderOutcome(summary: RunSummary, terminal: Terminal): string {
    const done = summary.done
    const lines: string[] = []
    if (done) {
        const code = stringField(done, "abort_code")
        const reason = stringField(done, "abort_reason")
        const stats = done.stats as Record<string, unknown> | undefined
        if (done.success === true) {
            lines.push("baro run succeeded.")
        } else if (deliveredDespiteContract(done)) {
            lines.push(
                "baro run delivered: every story merged and verification passed, but baro left its goal contract open.",
            )
            if (reason) lines.push(`open contract: ${reason}`)
        } else {
            lines.push(`baro run failed${code ? ` (${code})` : ""}.`)
            if (reason) lines.push(reason)
        }
        if (stats) {
            lines.push(
                `stories completed: ${String(stats.stories_completed ?? "?")}, skipped: ${String(stats.stories_skipped ?? "?")}`,
            )
            if (typeof stats.total_commits === "number") lines.push(`commits: ${stats.total_commits}`)
            if (typeof stats.files_created === "number" || typeof stats.files_modified === "number") {
                lines.push(
                    `files created: ${String(stats.files_created ?? 0)}, modified: ${String(stats.files_modified ?? 0)}`,
                )
            }
        }
        const verification = stringField(done, "verification_status")
        if (verification) lines.push(`verification: ${verification}`)
    } else {
        lines.push(`baro run ended without a result (${terminal}).`)
    }
    if (summary.prUrl) lines.push(`pull request: ${summary.prUrl}`)
    const tail = summary.milestones.slice(-12)
    if (tail.length) lines.push("", "milestones:", ...tail)
    return lines.join("\n")
}
