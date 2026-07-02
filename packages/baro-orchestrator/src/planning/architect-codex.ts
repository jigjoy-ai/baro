/**
 * ArchitectCodex — one-shot Architect call via `codex exec --json`.
 * Same prompt shape as ArchitectClaude / ArchitectOpenAI so providers
 * produce comparable decision documents; Codex's built-in tools explore.
 */

import { runCodexOneShot } from "../codex-one-shot.js"
import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"

export interface RunArchitectCodexOptions {
    goal: string
    cwd: string
    model?: string
    projectContext?: string
    codexBin?: string
    /** Default 10 min — codex with reasoning + tool exploration blew
     *  past the old 3-minute timeout mid-exploration. */
    timeoutMs?: number
}

export async function runArchitectCodex(
    opts: RunArchitectCodexOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext)
    const prompt = `${ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`

    const text = await runCodexOneShot({
        prompt,
        cwd: opts.cwd,
        model: opts.model,
        codexBin: opts.codexBin,
        timeoutMs: opts.timeoutMs ?? 600_000,
        label: "codex-architect",
    })

    const doc = text.trim()
    if (!doc) {
        throw new Error("ArchitectCodex: codex returned empty result")
    }
    return doc
}
