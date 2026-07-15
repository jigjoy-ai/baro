/**
 * Line-delimited JSON protocol between the orchestrator and UI consumers:
 * BaroEvents out on stdout, BaroCommands in on stdin, one object per line.
 * Both sides ignore unknown fields and unknown `type` values (forward compat).
 *
 * CONSTRAINT: shapes and snake_case field names must mirror the Rust
 * `BaroEvent` serde enum in crates/baro-tui/src/events.rs — JSON keys cross
 * the language boundary verbatim.
 */

import { stdin } from "process"
import { createInterface } from "readline"

import type { ModelInvocationMeasuredData } from "./model-telemetry.js"

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

export interface VerificationEvidenceInfo {
    verification_id: string
    status: "passed" | "failed" | "skipped"
    duration_ms: number
    commands: Array<{
        command: string
        status: "passed" | "failed" | "skipped"
        duration_ms: number
        tail?: string
    }>
}

export type BaroEvent =
    | { type: "init"; project: string; stories: StoryInfo[]; runner?: string; mode?: string; mode_reason?: string }
    // The Architect's design/decision spec (markdown), emitted once after
    // planning so the dashboard can surface it.
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
          verification_status?: "passed" | "failed" | "skipped"
          verification?: VerificationEvidenceInfo
      }
    | { type: "notification_ready" }
    // Per-story changes merged into the run branch, for the Changes view.
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
          // Absent for subscription paths (codex/openai) that have no
          // per-call dollar cost. Summed downstream.
          cost_usd?: number
      }
    | {
          type: "model_usage"
          measurement: ModelInvocationMeasuredData
      }
    // Live cumulative-per-agent token estimate streamed WHILE a story runs;
    // token_usage remains the authoritative total on finish. Consumers must
    // treat it as the latest snapshot, not a delta to sum.
    | {
          type: "token_progress"
          id: string
          input_tokens: number
          output_tokens: number
      }
    // One condensed, typed line per bus item for the structured Activity
    // feed (vs the raw story_log firehose).
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
    // Protocol v2 structured events (docs/tui-protocol-v2.md). Each keeps
    // its legacy story_log mirror for one release.
    | {
          type: "replan"
          source: string
          reason: string
          added: StoryInfo[]
          removed: string[]
          rewired: { id: string; depends_on: string[] }[]
      }
    | { type: "intervention"; id: string; source: string; action: string; reason: string }
    | { type: "story_merged"; id: string; mode: "worktree" | "shared-tree" }
    | { type: "merge_failed"; id: string; error: string }
    | { type: "level_started"; ordinal: number; story_ids: string[] }
    | { type: "level_completed"; ordinal: number; passed: string[]; failed: string[] }
    | { type: "recovery_started"; attempt: number; story_ids: string[] }
    | { type: "routed"; id: string; backend: string; model: string }
    | {
          type: "critique"
          id: string
          verdict: "pass" | "fail"
          reasoning: string
          violated: string[]
      }
    | {
          type: "conversation_request"
          message_id: string
          text: string
      }
    | {
          type: "conversation_response"
          message_id: string
          text: string
          actions: Array<{ recipient_id: string; text: string }>
      }
    | {
          type: "conversation_failed"
          message_id: string
          error: string
      }

/** Caller must not include trailing newlines in any field. */
export function emit(event: BaroEvent): void {
    const line = JSON.stringify(event) + "\n"
    process.stdout.write(line)
}

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
    /** Mid-run user chat with a running agent (TUI `m` key). */
    | { type: "agent_message"; id: string; text: string }
    /** Mid-run chat with the optional, non-authoritative DialogueAgent. */
    | { type: "dialogue_message"; message_id?: string; text: string }
    /** Open one correlated progressive-planning stream. */
    | { type: "planning_open"; run_id: string; planning_id: string }
    /** Admit one ordered batch of provisional stories for consideration. */
    | {
          type: "plan_fragment"
          run_id: string
          planning_id: string
          fragment_id: string
          ordinal: number
          stories: unknown[]
      }
    /** Close the correlated stream with the Planner's authoritative result. */
    | {
          type: "plan_complete"
          run_id: string
          planning_id: string
          final_prd: unknown
      }
    /** Close the correlated stream without an authoritative final plan. */
    | {
          type: "plan_failed"
          run_id: string
          planning_id: string
          code: string
          reason: string
      }
    | { type: "shutdown" }

export type CommandHandler = (cmd: BaroCommand) => Promise<void> | void

/**
 * Subscribe to commands on stdin; returns an unsubscribe. Non-JSON lines
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
            // stderr — stdout is reserved for the event stream.
            process.stderr.write(
                `[tui-protocol] command handler error: ${(err as Error)?.message ?? String(err)}\n`,
            )
        })
    })
    return () => rl.close()
}
