/**
 * ArchitectOpenCode — one-shot Architect call via `opencode run --format json`.
 *
 * Same prompt shape as ArchitectClaude / ArchitectCodex so the providers
 * produce comparable decision documents. OpenCode's built-in tools
 * (file read, grep, bash, etc.) handle codebase exploration; we don't
 * ship a separate tool layer.
 *
 * Wire shape: combined `${SYSTEM}\n\n${USER}` prompt → opencode run
 * → JSONL stream → final text output → return as markdown.
 */

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"

/** Options for `runArchitectOpenCode`. */
export interface RunArchitectOpenCodeOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory the Architect explores in. */
    cwd: string
    /** OpenCode model in `provider/model` format. Default: undefined (use OpenCode default). */
    model?: string
    /** Optional CLAUDE.md / project-context blob to prepend. */
    projectContext?: string
    /** Path to the `opencode` binary. Default: "opencode". */
    opencodeBin?: string
    /**
     * Per-call timeout in milliseconds. Default: 600_000 (10 minutes).
     * OpenCode with tool-call exploration can be materially slower than
     * a direct API call — the original 3-minute timeout was killing runs
     * mid-exploration.
     */
    timeoutMs?: number
}

/**
 * Run the Architect phase using OpenCode as the backend.
 *
 * @returns The decision document (markdown) produced by the Architect.
 * @throws Error if OpenCode returns empty or fails.
 */
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
