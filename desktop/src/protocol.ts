// Typed view of the events the long-lived `session.ts` process emits on
// stdout (and that the Tauri core forwards as `session-event`). Mirrors
// packages/baro-orchestrator/scripts/session.ts + tui-protocol.ts.

export interface DraftStory {
    id: string
    title: string
    depends_on: string[]
    model: string
}

export type SessionEvent =
    // ── planning ──
    | {
          type: "plan_draft"
          project: string
          description: string
          stories: DraftStory[]
          levels: { id: string; model: string }[][]
      }
    | { type: "plan_reply"; text: string }
    | { type: "plan_error"; text: string }
    | { type: "plan_committed"; prd: string }
    | { type: "plan_status"; state: "planning" | "refining" | "idle"; model?: string }
    // ── execution (BaroEvent) ──
    | { type: "init"; project: string; stories: { id: string; title: string }[] }
    | { type: "dag"; levels: { id: string }[][] }
    | { type: "story_start"; id: string; title: string }
    | { type: "story_log"; id: string; line: string }
    | {
          type: "story_complete"
          id: string
          duration_secs: number
          files_created: number
          files_modified: number
      }
    | { type: "story_error"; id: string; error: string; attempt: number }
    | { type: "story_retry"; id: string; attempt: number }
    | { type: "progress"; completed: number; total: number; percentage: number }
    | { type: "finalize_start" }
    | { type: "finalize_complete"; pr_url: string | null }
    | { type: "done"; total_time_secs: number; success: boolean }
    | { type: "token_usage"; id: string; input_tokens: number; output_tokens: number }
    | { type: "session_exit" }

/** Top-level run lifecycle the UI renders. */
export type Phase = "idle" | "planning" | "executing" | "done"
/** Planner-call state during the planning phase (drives the activity indicator). */
export type PlanStatus = "planning" | "refining" | "idle"

export interface ChatMsg {
    role: "you" | "planner" | "error"
    text: string
}

export interface Tokens {
    input: number
    output: number
}

/** Captured when the run finishes, for the done summary. */
export interface DoneInfo {
    success: boolean
    totalSecs: number
    done: number
    total: number
    prUrl: string | null
}

/** The config the start form collects and hands to start_session. */
export interface RunConfig {
    goal: string
    cwd: string
    planner_model: string
    llm: string
    effort: string
    no_git: boolean
    tier_map: string | null
    openai_endpoints: string[]
}

export type StoryStatus = "queued" | "running" | "done" | "failed"

/** Tailwind-free tier colours for the read-only DAG badges. */
export function tierColor(tier: string): string {
    if (tier.includes("haiku")) return "#7dd3fc" // sky
    if (tier.includes("sonnet")) return "#c4b5fd" // violet
    if (tier.includes("opus")) return "#fca5a5" // red
    return "#94a3b8" // slate (custom backend:model / unknown)
}

export function statusColor(s: StoryStatus): string {
    switch (s) {
        case "running": return "#fbbf24"
        case "done": return "#34d399"
        case "failed": return "#f87171"
        default: return "#475569"
    }
}
