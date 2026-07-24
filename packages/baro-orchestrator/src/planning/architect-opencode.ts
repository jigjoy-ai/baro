/**
 * ArchitectOpenCode — one-shot Architect call via `opencode run --format json`.
 * The shared prompt/isolation/telemetry flow lives in one-shot-planning.ts.
 */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    runOneShotArchitect,
    type OneShotArchitectCoreOptions,
    type OneShotPlanningRequest,
} from "./one-shot-planning.js"

export interface RunArchitectOpenCodeOptions extends OneShotArchitectCoreOptions {
    /** OpenCode model in `provider/model` format. */
    model?: string
    opencodeBin?: string
}

export async function runArchitectOpenCode(
    opts: RunArchitectOpenCodeOptions,
): Promise<string> {
    return runOneShotArchitect(
        "ArchitectOpenCode",
        "opencode",
        opts,
        (request: OneShotPlanningRequest) =>
            runOpenCodeOneShot({
                prompt: request.prompt,
                cwd: request.cwd,
                model: opts.model,
                opencodeBin: opts.opencodeBin,
                timeoutMs: request.timeoutMs,
                label: request.label,
                ...(request.onInvocation
                    ? { onInvocation: request.onInvocation }
                    : {}),
                ...(request.safeEvaluatorSystemPrompt
                    ? {
                          safeEvaluatorSystemPrompt:
                              request.safeEvaluatorSystemPrompt,
                      }
                    : {}),
            }),
    )
}
