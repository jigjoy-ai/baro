/**
 * ArchitectOpenCode — one-shot Architect call via `opencode run --format json`.
 * Same prompt shape as ArchitectClaude / ArchitectCodex so providers produce
 * comparable decision documents; OpenCode's built-in tools explore.
 */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"

export interface RunArchitectOpenCodeOptions {
    goal: string
    cwd: string
    /** OpenCode model in `provider/model` format. */
    model?: string
    projectContext?: string
    opencodeBin?: string
    /** Default 10 min — tool-call exploration blew past the old
     *  3-minute timeout mid-exploration. */
    timeoutMs?: number
}

export async function runArchitectOpenCode(
    opts: RunArchitectOpenCodeOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext)
    const prompt = `${ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`

    const text = await runOpenCodeOneShot({
        prompt,
        cwd: opts.cwd,
        model: opts.model,
        opencodeBin: opts.opencodeBin,
        timeoutMs: opts.timeoutMs ?? 600_000,
        label: "opencode-architect",
    })

    const doc = text.trim()
    if (!doc) {
        throw new Error("ArchitectOpenCode: opencode returned empty result")
    }
    return doc
}
