/**
 * PlannerOpenCode — one-shot Planner call via `opencode run --format json`.
 *
 * Same prompt shape as PlannerClaude / PlannerCodex. Returns the raw
 * PRD JSON string for the Rust caller to deserialise.
 */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildIntakePrompt,
    buildPlannerUserMessage,
    heuristicModeContract,
    parseModeContract,
} from "./planner-prompts.js"

export interface RunPlannerOpenCodeOptions {
    goal: string
    cwd: string
    /** OpenCode model in `provider/model` format. */
    model?: string
    projectContext?: string
    decisionDocument?: string
    /** `--quick` hard override: exactly 1 story. */
    quick?: boolean
    opencodeBin?: string
    /** Default 15 min — large multi-story PRDs push models past
     *  shorter timeouts. */
    timeoutMs?: number
}

export async function runPlannerOpenCode(
    opts: RunPlannerOpenCodeOptions,
): Promise<string> {
    const modeContract = await runOpenCodeIntake(opts).catch((e) => {
        process.stderr.write(`[planner-opencode] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    process.stderr.write(`[planner-opencode] intake mode=${modeContract.mode} confidence=${modeContract.confidence}\n`)
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
        modeContract,
    })
    const prompt = `${PLANNER_SYSTEM_PROMPT}\n\n${userMessage}`

    const text = await runOpenCodeOneShot({
        prompt,
        cwd: opts.cwd,
        model: opts.model,
        opencodeBin: opts.opencodeBin,
        timeoutMs: opts.timeoutMs ?? 900_000,
        label: "opencode-planner",
    })

    const planText = text.trim()
    if (!planText) {
        throw new Error("PlannerOpenCode: opencode returned empty result")
    }
    // Model sometimes wraps JSON in markdown fences or adds prose despite
    // the "ONLY JSON" instruction — strip back to a bare `{ … }`.
    return extractJsonObject(planText)
}

async function runOpenCodeIntake(opts: RunPlannerOpenCodeOptions) {
    if (opts.quick) return heuristicModeContract(opts)
    const text = await runOpenCodeOneShot({
        prompt: `You classify software tasks for an autonomous PR workflow. Output JSON only.\n\n${buildIntakePrompt(opts)}`,
        cwd: opts.cwd,
        model: opts.model,
        opencodeBin: opts.opencodeBin,
        timeoutMs: Math.min(opts.timeoutMs ?? 900_000, 180_000),
        label: "opencode-intake",
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
            `PlannerOpenCode: no JSON object in response: ${trimmed.slice(0, 200)}`,
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
        `PlannerOpenCode: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
