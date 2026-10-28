/**
 * PlannerDevin — one-shot Planner call via `devin acp`.
 * The shared intake/prompt/extraction flow lives in one-shot-planning.ts.
 */

import { runDevinOneShot } from "../../harness/devin/one-shot.js"
import {
    runOneShotIntake,
    runOneShotPlanner,
    type OneShotPlannerCoreOptions,
    type OneShotPlanningRequest,
} from "../../harness/one-shot/planning.js"
import type { ModeContract } from "../domain/planner-prompts.js"

export interface RunPlannerDevinOptions extends OneShotPlannerCoreOptions {
    model?: string
    devinBin?: string
}

function invokeWith(opts: RunPlannerDevinOptions) {
    return (request: OneShotPlanningRequest) =>
        runDevinOneShot({
            prompt: request.prompt,
            cwd: request.cwd,
            model: opts.model,
            devinBin: opts.devinBin,
            timeoutMs: request.timeoutMs,
            label: request.label,
        })
}

export async function runPlannerDevin(
    opts: RunPlannerDevinOptions,
): Promise<string> {
    return runOneShotPlanner("PlannerDevin", "devin", opts, invokeWith(opts))
}

export async function runDevinIntake(
    opts: RunPlannerDevinOptions,
): Promise<ModeContract> {
    return runOneShotIntake("devin", opts, invokeWith(opts))
}
