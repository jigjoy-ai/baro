/**
 * PlannerOpenCode — one-shot Planner call via `opencode run --format json`.
 *
 * Same prompt shape as PlannerClaude / PlannerCodex. Returns the raw
 * PRD JSON string for the Rust caller to deserialise.
 */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
} from "./planner-prompts.js"

/** Options for `runPlannerOpenCode`. */
export interface RunPlannerOpenCodeOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory. */
    cwd: string
    /** OpenCode model in `provider/model` format. */
    model?: string
    /** Optional project context blob. */
    projectContext?: string
    /** Optional decision document from the Architect phase. */
    decisionDocument?: string
    /** If true, use a shorter planning prompt. */
    quick?: boolean
    /** Path to the `opencode` binary. Default: "opencode". */
    opencodeBin?: string
    /**
     * Per-call timeout in milliseconds. Default: 900_000 (15 minutes).
     * Planner is the longest phase — large multi-story PRDs with strict
     * JSON output frequently push models past shorter timeouts.
     */
    timeoutMs?: number
}

/**
 * Run the Planner phase using OpenCode as the backend.
 *
 * @returns The PRD as a raw JSON string (a single `{ … }` object).
 * @throws Error if OpenCode returns empty or the result contains no valid JSON.
 */
export async function runPlannerOpenCode(
    opts: RunPlannerOpenCodeOptions,
): Promise<string> {
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
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
