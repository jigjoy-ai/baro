/**
 * PlannerOpenCode — one-shot Planner call via `opencode run --format json`.
 * The shared intake/prompt/extraction flow lives in one-shot-planning.ts.
 */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    runOneShotIntake,
    runOneShotPlanner,
    type OneShotPlannerCoreOptions,
    type OneShotPlanningRequest,
} from "./one-shot-planning.js"
import type { ModeContract } from "./planner-prompts.js"

export interface RunPlannerOpenCodeOptions extends OneShotPlannerCoreOptions {
    /** OpenCode model in `provider/model` format. */
    model?: string
    opencodeBin?: string
}

function invokeWith(opts: RunPlannerOpenCodeOptions) {
    return (request: OneShotPlanningRequest) =>
        runOpenCodeOneShot({
            prompt: request.prompt,
            cwd: request.cwd,
            model: opts.model,
            opencodeBin: opts.opencodeBin,
            timeoutMs: request.timeoutMs,
            label: request.label,
        })
}

export async function runPlannerOpenCode(
    opts: RunPlannerOpenCodeOptions,
): Promise<string> {
    return runOneShotPlanner("PlannerOpenCode", "opencode", opts, invokeWith(opts))
}

export async function runOpenCodeIntake(
    opts: RunPlannerOpenCodeOptions,
): Promise<ModeContract> {
    return runOneShotIntake("opencode", opts, invokeWith(opts))
}
