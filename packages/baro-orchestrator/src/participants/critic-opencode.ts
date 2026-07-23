/** CriticOpenCode — one-shot acceptance evaluator via `opencode run`. */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import { VERDICT_SYSTEM_PROMPT } from "./critic.js"
import {
    OneShotCritic,
    type OneShotCriticCoreOptions,
    type OneShotCriticInvocationContext,
} from "./critic-one-shot.js"

export interface CriticOpenCodeOptions extends OneShotCriticCoreOptions {
    /** Model in `provider/model` format; omit for OpenCode's default. */
    model?: string
    /** Path to the `opencode` binary. Default: "opencode". */
    opencodeBin?: string
}

export class CriticOpenCode extends OneShotCritic {
    private readonly model: string | undefined
    private readonly opencodeBin: string

    constructor(opts: CriticOpenCodeOptions) {
        super(opts, {
            backend: "opencode",
            defaultModelLabel: "opencode-default",
            errorLabel: "CriticOpenCode",
        }, opts.model)
        this.model = opts.model
        this.opencodeBin = opts.opencodeBin ?? "opencode"
    }

    protected override invoke(
        prompt: string,
        context: OneShotCriticInvocationContext,
    ): Promise<string> {
        return runOpenCodeOneShot({
            prompt,
            cwd: context.cwd,
            model: this.model,
            opencodeBin: this.opencodeBin,
            timeoutMs: context.timeoutMs,
            label: "opencode-critic",
            onInvocation: context.onInvocation,
            safeEvaluatorSystemPrompt: VERDICT_SYSTEM_PROMPT,
        })
    }
}
