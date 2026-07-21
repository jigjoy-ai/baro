/**
 * ArchitectPi — one-shot Architect call via the `pi` CLI.
 * Same prompt shape as the other architect backends so providers produce
 * comparable decision documents; Pi's built-in tools explore.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runPiOneShot } from "../pi-one-shot.js"
import {
    ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import {
    bufferedArchitectRunnerObserver,
    isArchitectProcessLaunchFailure,
    type ArchitectInvocationObserver,
} from "./architect-invocation.js"
import type { ArchitectOutcomeContractMode } from "./architect-outcome.js"
import type { ModeContract } from "./planner-prompts.js"

export interface RunArchitectPiOptions {
    goal: string
    cwd: string
    /** Pi provider (e.g. "anthropic", "openai"). */
    provider?: string
    model?: string
    projectContext?: string
    modeContract?: ModeContract
    piBin?: string
    /** Default 10 min — tool-call exploration blew past the old
     *  3-minute timeout mid-exploration. */
    timeoutMs?: number
    outcomeMode?: boolean
    /** Strict outcome phase. Defaults to the complete ADR + obligations contract. */
    outcomeContractMode?: ArchitectOutcomeContractMode
    /** Optional observational telemetry for this one-shot Architect process. */
    onInvocation?: ArchitectInvocationObserver
}

export async function runArchitectPi(
    opts: RunArchitectPiOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext, opts.modeContract)
    const outcomePrompt = (opts.outcomeContractMode ?? "complete") === "decision"
        ? ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT
        : ARCHITECT_OUTCOME_SYSTEM_PROMPT
    const prompt = opts.outcomeMode
        ? userMessage
        : `${ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`
    // Pi exposes only an all-tools/no-tools switch. Pre-acceptance validation
    // uses its deny-all evaluator in an empty disposable directory and relies
    // on Baro's brokered context. Legacy Architect calls keep their tools.
    const isolatedCwd = opts.outcomeMode
        ? mkdtempSync(join(tmpdir(), "baro-architect-pi-"))
        : undefined
    const invocationTelemetry = bufferedArchitectRunnerObserver(opts.onInvocation)

    let text: string
    try {
        text = await runPiOneShot({
            prompt,
            cwd: isolatedCwd ?? opts.cwd,
            provider: opts.provider,
            model: opts.model,
            piBin: opts.piBin,
            timeoutMs: opts.timeoutMs ?? 600_000,
            label: "pi-architect",
            ...(invocationTelemetry.onInvocation
                ? { onInvocation: invocationTelemetry.onInvocation }
                : {}),
            ...(opts.outcomeMode
                ? { safeEvaluatorSystemPrompt: outcomePrompt }
                : {}),
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
        if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true })
    }

    const doc = text.trim()
    if (!doc) {
        throw new Error("ArchitectPi: pi returned empty result")
    }
    return doc
}
