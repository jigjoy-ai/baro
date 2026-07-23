/** SurgeonPi — one-shot adaptive DAG recovery via the `pi` CLI. */

import { runPiOneShot } from "../pi-one-shot.js"
import {
    OneShotSurgeon,
    type OneShotSurgeonCoreOptions,
    type OneShotSurgeonInvocationContext,
} from "./surgeon-one-shot.js"

export interface SurgeonPiOptions extends OneShotSurgeonCoreOptions {
    /** Provider (e.g. "anthropic", "openai"); omit for Pi's default. */
    provider?: string
    /** Model identifier; omit for Pi's default. */
    model?: string
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
}

export class SurgeonPi extends OneShotSurgeon {
    private readonly provider: string | undefined
    private readonly model: string | undefined
    private readonly piBin: string

    constructor(opts: SurgeonPiOptions) {
        super(opts, { backend: "pi", sourceTag: "surgeon:pi" }, opts.model)
        this.provider = opts.provider
        this.model = opts.model
        this.piBin = opts.piBin ?? "pi"
    }

    protected override invoke(
        prompt: string,
        context: OneShotSurgeonInvocationContext,
    ): Promise<string> {
        return runPiOneShot({
            prompt,
            cwd: process.cwd(),
            provider: this.provider,
            model: this.model,
            piBin: this.piBin,
            timeoutMs: context.timeoutMs,
            label: "pi-surgeon",
            onInvocation: context.onInvocation,
        })
    }
}
