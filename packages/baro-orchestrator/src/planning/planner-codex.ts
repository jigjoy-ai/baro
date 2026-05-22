/**
 * PlannerCodex — one-shot Planner call via `codex exec --json`.
 *
 * Same prompt shape as PlannerClaude / PlannerOpenAI. Returns the raw
 * PRD JSON string for the Rust caller to deserialise.
 */

import { runCodexOneShot } from "../codex-one-shot.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
} from "./planner-prompts.js"

export interface RunPlannerCodexOptions {
    goal: string
    cwd: string
    model?: string
    projectContext?: string
    decisionDocument?: string
    quick?: boolean
    codexBin?: string
    /** Per-call timeout in milliseconds. Default: 240_000 (4 minutes). */
    timeoutMs?: number
}

export async function runPlannerCodex(
    opts: RunPlannerCodexOptions,
): Promise<string> {
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
    })
    const prompt = `${PLANNER_SYSTEM_PROMPT}\n\n${userMessage}`

    const text = await runCodexOneShot({
        prompt,
        cwd: opts.cwd,
        model: opts.model,
        codexBin: opts.codexBin,
        timeoutMs: opts.timeoutMs ?? 240_000,
    })

    const planText = text.trim()
    if (!planText) {
        throw new Error("PlannerCodex: codex returned empty result")
    }
    // Model sometimes wraps JSON in markdown fences or adds prose despite
    // the "ONLY JSON" instruction — strip back to a bare `{ … }`.
    return extractJsonObject(planText)
}

/**
 * Pull the first balanced `{ … }` block out of a raw string. Tolerates
 * markdown fences and leading prose.
 */
function extractJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fence) return fence[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(
            `PlannerCodex: no JSON object in response: ${trimmed.slice(0, 200)}`,
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
        `PlannerCodex: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
