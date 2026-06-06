/**
 * PlannerPi — one-shot Planner call via the `pi` CLI.
 *
 * Same prompt shape as PlannerClaude / PlannerCodex / PlannerOpenCode.
 * Returns the raw PRD JSON string for the Rust caller to deserialise.
 */

import { runPiOneShot } from "../pi-one-shot.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
} from "./planner-prompts.js"

/** Options for `runPlannerPi`. */
export interface RunPlannerPiOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory. */
    cwd: string
    /** Provider to use (e.g. "anthropic", "openai"). Default: undefined (use Pi default). */
    provider?: string
    /** Pi model identifier. */
    model?: string
    /** Optional project context blob. */
    projectContext?: string
    /** Optional decision document from the Architect phase. */
    decisionDocument?: string
    /** If true, use a shorter planning prompt. */
    quick?: boolean
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
    /**
     * Per-call timeout in milliseconds. Default: 900_000 (15 minutes).
     * Planner is the longest phase — large multi-story PRDs with strict
     * JSON output frequently push models past shorter timeouts.
     */
    timeoutMs?: number
}

/**
 * Run the Planner phase using Pi as the backend.
 *
 * @returns The PRD as a raw JSON string (a single `{ … }` object).
 * @throws Error if Pi returns empty or the result contains no valid JSON.
 */
export async function runPlannerPi(
    opts: RunPlannerPiOptions,
): Promise<string> {
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
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
