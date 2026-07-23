/** SurgeonCodex — one-shot adaptive DAG recovery via `codex exec`. */

import { runCodexOneShot } from "../codex-one-shot.js"
import {
    OneShotSurgeon,
    type OneShotSurgeonCoreOptions,
    type OneShotSurgeonInvocationContext,
} from "./surgeon-one-shot.js"

export interface SurgeonCodexOptions extends OneShotSurgeonCoreOptions {
    /** Model for LLM evaluations. Default: undefined (Codex picks). */
    model?: string
    /** Path to the `codex` binary. Default: "codex". */
    codexBin?: string
}

export class SurgeonCodex extends OneShotSurgeon {
    private readonly model: string | undefined
    private readonly codexBin: string

    constructor(opts: SurgeonCodexOptions) {
        super(opts, { backend: "codex", sourceTag: "surgeon:codex" }, opts.model)
        this.model = opts.model
        this.codexBin = opts.codexBin ?? "codex"
    }

    protected override invoke(
        prompt: string,
        context: OneShotSurgeonInvocationContext,
    ): Promise<string> {
        return runCodexOneShot({
            prompt,
            cwd: process.cwd(),
            skipGitRepoCheck: true,
            bypassSandbox: true,
            model: this.model,
            codexBin: this.codexBin,
            timeoutMs: context.timeoutMs,
            label: "codex-surgeon",
            onInvocation: context.onInvocation,
        })
    }
}
