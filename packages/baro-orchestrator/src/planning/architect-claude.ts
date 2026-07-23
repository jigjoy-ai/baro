/**
 * ArchitectClaude — one-shot Architect call via `claude --print`.
 * Same prompt as ArchitectOpenAI so providers produce comparable
 * decision documents; Claude's built-in tools do the exploration.
 */

import { execFileCli } from "../exec-file-cli.js"

import { harnessChildEnvironment } from "../harness-environment.js"
import {
    isRunnerTimeoutError,
    normalizeClaudeRunnerObservation,
    unknownClaudeRunnerObservation,
} from "../participants/dialogue-responder.js"

import {
    ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import {
    ARCHITECT_DECISION_OUTCOME_JSON_SCHEMA,
    ARCHITECT_OUTCOME_JSON_SCHEMA,
    type ArchitectOutcomeContractMode,
} from "./architect-outcome.js"
import {
    isArchitectProcessLaunchFailure,
    observeArchitectInvocation,
    type ArchitectInvocationObserver,
} from "./architect-invocation.js"
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
    /** Strict outcome phase. Defaults to the complete ADR + obligations contract. */
    outcomeContractMode?: ArchitectOutcomeContractMode
    /** Repository inspection only: no Bash, edits, project customizations or MCP. */
    readOnly?: boolean
    /** Optional observational telemetry for this Claude Architect process. */
    onInvocation?: ArchitectInvocationObserver
}

export async function runArchitectClaude(
    opts: RunArchitectClaudeOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(
        opts.goal,
        opts.projectContext,
        opts.modeContract,
    )
    const outcomeContractMode = opts.outcomeContractMode ?? "complete"
    const systemPrompt = opts.outcomeMode
        ? outcomeContractMode === "decision"
            ? ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT
            : ARCHITECT_OUTCOME_SYSTEM_PROMPT
        : ARCHITECT_SYSTEM_PROMPT
    const outcomeSchema = outcomeContractMode === "decision"
        ? ARCHITECT_DECISION_OUTCOME_JSON_SCHEMA
        : ARCHITECT_OUTCOME_JSON_SCHEMA
    const requestedModel = opts.model ?? "opus"
    let stdout: string
    try {
        const result = await execFileCli(
            opts.claudeBin ?? "claude",
            [
                "--print",
                "--output-format",
                "json",
                "--model",
                requestedModel,
                ...(opts.effort ? ["--effort", opts.effort] : []),
                ...(opts.outcomeMode
                    ? ["--json-schema", JSON.stringify(outcomeSchema)]
                    : []),
                ...(opts.readOnly
                    ? [
                          "--tools",
                          "Read,Glob,Grep",
                          "--safe-mode",
                          "--disable-slash-commands",
                          "--strict-mcp-config",
                          "--mcp-config",
                          '{"mcpServers":{}}',
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
        stdout = result.stdout
    } catch (error) {
        if (!isArchitectProcessLaunchFailure(error)) {
            const timedOut = isRunnerTimeoutError(error)
            observeArchitectInvocation(
                opts.onInvocation,
                unknownClaudeRunnerObservation(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
                false,
            )
        }
        throw error
    }

    let wrapper: {
        result?: string
        structured_output?: unknown
        [key: string]: unknown
    }
    try {
        wrapper = JSON.parse(stdout) as typeof wrapper
    } catch (error) {
        observeArchitectInvocation(
            opts.onInvocation,
            unknownClaudeRunnerObservation("succeeded", "parse_error"),
            false,
        )
        throw error
    }
    const observation = wrapper !== null
        && typeof wrapper === "object"
        && !Array.isArray(wrapper)
        ? normalizeClaudeRunnerObservation(wrapper, requestedModel)
        : unknownClaudeRunnerObservation("succeeded", "parse_error")
    observeArchitectInvocation(opts.onInvocation, observation, false)
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
