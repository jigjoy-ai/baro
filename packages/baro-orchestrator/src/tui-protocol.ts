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

// ─── Outbound: orchestrator → TUI ───────────────────────────────────

export type BaroEvent =
    | { type: "init"; project: string; stories: StoryInfo[] }
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
    | {
          type: "token_usage"
          id: string
          input_tokens: number
          output_tokens: number
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
