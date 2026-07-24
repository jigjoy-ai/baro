/**
 * ArchitectPi — one-shot Architect call via the `pi` CLI.
 * The shared prompt/isolation/telemetry flow lives in one-shot-planning.ts.
 */

import { runPiOneShot } from "../pi-one-shot.js"
import {
    runOneShotArchitect,
    type OneShotArchitectCoreOptions,
    type OneShotPlanningRequest,
} from "./one-shot-planning.js"

export interface RunArchitectPiOptions extends OneShotArchitectCoreOptions {
    /** Pi provider (e.g. "anthropic", "openai"). */
    provider?: string
    model?: string
    piBin?: string
}

export async function runArchitectPi(
    opts: RunArchitectPiOptions,
): Promise<string> {
    return runOneShotArchitect(
        "ArchitectPi",
        "pi",
        opts,
        (request: OneShotPlanningRequest) =>
            runPiOneShot({
                prompt: request.prompt,
                cwd: request.cwd,
                provider: opts.provider,
                model: opts.model,
                piBin: opts.piBin,
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
