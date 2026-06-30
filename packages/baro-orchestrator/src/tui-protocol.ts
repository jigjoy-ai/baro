/**
 * JSON-RPC-ish line-delimited protocol between the orchestrator (this
 * package) and any UI consumer (Rust TUI today, web UI later).
 *
 * Semantics:
 *   - Orchestrator emits `BaroEvent`s on stdout, one JSON object per line.
 *   - UI emits `BaroCommand`s on stdin, one JSON object per line.
 *   - Both sides ignore unknown fields and unknown `type` values
 *     (forward-compat with future versions).
 *
 * The event shapes mirror the Rust `BaroEvent` enum in
 * crates/baro-tui/src/events.rs so the existing TUI parser keeps working.
 * Phase 1 emits the subset needed for current TUI screens; later phases
 * add more granular events (agent_state, conductor_state, etc).
 */

import { stdin } from "process"
import { createInterface } from "readline"

// ─── Shared shapes ──────────────────────────────────────────────────

// Field names use snake_case to match the Rust BaroEvent serde shape
// (crates/baro-tui/src/events.rs) — JSON keys cross the language boundary
// verbatim. Internal TS code that builds these objects translates from
// camelCase as needed.

export interface StoryInfo {
    id: string
    title: string
    depends_on?: string[]
}

export interface DagNodeInfo {
    id: string
}

export interface DoneStats {
    stories_completed: number
    stories_skipped: number
    total_commits: number
    files_created: number
    files_modified: number
}

export interface DiffFileInfo {
    path: string
    added: number
    removed: number
}

// ─── Outbound: orchestrator → TUI ───────────────────────────────────

export type BaroEvent =
    | { type: "init"; project: string; stories: StoryInfo[]; runner?: string }
    // The Architect's design/decision spec (markdown) — the authoritative set of
    // file paths, schema/API shapes, naming + dependency choices every story works
    // from. Emitted once after planning so the dashboard can surface it (it was
    // previously only ever written to prd.json on disk).
    | { type: "decision_document"; document: string }
    | { type: "dag"; levels: DagNodeInfo[][] }
    | { type: "story_start"; id: string; title: string }
    | { type: "story_log"; id: string; line: string }
    | {
          type: "story_complete"
          id: string
          duration_secs: number
          files_created: number
          files_modified: number
      }
    | {
          type: "story_error"
          id: string
          error: string
          attempt: number
          max_retries: number
      }
    | { type: "story_retry"; id: string; attempt: number }
    | { type: "progress"; completed: number; total: number; percentage: number }
    | { type: "push_status"; id: string; success: boolean; error: string | null }
    | { type: "finalize_start" }
    | { type: "finalize_complete"; pr_url: string | null }
    | {
          type: "done"
          total_time_secs: number
          stats: DoneStats
          success?: boolean
          abort_reason?: string
      }
    | { type: "notification_ready" }
    // Per-story changes merged into the run branch: file list with add/remove
    // counts + a capped unified diff, so the TUI can show a Changes/diff view.
    | {
          type: "story_diff"
          id: string
          files: DiffFileInfo[]
          diff?: string
      }
    | {
          type: "token_usage"
          id: string
          input_tokens: number
          output_tokens: number
          // Per-story cost in USD when the backend reports it (Claude CLI's
          // total_cost_usd). Absent for subscription paths (codex/openai) that
          // have no per-call dollar cost. Summed downstream.
          cost_usd?: number
      }
    // Live, cumulative-per-agent token estimate streamed WHILE a story runs (so the UI
    // can show tokens climbing in real time). Distinct from token_usage, which is the
    // authoritative total emitted once the agent finishes. Throttled by the forwarder;
    // consumers should treat it as the latest snapshot, not a delta to sum.
    | {
          type: "token_progress"
          id: string
          input_tokens: number
          output_tokens: number
      }
    // One condensed, typed line for the structured Activity feed. Replaces the
    // raw `story_log` firehose (full tool args / file reads / model output split
    // line-by-line) with a single meaningful entry per bus item, so the TUI can
    // render a readable, color-coded feed instead of a wall of streamed text.
    | {
          type: "activity"
          id: string
          // tool_call | tool_result | agent_msg | file_change | test | conflict | verdict | error | warn
          kind: string
          text: string
          tool?: string // tool_call: read | write | bash | other
          path?: string // file_change
          op?: string // file_change: create | modify
          ok?: boolean // test / verdict pass-fail
      }

/**
 * Write a single event as a JSON line to stdout. Caller should not
 * include trailing newlines in any field.
 */
export function emit(event: BaroEvent): void {
    const line = JSON.stringify(event) + "\n"
    process.stdout.write(line)
}

// ─── Inbound: TUI → orchestrator ────────────────────────────────────

export type BaroCommand =
    | {
          type: "start"
          prd_path: string
          cwd: string
          parallel?: number
          timeout_secs?: number
          override_model?: string | null
          default_model?: string
      }
    | { type: "abort"; story_id: string }
    | { type: "abort_all" }
    | { type: "redirect"; story_id: string; message: string }
    | { type: "shutdown" }

export type CommandHandler = (cmd: BaroCommand) => Promise<void> | void

/**
 * Subscribe to commands arriving on stdin. Returns a function that
 * shuts the listener down. Each line is parsed as JSON; non-JSON lines
 * are silently ignored to keep the protocol forward-compatible.
 */
export function subscribeCommands(handler: CommandHandler): () => void {
    const rl = createInterface({ input: stdin })
    rl.on("line", (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let cmd: BaroCommand
        try {
            cmd = JSON.parse(trimmed) as BaroCommand
        } catch {
            return
        }
        if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string") {
            return
        }
        Promise.resolve(handler(cmd)).catch((err: unknown) => {
            // Surface handler failures via stderr — stdout is reserved
            // for the event stream.
            process.stderr.write(
                `[tui-protocol] command handler error: ${(err as Error)?.message ?? String(err)}\n`,
            )
        })
    })
    return () => rl.close()
}
