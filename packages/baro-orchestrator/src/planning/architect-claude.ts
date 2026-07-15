/**
 * ArchitectClaude — one-shot Architect call via `claude --print`.
 * Same prompt as ArchitectOpenAI so providers produce comparable
 * decision documents; Claude's built-in tools do the exploration.
 */

import { execFileCli } from "../exec-file-cli.js"

import { harnessChildEnvironment } from "../harness-environment.js"

import {
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import { ARCHITECT_OUTCOME_JSON_SCHEMA } from "./architect-outcome.js"
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
    /** Emit the strict provider payload instead of legacy markdown. */
    outcomeMode?: boolean
    /** Repository inspection only: no Bash, edits, project customizations or MCP. */
    readOnly?: boolean
}

export async function runArchitectClaude(
    opts: RunArchitectClaudeOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(
        opts.goal,
        opts.projectContext,
        opts.modeContract,
    )
    const systemPrompt = opts.outcomeMode
        ? ARCHITECT_OUTCOME_SYSTEM_PROMPT
        : ARCHITECT_SYSTEM_PROMPT
    const { stdout } = await execFileCli(
        opts.claudeBin ?? "claude",
        [
            "--print",
            "--output-format",
            "json",
            "--model",
            opts.model ?? "opus",
            ...(opts.effort ? ["--effort", opts.effort] : []),
            ...(opts.outcomeMode
                ? ["--json-schema", JSON.stringify(ARCHITECT_OUTCOME_JSON_SCHEMA)]
                : []),
            ...(opts.readOnly
                ? [
                      "--tools",
                      "Read,Glob,Grep",
                      "--safe-mode",
                      "--disable-slash-commands",
                      "--strict-mcp-config",
                      "--mcp-config",
                      "{}",
                      "--no-session-persistence",
                      "--permission-mode",
                      "dontAsk",
                  ]
                : ["--permission-mode", "bypassPermissions"]),
            "--system-prompt",
            systemPrompt,
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

    const wrapper = JSON.parse(stdout) as {
        result?: string
        structured_output?: unknown
    }
    const doc = opts.outcomeMode && wrapper.structured_output !== undefined
        ? JSON.stringify(wrapper.structured_output)
        : typeof wrapper.result === "string"
          ? wrapper.result.trim()
          : ""
    if (!doc) {
        throw new Error("ArchitectClaude: claude returned empty result")
    }
    return doc
}
