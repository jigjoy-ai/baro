/**
 * ArchitectDevin — one-shot Architect call via `devin acp`.
 * The shared prompt/isolation/telemetry flow lives in one-shot-planning.ts.
 */

import { runDevinOneShot } from "../../harness/devin/one-shot.js"
import {
    runOneShotArchitect,
    type OneShotArchitectCoreOptions,
    type OneShotPlanningRequest,
} from "../../harness/one-shot/planning.js"

export interface RunArchitectDevinOptions extends OneShotArchitectCoreOptions {
    model?: string
    devinBin?: string
}

export async function runArchitectDevin(
    opts: RunArchitectDevinOptions,
): Promise<string> {
    return runOneShotArchitect(
        "ArchitectDevin",
        "devin",
        opts,
        (request: OneShotPlanningRequest) =>
            runDevinOneShot({
                prompt: request.prompt,
                cwd: request.cwd,
                model: opts.model,
                devinBin: opts.devinBin,
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
