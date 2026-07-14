/**
 * ArchitectClaude — one-shot Architect call via `claude --print`.
 * Same prompt as ArchitectOpenAI so providers produce comparable
 * decision documents; Claude's built-in tools do the exploration.
 */

import { execFileCli } from "../exec-file-cli.js"

import { harnessChildEnvironment } from "../harness-environment.js"

import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import { effortTimeoutMs } from "./planner-claude.js"
import type { ModeContract } from "./planner-prompts.js"

export interface RunArchitectClaudeOptions {
    goal: string
    cwd: string
    model?: string
    effort?: string
    projectContext?: string
    modeContract?: ModeContract
    claudeBin?: string
    /** Defaults scale with `effort` ({@link effortTimeoutMs}) — a flat
     *  3-minute timeout SIGTERM'd `--effort max` turns mid-thought. */
    timeoutMs?: number
}

export async function runArchitectClaude(
    opts: RunArchitectClaudeOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(
        opts.goal,
        opts.projectContext,
        opts.modeContract,
    )
    const { stdout } = await execFileCli(
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
            env: harnessChildEnvironment(),
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
