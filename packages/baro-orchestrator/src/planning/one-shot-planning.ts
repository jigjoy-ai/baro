/**
 * Shared flow for one-shot CLI Planner/Architect calls (OpenCode, Pi):
 * intake with heuristic fallback, prompt assembly, the isolated-cwd outcome
 * policy, telemetry buffering, and tolerant JSON extraction. A backend
 * supplies only its subprocess invocation.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { extractModelJsonObject } from "../model-json.js"
import type { RunnerInvocationObserver } from "../runner-invocation.js"
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
import {
    PLANNER_SYSTEM_PROMPT,
    buildIntakePrompt,
    buildPlannerUserMessage,
    heuristicModeContract,
    parseModeContract,
    type ModeContract,
} from "./planner-prompts.js"

export interface OneShotPlanningRequest {
    prompt: string
    cwd: string
    timeoutMs: number
    label: string
    /** Present only for the strict read-only Architect outcome phase. */
    safeEvaluatorSystemPrompt?: string
    onInvocation?: RunnerInvocationObserver
}

export type OneShotPlanningInvoke = (
    request: OneShotPlanningRequest,
) => Promise<string>

export interface OneShotPlannerCoreOptions {
    goal: string
    cwd: string
    projectContext?: string
    decisionDocument?: string
    /** `--quick` hard override: exactly 1 story. */
    quick?: boolean
    /** Pre-decided contract (user pick or run-intake step); skips this planner's own intake. */
    modeContract?: ModeContract
    /** Default 15 min — large multi-story PRDs push models past shorter timeouts. */
    timeoutMs?: number
}

export async function runOneShotPlanner(
    displayName: string,
    /** Lowercase harness tag used in labels/log prefixes, e.g. "opencode". */
    harness: string,
    opts: OneShotPlannerCoreOptions,
    invoke: OneShotPlanningInvoke,
): Promise<string> {
    const modeContract =
        opts.modeContract ??
        (await runOneShotIntake(harness, opts, invoke).catch((e) => {
            process.stderr.write(
                `[planner-${harness}] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`,
            )
            return heuristicModeContract(opts)
        }))
    process.stderr.write(
        `[planner-${harness}] intake mode=${modeContract.mode} confidence=${modeContract.confidence}\n`,
    )
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
        modeContract,
    })

    const text = await invoke({
        prompt: `${PLANNER_SYSTEM_PROMPT}\n\n${userMessage}`,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? 900_000,
        label: `${harness}-planner`,
    })

    const planText = text.trim()
    if (!planText) {
        throw new Error(`${displayName}: ${harness} returned empty result`)
    }
    // Model sometimes wraps JSON in markdown fences or adds prose despite
    // the "ONLY JSON" instruction — strip back to a bare `{ … }`.
    const extracted = extractModelJsonObject(planText)
    if (!extracted.startsWith("{")) {
        throw new Error(
            `${displayName}: no JSON object in response: ${planText.slice(0, 200)}`,
        )
    }
    return extracted
}

export async function runOneShotIntake(
    harness: string,
    opts: OneShotPlannerCoreOptions,
    invoke: OneShotPlanningInvoke,
): Promise<ModeContract> {
    if (opts.quick) return heuristicModeContract(opts)
    const text = await invoke({
        prompt: `You classify software tasks for an autonomous PR workflow. Output JSON only.\n\n${buildIntakePrompt(opts)}`,
        cwd: opts.cwd,
        timeoutMs: Math.min(opts.timeoutMs ?? 900_000, 180_000),
        label: `${harness}-intake`,
    })
    return parseModeContract(text.trim())
}

export interface OneShotArchitectCoreOptions {
    goal: string
    cwd: string
    projectContext?: string
    modeContract?: ModeContract
    /** Default 10 min — tool-call exploration blew past shorter timeouts. */
    timeoutMs?: number
    outcomeMode?: boolean
    /** Strict outcome phase. Defaults to the complete ADR + obligations contract. */
    outcomeContractMode?: ArchitectOutcomeContractMode
    /** Optional observational telemetry for this one-shot Architect process. */
    onInvocation?: ArchitectInvocationObserver
}

export async function runOneShotArchitect(
    displayName: string,
    harness: string,
    opts: OneShotArchitectCoreOptions,
    invoke: OneShotPlanningInvoke,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(
        opts.goal,
        opts.projectContext,
        opts.modeContract,
    )
    const outcomePrompt = (opts.outcomeContractMode ?? "complete") === "decision"
        ? ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT
        : ARCHITECT_OUTCOME_SYSTEM_PROMPT
    const prompt = opts.outcomeMode
        ? userMessage
        : `${ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`
    // These harnesses have no repository read-only sandbox. Outcome mode
    // therefore runs its existing deny-all evaluator in an empty disposable
    // directory and relies only on Baro's brokered deterministic context.
    const isolatedCwd = opts.outcomeMode
        ? mkdtempSync(join(tmpdir(), `baro-architect-${harness}-`))
        : undefined
    const invocationTelemetry = bufferedArchitectRunnerObserver(opts.onInvocation)

    let text: string
    try {
        text = await invoke({
            prompt,
            cwd: isolatedCwd ?? opts.cwd,
            timeoutMs: opts.timeoutMs ?? 600_000,
            label: `${harness}-architect`,
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
        throw new Error(`${displayName}: ${harness} returned empty result`)
    }
    return doc
}
