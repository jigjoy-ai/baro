/**
 * PlannerClaude — one-shot Planner call via `claude --print`.
 *
 * Replaces the Rust-side `run_claude_planner` from `crates/baro-tui/
 * src/main.rs`. The TUI now invokes a tsx subprocess
 * (`scripts/run-planner.ts`) which dispatches into this function or
 * `planner-openai.ts` based on `--llm`.
 *
 * Output contract: a JSON string matching the shape Rust's
 * `PrdOutput` deserialises. We do NOT parse it on this side — the
 * Rust caller already knows how to consume the wire format, and
 * keeping the parsing in one place avoids a second source of truth
 * for the PRD schema.
 */

import { execFile } from "child_process"
import { promisify } from "util"

import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
} from "./planner-prompts.js"

const execFileAsync = promisify(execFile)

export interface RunPlannerClaudeOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory the Planner explores in. */
    cwd: string
    /** Claude model. Default: routed (let Claude decide). */
    model?: string
    /** Optional CLAUDE.md / project-context blob to prepend. */
    projectContext?: string
    /** Architect's DecisionDocument, if available, prepended as authoritative spec. */
    decisionDocument?: string
    /** Whether the user invoked `--quick` (hard override = 1 story). */
    quick?: boolean
    /** Path to the `claude` binary. Default: "claude" (resolved via PATH). */
    claudeBin?: string
    /** Per-call timeout in milliseconds. Default: 240_000 (4 minutes). */
    timeoutMs?: number
}

/**
 * Returns the raw PRD JSON string (the body of Claude's `result`
 * field). The Rust caller parses it via serde_json; we don't reparse
 * on this side to keep the schema in one place.
 */
export async function runPlannerClaude(
    opts: RunPlannerClaudeOptions,
): Promise<string> {
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
    })

    const { stdout } = await execFileAsync(
        opts.claudeBin ?? "claude",
        [
            "--print",
            "--output-format",
            "json",
            ...(opts.model ? ["--model", opts.model] : []),
            "--permission-mode",
            "bypassPermissions",
            "--system-prompt",
            PLANNER_SYSTEM_PROMPT,
            "-p",
            userMessage,
        ],
        {
            cwd: opts.cwd,
            timeout: opts.timeoutMs ?? 240_000,
            maxBuffer: 16 * 1024 * 1024,
        },
    )

    const wrapper = JSON.parse(stdout) as { result?: string }
    const planText = typeof wrapper.result === "string" ? wrapper.result.trim() : ""
    if (!planText) {
        throw new Error("PlannerClaude: claude returned empty result")
    }
    // The model occasionally wraps the JSON in a markdown fence or
    // adds leading prose despite the "ONLY JSON" instruction. Strip
    // both back to a bare `{ … }` so the Rust serde_json pass that
    // follows doesn't choke on fence delimiters.
    return extractJsonObject(planText)
}

/**
 * Pull the first balanced `{ … }` block out of a raw string. Tolerates
 * markdown fences, leading prose, and trailing trailing punctuation.
 */
function extractJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fence) return fence[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(
            `PlannerClaude: no JSON object in response: ${trimmed.slice(0, 200)}`,
        )
    }
    let depth = 0
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (ch === "{") depth++
        else if (ch === "}") {
            depth--
            if (depth === 0) return trimmed.slice(start, i + 1)
        }
    }
    throw new Error(
        `PlannerClaude: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
