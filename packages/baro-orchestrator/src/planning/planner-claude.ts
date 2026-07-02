/**
 * PlannerClaude — one-shot Planner call via `claude --print`.
 * Returns the raw PRD JSON string; the Rust caller deserialises it
 * (`PrdOutput`) so the schema has a single source of truth.
 */

import { execFile } from "child_process"
import { promisify } from "util"

import {
    PLANNER_SYSTEM_PROMPT,
    buildIntakePrompt,
    buildPlannerUserMessage,
    heuristicModeContract,
    parseModeContract,
    type ModeContract,
} from "./planner-prompts.js"

const execFileAsync = promisify(execFile)

export interface RunPlannerClaudeOptions {
    goal: string
    cwd: string
    model?: string
    effort?: string
    projectContext?: string
    decisionDocument?: string
    /** `--quick` hard override: exactly 1 story. */
    quick?: boolean
    /** Pre-decided contract (user pick or run-intake step); skips this planner's own intake. */
    modeContract?: ModeContract
    claudeBin?: string
    /** Defaults scale with `effort` ({@link effortTimeoutMs}) — the flat
     *  4-minute default was SIGTERM'ing `--effort max` runs mid-thought. */
    timeoutMs?: number
}

/** Higher effort = longer single `--print` turns, so the watchdog waits longer. */
export function effortTimeoutMs(effort?: string): number {
    switch (effort) {
        case "max":
            return 1_200_000 // 20 min
        case "xhigh":
            return 900_000 // 15 min
        case "high":
            return 480_000 // 8 min
        default:
            return 240_000 // 4 min (low | medium | unset)
    }
}

export async function runPlannerClaude(
    opts: RunPlannerClaudeOptions,
): Promise<string> {
    const modeContract = opts.modeContract ?? await runClaudeIntake(opts).catch((e) => {
        process.stderr.write(`[planner-claude] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    process.stderr.write(`[planner-claude] intake mode=${modeContract.mode} confidence=${modeContract.confidence}\n`)
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
        modeContract,
    })

    const { stdout } = await execFileAsync(
        opts.claudeBin ?? "claude",
        [
            "--print",
            "--output-format",
            "json",
            ...(opts.model ? ["--model", opts.model] : []),
            ...(opts.effort ? ["--effort", opts.effort] : []),
            "--permission-mode",
            "bypassPermissions",
            "--system-prompt",
            PLANNER_SYSTEM_PROMPT,
            "-p",
            userMessage,
        ],
        {
            cwd: opts.cwd,
            timeout: opts.timeoutMs ?? effortTimeoutMs(opts.effort),
            maxBuffer: 16 * 1024 * 1024,
        },
    )

    const wrapper = JSON.parse(stdout) as { result?: string }
    const planText = typeof wrapper.result === "string" ? wrapper.result.trim() : ""
    if (!planText) {
        throw new Error("PlannerClaude: claude returned empty result")
    }
    // The model occasionally wraps the JSON in a markdown fence or adds
    // prose despite the "ONLY JSON" instruction — strip back to a bare `{ … }`.
    return extractJsonObject(planText)
}

export async function runClaudeIntake(opts: RunPlannerClaudeOptions) {
    if (opts.quick) return heuristicModeContract(opts)
    const { stdout } = await execFileAsync(
        opts.claudeBin ?? "claude",
        [
            "--print",
            "--output-format",
            "json",
            ...(opts.model ? ["--model", opts.model] : []),
            ...(opts.effort ? ["--effort", opts.effort] : []),
            "--permission-mode",
            "bypassPermissions",
            "--system-prompt",
            "You classify software tasks for an autonomous PR workflow. Output JSON only.",
            "-p",
            buildIntakePrompt(opts),
        ],
        {
            cwd: opts.cwd,
            timeout: Math.min(opts.timeoutMs ?? effortTimeoutMs(opts.effort), 180_000),
            maxBuffer: 2 * 1024 * 1024,
        },
    )
    const wrapper = JSON.parse(stdout) as { result?: string }
    const text = typeof wrapper.result === "string" ? wrapper.result.trim() : ""
    if (!text) throw new Error("empty intake result")
    return parseModeContract(text)
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
            `PlannerClaude: no JSON object in response: ${trimmed.slice(0, 200)}`,
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
        `PlannerClaude: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
