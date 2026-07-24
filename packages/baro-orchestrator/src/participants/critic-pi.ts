/** CriticPi — one-shot acceptance evaluator via the `pi` CLI. */

import { runPiOneShot } from "../pi-one-shot.js"
import { VERDICT_SYSTEM_PROMPT } from "./critic-verdict.js"
import {
    OneShotCritic,
    type OneShotCriticCoreOptions,
    type OneShotCriticInvocationContext,
} from "./critic-one-shot.js"

export interface CriticPiOptions extends OneShotCriticCoreOptions {
    /** Provider (e.g. "anthropic", "openai"); omit for Pi's default. */
    provider?: string
    /** Model identifier; omit for Pi's default. */
    model?: string
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
}

export class CriticPi extends OneShotCritic {
    private readonly provider: string | undefined
    private readonly model: string | undefined
    private readonly piBin: string

    constructor(opts: CriticPiOptions) {
        super(opts, {
            backend: "pi",
            defaultModelLabel: "pi-default",
            errorLabel: "CriticPi",
        }, opts.model)
        this.provider = opts.provider
        this.model = opts.model
        this.piBin = opts.piBin ?? "pi"
    }

    protected override invoke(
        prompt: string,
        context: OneShotCriticInvocationContext,
    ): Promise<string> {
        return runPiOneShot({
            prompt,
            cwd: context.cwd,
            provider: this.provider,
            model: this.model,
            piBin: this.piBin,
            timeoutMs: context.timeoutMs,
            label: "pi-critic",
            onInvocation: context.onInvocation,
            safeEvaluatorSystemPrompt: VERDICT_SYSTEM_PROMPT,
        })
    }
}
