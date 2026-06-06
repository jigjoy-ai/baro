/**
 * ArchitectPi — one-shot Architect call via the `pi` CLI.
 *
 * Same prompt shape as ArchitectClaude / ArchitectCodex / ArchitectOpenCode
 * so the providers produce comparable decision documents. Pi's built-in
 * tools (file read, grep, bash, etc.) handle codebase exploration; we don't
 * ship a separate tool layer.
 *
 * Wire shape: combined `${SYSTEM}\n\n${USER}` prompt → pi run
 * → final text output → return as markdown.
 */

import { runPiOneShot } from "../pi-one-shot.js"
import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"

/** Options for `runArchitectPi`. */
export interface RunArchitectPiOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory the Architect explores in. */
    cwd: string
    /** Provider to use (e.g. "anthropic", "openai"). Default: undefined (use Pi default). */
    provider?: string
    /** Pi model identifier. Default: undefined (use Pi default). */
    model?: string
    /** Optional CLAUDE.md / project-context blob to prepend. */
    projectContext?: string
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
    /**
     * Per-call timeout in milliseconds. Default: 600_000 (10 minutes).
     * Pi with tool-call exploration can be materially slower than
     * a direct API call — the original 3-minute timeout was killing runs
     * mid-exploration.
     */
    timeoutMs?: number
}

/**
 * Run the Architect phase using Pi as the backend.
 *
 * @returns The decision document (markdown) produced by the Architect.
 * @throws Error if Pi returns empty or fails.
 */
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
