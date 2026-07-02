/**
 * PlannerPi — one-shot Planner call via the `pi` CLI.
 *
 * Same prompt shape as PlannerClaude / PlannerCodex / PlannerOpenCode.
 * Returns the raw PRD JSON string for the Rust caller to deserialise.
 */

import { runPiOneShot } from "../pi-one-shot.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildIntakePrompt,
    buildPlannerUserMessage,
    heuristicModeContract,
    parseModeContract,
    type ModeContract,
} from "./planner-prompts.js"

export interface RunPlannerPiOptions {
    goal: string
    cwd: string
    /** Pi provider (e.g. "anthropic", "openai"). */
    provider?: string
    model?: string
    projectContext?: string
    decisionDocument?: string
    /** `--quick` hard override: exactly 1 story. */
    quick?: boolean
    /** Pre-decided contract (user pick or run-intake step); skips this planner's own intake. */
    modeContract?: ModeContract
    piBin?: string
    /** Default 15 min — large multi-story PRDs push models past
     *  shorter timeouts. */
    timeoutMs?: number
}

export async function runPlannerPi(
    opts: RunPlannerPiOptions,
): Promise<string> {
    const modeContract = opts.modeContract ?? await runPiIntake(opts).catch((e) => {
        process.stderr.write(`[planner-pi] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    process.stderr.write(`[planner-pi] intake mode=${modeContract.mode} confidence=${modeContract.confidence}\n`)
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
        modeContract,
    })
    const prompt = `${PLANNER_SYSTEM_PROMPT}\n\n${userMessage}`

    const text = await runPiOneShot({
        prompt,
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
        piBin: opts.piBin,
        timeoutMs: opts.timeoutMs ?? 900_000,
        label: "pi-planner",
    })

    const planText = text.trim()
    if (!planText) {
        throw new Error("PlannerPi: pi returned empty result")
    }
    // Model sometimes wraps JSON in markdown fences or adds prose despite
    // the "ONLY JSON" instruction — strip back to a bare `{ … }`.
    return extractJsonObject(planText)
}

export async function runPiIntake(opts: RunPlannerPiOptions) {
    if (opts.quick) return heuristicModeContract(opts)
    const text = await runPiOneShot({
        prompt: `You classify software tasks for an autonomous PR workflow. Output JSON only.\n\n${buildIntakePrompt(opts)}`,
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
        piBin: opts.piBin,
        timeoutMs: Math.min(opts.timeoutMs ?? 900_000, 180_000),
        label: "pi-intake",
    })
    return parseModeContract(text.trim())
}

/** First balanced `{ … }` block; tolerates markdown fences and leading prose. */
function extractJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fence) return fence[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(
            `PlannerPi: no JSON object in response: ${trimmed.slice(0, 200)}`,
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
        `PlannerPi: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
