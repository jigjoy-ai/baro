/**
 * ArchitectOpenCode — one-shot Architect call via `opencode run --format json`.
 * Same prompt shape as ArchitectClaude / ArchitectCodex so providers produce
 * comparable decision documents; OpenCode's built-in tools explore.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import type { ModeContract } from "./planner-prompts.js"

export interface RunArchitectOpenCodeOptions {
    goal: string
    cwd: string
    /** OpenCode model in `provider/model` format. */
    model?: string
    projectContext?: string
    modeContract?: ModeContract
    opencodeBin?: string
    /** Default 10 min — tool-call exploration blew past the old
     *  3-minute timeout mid-exploration. */
    timeoutMs?: number
    outcomeMode?: boolean
}

export async function runArchitectOpenCode(
    opts: RunArchitectOpenCodeOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext, opts.modeContract)
    const prompt = opts.outcomeMode
        ? userMessage
        : `${ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`
    // OpenCode has no repository read-only sandbox. Outcome mode therefore
    // runs its existing deny-all evaluator in an empty disposable directory
    // and relies only on Baro's brokered deterministic project context.
    const isolatedCwd = opts.outcomeMode
        ? mkdtempSync(join(tmpdir(), "baro-architect-opencode-"))
        : undefined

    let text: string
    try {
        text = await runOpenCodeOneShot({
            prompt,
            cwd: isolatedCwd ?? opts.cwd,
            model: opts.model,
            opencodeBin: opts.opencodeBin,
            timeoutMs: opts.timeoutMs ?? 600_000,
            label: "opencode-architect",
            ...(opts.outcomeMode
                ? { safeEvaluatorSystemPrompt: ARCHITECT_OUTCOME_SYSTEM_PROMPT }
                : {}),
        })
    } finally {
        if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true })
    }

    const doc = text.trim()
    if (!doc) {
        throw new Error("ArchitectOpenCode: opencode returned empty result")
    }
    return doc
}
