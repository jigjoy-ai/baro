/** CriticDevin — one-shot acceptance evaluator via `devin acp`, with every tool denied. */

import { runDevinOneShot } from "./one-shot.js"
import { VERDICT_SYSTEM_PROMPT } from "../../acceptance/critic-verdict.js"
import {
    OneShotCritic,
    type OneShotCriticCoreOptions,
    type OneShotCriticInvocationContext,
} from "../one-shot/critic.js"

export interface CriticDevinOptions extends OneShotCriticCoreOptions {
    model?: string
    devinBin?: string
}

export class CriticDevin extends OneShotCritic {
    private readonly model: string | undefined
    private readonly devinBin: string

    constructor(opts: CriticDevinOptions) {
        super(opts, {
            backend: "devin",
            defaultModelLabel: "devin-default",
            errorLabel: "CriticDevin",
        }, opts.model)
        this.model = opts.model
        this.devinBin = opts.devinBin ?? "devin"
    }

    protected override invoke(
        prompt: string,
        context: OneShotCriticInvocationContext,
    ): Promise<string> {
        return runDevinOneShot({
            prompt,
            cwd: context.cwd,
            model: this.model,
            devinBin: this.devinBin,
            timeoutMs: context.timeoutMs,
            label: "devin-critic",
            onInvocation: context.onInvocation,
            safeEvaluatorSystemPrompt: VERDICT_SYSTEM_PROMPT,
        })
    }
}
