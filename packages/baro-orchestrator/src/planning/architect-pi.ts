/**
 * ArchitectPi — one-shot Architect call via the `pi` CLI.
 * Same prompt shape as the other architect backends so providers produce
 * comparable decision documents; Pi's built-in tools explore.
 */

import { runPiOneShot } from "../pi-one-shot.js"
import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"

export interface RunArchitectPiOptions {
    goal: string
    cwd: string
    /** Pi provider (e.g. "anthropic", "openai"). */
    provider?: string
    model?: string
    projectContext?: string
    piBin?: string
    /** Default 10 min — tool-call exploration blew past the old
     *  3-minute timeout mid-exploration. */
    timeoutMs?: number
}

export async function runArchitectPi(
    opts: RunArchitectPiOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext)
    const prompt = `${ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`

    const text = await runPiOneShot({
        prompt,
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
        piBin: opts.piBin,
        timeoutMs: opts.timeoutMs ?? 600_000,
        label: "pi-architect",
    })

    const doc = text.trim()
    if (!doc) {
        throw new Error("ArchitectPi: pi returned empty result")
    }
    return doc
}
