/** SurgeonDevin — one-shot adaptive DAG recovery via `devin acp`. */

import { runDevinOneShot } from "./one-shot.js"
import {
    OneShotSurgeon,
    type OneShotSurgeonCoreOptions,
    type OneShotSurgeonInvocationContext,
} from "../one-shot/surgeon.js"

export interface SurgeonDevinOptions extends OneShotSurgeonCoreOptions {
    model?: string
    devinBin?: string
}

export class SurgeonDevin extends OneShotSurgeon {
    private readonly model: string | undefined
    private readonly devinBin: string

    constructor(opts: SurgeonDevinOptions) {
        super(opts, { backend: "devin", sourceTag: "surgeon:devin" }, opts.model)
        this.model = opts.model
        this.devinBin = opts.devinBin ?? "devin"
    }

    protected override invoke(
        prompt: string,
        context: OneShotSurgeonInvocationContext,
    ): Promise<string> {
        return runDevinOneShot({
            prompt,
            cwd: process.cwd(),
            model: this.model,
            devinBin: this.devinBin,
            timeoutMs: context.timeoutMs,
            label: "devin-surgeon",
            onInvocation: context.onInvocation,
        })
    }
}
