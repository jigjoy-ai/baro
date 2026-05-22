/**
 * ArchitectCodex — one-shot Architect call via `codex exec --json`.
 *
 * Same prompt shape as ArchitectClaude / ArchitectOpenAI so the three
 * providers produce comparable decision documents. Codex's built-in
 * tools (shell, file edits, MCP) do codebase exploration; we don't
 * ship a separate tool layer to it.
 *
 * Wire shape: combined `${SYSTEM}\n\n${USER}` prompt → codex exec
 * → JSONL stream → final agent_message text → return as markdown.
 */

import { runCodexOneShot } from "../codex-one-shot.js"
import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"

export interface RunArchitectCodexOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory the Architect explores in. */
    cwd: string
    /** Codex model. Default: undefined (let Codex pick — gpt-5.5 on Plus+). */
    model?: string
    /** Optional CLAUDE.md / project-context blob to prepend. */
    projectContext?: string
    /** Path to the `codex` binary. Default: "codex". */
    codexBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes).
     *  Codex with reasoning + tool-call exploration is materially
     *  slower than Claude opus on the architect role — the original
     *  3-minute timeout from architect-claude was killing runs mid-
     *  exploration. */
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
