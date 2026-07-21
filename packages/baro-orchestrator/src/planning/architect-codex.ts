/**
 * ArchitectCodex — one-shot Architect call via `codex exec --json`.
 * Same prompt shape as ArchitectClaude / ArchitectOpenAI so providers
 * produce comparable decision documents; Codex's built-in tools explore.
 * In pre-acceptance mode repository files are evidence, not instructions:
 * Codex keeps the repository cwd for read-only exploration but automatic
 * AGENTS.md/project-document injection is disabled at the CLI boundary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCodexOneShot } from "../codex-one-shot.js"
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
    bufferedArchitectRunnerObserver,
    isArchitectProcessLaunchFailure,
    type ArchitectInvocationObserver,
} from "./architect-invocation.js"
import type { ModeContract } from "./planner-prompts.js"

export interface RunArchitectCodexOptions {
    goal: string
    cwd: string
    model?: string
    /** Explicit reasoning effort because outcome mode ignores user config. */
    effort?: "low" | "medium" | "high" | "xhigh" | "max"
    projectContext?: string
    modeContract?: ModeContract
    codexBin?: string
    /** Default 10 min — codex with reasoning + tool exploration blew
     *  past the old 3-minute timeout mid-exploration. */
    timeoutMs?: number
    outcomeMode?: boolean
    /** Strict outcome phase. Defaults to the complete ADR + obligations contract. */
    outcomeContractMode?: ArchitectOutcomeContractMode
    readOnly?: boolean
    /** Optional observational telemetry for this one-shot Architect process. */
    onInvocation?: ArchitectInvocationObserver
}

export async function runArchitectCodex(
    opts: RunArchitectCodexOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext, opts.modeContract)
    const outcomeContractMode = opts.outcomeContractMode ?? "complete"
    const outcomePrompt = outcomeContractMode === "decision"
        ? ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT
        : ARCHITECT_OUTCOME_SYSTEM_PROMPT
    const prompt = `${opts.outcomeMode ? outcomePrompt : ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`
    const outcomeSchema = outcomeContractMode === "decision"
        ? ARCHITECT_DECISION_OUTCOME_JSON_SCHEMA
        : ARCHITECT_OUTCOME_JSON_SCHEMA

    const schemaDirectory = opts.outcomeMode
        ? mkdtempSync(join(tmpdir(), "baro-architect-schema-"))
        : undefined
    const schemaFile = schemaDirectory
        ? join(schemaDirectory, "architect-outcome-v1.json")
        : undefined
    if (schemaFile) {
        writeFileSync(schemaFile, JSON.stringify(outcomeSchema), {
            encoding: "utf8",
            mode: 0o600,
        })
    }
    const invocationTelemetry = bufferedArchitectRunnerObserver(opts.onInvocation)

    let text: string
    try {
        text = await runCodexOneShot({
            prompt,
            cwd: opts.cwd,
            model: opts.model,
            reasoningEffort: opts.effort,
            codexBin: opts.codexBin,
            timeoutMs: opts.timeoutMs ?? 600_000,
            label: "codex-architect",
            ...(invocationTelemetry.onInvocation
                ? { onInvocation: invocationTelemetry.onInvocation }
                : {}),
            ...(opts.readOnly
                ? {
                      bypassSandbox: false,
                      sandboxMode: "read-only" as const,
                      ephemeral: true,
                      ignoreUserConfig: true,
                      ignoreRules: true,
                      disableProjectDocs: true,
                  }
                : {}),
            ...(schemaFile ? { outputSchemaFile: schemaFile } : {}),
        })
        invocationTelemetry.flush()
    } catch (error) {
        if (isArchitectProcessLaunchFailure(error)) {
            invocationTelemetry.discard()
        } else {
            invocationTelemetry.flush()
        }
        throw error
    } finally {
        if (schemaDirectory) {
            rmSync(schemaDirectory, { recursive: true, force: true })
        }
    }

    const doc = text.trim()
    if (!doc) {
        throw new Error("ArchitectCodex: codex returned empty result")
    }
    return doc
}
