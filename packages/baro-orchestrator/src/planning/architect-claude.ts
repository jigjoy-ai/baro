/**
 * ArchitectClaude — one-shot Architect call via `claude --print`.
 *
 * Replaces the Rust-side `run_claude_architect` from `crates/baro-tui/
 * src/main.rs`. The TUI now invokes a tsx subprocess
 * (`scripts/run-architect.ts`) which dispatches into this function or
 * `architect-openai.ts` based on `--llm`.
 *
 * Same prompt as ArchitectOpenAI so the two providers produce
 * comparable decision documents. Claude's own built-in tools (Read,
 * Grep, Glob, Bash, LSP) do the codebase exploration — we don't need
 * to ship our `codebase-tools.ts` to it.
 */

import { execFile } from "child_process"
import { promisify } from "util"

import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import { effortTimeoutMs } from "./planner-claude.js"

const execFileAsync = promisify(execFile)

export interface RunArchitectClaudeOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory the Architect explores in. */
    cwd: string
    /** Claude model. Default: "opus" (the heavy-reasoning architect tier). */
    model?: string
    /** Effort level passed as `claude --effort` (low|medium|high|xhigh|max). */
    effort?: string
    /** Optional CLAUDE.md / project-context blob to prepend. */
    projectContext?: string
    /** Path to the `claude` binary. Default: "claude" (resolved via PATH). */
    claudeBin?: string
    /**
     * Per-call timeout in milliseconds. Defaults scale with `effort`
     * (shared with the Planner via {@link effortTimeoutMs}) — at
     * `--effort max` a single exploratory architect turn routinely
     * exceeds the old flat 3-minute default and was being SIGTERM'd
     * mid-thought.
     */
    timeoutMs?: number
}

export async function runArchitectClaude(
    opts: RunArchitectClaudeOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext)
    const { stdout } = await execFileAsync(
        opts.claudeBin ?? "claude",
        [
            "--print",
            "--output-format",
            "json",
            "--model",
            opts.model ?? "opus",
            ...(opts.effort ? ["--effort", opts.effort] : []),
            "--permission-mode",
            "bypassPermissions",
            "--system-prompt",
            ARCHITECT_SYSTEM_PROMPT,
            "-p",
            userMessage,
        ],
        {
            cwd: opts.cwd,
            timeout: opts.timeoutMs ?? effortTimeoutMs(opts.effort),
            maxBuffer: 16 * 1024 * 1024,
        },
    )

    const wrapper = JSON.parse(stdout) as { result?: string }
    const doc = typeof wrapper.result === "string" ? wrapper.result.trim() : ""
    if (!doc) {
        throw new Error("ArchitectClaude: claude returned empty result")
    }
    return doc
}
