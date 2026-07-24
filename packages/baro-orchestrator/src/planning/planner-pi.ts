/**
 * PlannerPi — one-shot Planner call via the `pi` CLI.
 * The shared intake/prompt/extraction flow lives in one-shot-planning.ts.
 */

import { runPiOneShot } from "../harness/pi/one-shot.js"
import {
    runOneShotIntake,
    runOneShotPlanner,
    type OneShotPlannerCoreOptions,
    type OneShotPlanningRequest,
} from "../harness/one-shot/planning.js"
import type { ModeContract } from "./planner-prompts.js"

export interface RunPlannerPiOptions extends OneShotPlannerCoreOptions {
    /** Pi provider (e.g. "anthropic", "openai"). */
    provider?: string
    model?: string
    piBin?: string
}

function invokeWith(opts: RunPlannerPiOptions) {
    return (request: OneShotPlanningRequest) =>
        runPiOneShot({
            prompt: request.prompt,
            cwd: request.cwd,
            provider: opts.provider,
            model: opts.model,
            piBin: opts.piBin,
            timeoutMs: request.timeoutMs,
            label: request.label,
        })
}

export async function runPlannerPi(
    opts: RunPlannerPiOptions,
): Promise<string> {
    return runOneShotPlanner("PlannerPi", "pi", opts, invokeWith(opts))
}

export async function runPiIntake(
    opts: RunPlannerPiOptions,
): Promise<ModeContract> {
    return runOneShotIntake("pi", opts, invokeWith(opts))
}
