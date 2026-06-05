/**
 * PlannerCopilot — one-shot Planner call via
 * `copilot -p <PROMPT> --output-format json`.
 *
 * Same prompt shape as PlannerClaude / PlannerOpenAI / PlannerCodex. Returns
 * the raw PRD JSON string for the Rust caller to deserialise.
 */

import { runCopilotOneShot } from "../copilot-one-shot.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
} from "./planner-prompts.js"

export interface RunPlannerCopilotOptions {
    goal: string
    cwd: string
    model?: string
    projectContext?: string
    decisionDocument?: string
    quick?: boolean
    copilotBin?: string
    /** Per-call timeout in milliseconds. Default: 900_000 (15 minutes).
     *  Planner is the longest phase — large multi-story PRDs with
     *  strict JSON output frequently push the model past shorter
     *  ceilings, so match the Codex planner's 15-minute cap. */
    timeoutMs?: number
}

export async function runPlannerCopilot(
    opts: RunPlannerCopilotOptions,
): Promise<string> {
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
    })
    const prompt = `${PLANNER_SYSTEM_PROMPT}\n\n${userMessage}`

    const text = await runCopilotOneShot({
        prompt,
        cwd: opts.cwd,
        model: opts.model,
        copilotBin: opts.copilotBin,
        timeoutMs: opts.timeoutMs ?? 900_000,
        label: "copilot-planner",
    })

    const planText = text.trim()
    if (!planText) {
        throw new Error("PlannerCopilot: copilot returned empty result")
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
            `PlannerCopilot: no JSON object in response: ${trimmed.slice(0, 200)}`,
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
        `PlannerCopilot: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
