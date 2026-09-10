/* baro's TUI protocol v3 (docs/tui-protocol-v3.md) as a delegating host reads
   it: the milestone subset is a type list by contract, so "certified outcome
   or live feed" is a membership test. Twin of packages/baro-dsh/src/domain. */

export interface BaroEvent {
    readonly type: string
    readonly ts?: string
    readonly [key: string]: unknown
}

export const MILESTONE_TYPES: ReadonlySet<string> = new Set([
    "init",
    "story_start",
    "story_suspended",
    "critique",
    "story_merged",
    "merge_failed",
    "story_complete",
    "story_error",
    "level_started",
    "level_completed",
    "recovery_started",
    "replan",
    "progress",
    "push_status",
    "finalize_start",
    "finalize_complete",
    "done",
])

export function parseLine(line: string): BaroEvent | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) return null
    try {
        const value: unknown = JSON.parse(trimmed)
        if (typeof value !== "object" || value === null) return null
        const type = (value as { type?: unknown }).type
        return typeof type === "string" ? (value as BaroEvent) : null
    } catch {
        return null
    }
}

export function isMilestone(event: BaroEvent): boolean {
    return MILESTONE_TYPES.has(event.type)
}

export function stringField(event: BaroEvent, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = event[key]
        if (typeof value === "string" && value) return value
    }
    return undefined
}

export function numberField(event: BaroEvent, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = event[key]
        if (typeof value === "number") return value
    }
    return undefined
}

/** One human line per milestone. */
export function describe(event: BaroEvent): string {
    const id = stringField(event, "id", "storyId", "story_id")
    const at = typeof event.ts === "string" ? event.ts.slice(11, 19) : ""
    const head = at ? `${at} ${event.type}` : event.type
    switch (event.type) {
        case "init": {
            const stories = Array.isArray(event.stories) ? event.stories.length : 0
            return `${head} ${stringField(event, "project") ?? ""} (${stories} stories)`.replace("  ", " ")
        }
        case "progress":
            return `${head} ${numberField(event, "completed", "done") ?? "?"}/${numberField(event, "total") ?? "?"}`
        case "critique":
            return `${head} ${id ?? ""} ${stringField(event, "verdict", "status") ?? ""}`.trim()
        case "done": {
            const code = stringField(event, "abort_code")
            return `${head} ${event.success === true ? "success" : `failed${code ? ` (${code})` : ""}`}`
        }
        default:
            return id ? `${head} ${id}` : head
    }
}
