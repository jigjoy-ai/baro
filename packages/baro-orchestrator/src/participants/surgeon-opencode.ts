/** SurgeonOpenCode — one-shot adaptive DAG recovery via `opencode run`. */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    OneShotSurgeon,
    type OneShotSurgeonCoreOptions,
    type OneShotSurgeonInvocationContext,
} from "./surgeon-one-shot.js"

export interface SurgeonOpenCodeOptions extends OneShotSurgeonCoreOptions {
    /** Model in `provider/model` format; omit for OpenCode's default. */
    model?: string
    /** Path to the `opencode` binary. Default: "opencode". */
    opencodeBin?: string
}

export class SurgeonOpenCode extends OneShotSurgeon {
    private readonly model: string | undefined
    private readonly opencodeBin: string

    constructor(opts: SurgeonOpenCodeOptions) {
        super(opts, { backend: "opencode", sourceTag: "surgeon:opencode" }, opts.model)
        this.model = opts.model
        this.opencodeBin = opts.opencodeBin ?? "opencode"
    }

    protected override invoke(
        prompt: string,
        context: OneShotSurgeonInvocationContext,
    ): Promise<string> {
        return runOpenCodeOneShot({
            prompt,
            cwd: process.cwd(),
            model: this.model,
            opencodeBin: this.opencodeBin,
            timeoutMs: context.timeoutMs,
            label: "opencode-surgeon",
            onInvocation: context.onInvocation,
        })
    }
}
