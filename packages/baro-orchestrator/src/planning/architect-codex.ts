/**
 * ArchitectCodex — one-shot Architect call via `codex exec --json`.
 * Same prompt shape as ArchitectClaude / ArchitectOpenAI so providers
 * produce comparable decision documents; Codex's built-in tools explore.
 * In pre-acceptance mode repository files are evidence, not instructions:
 * Codex keeps the repository cwd for read-only exploration but automatic
 * AGENTS.md/project-document injection is disabled at the CLI boundary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCodexOneShot } from "../codex-one-shot.js"
import {
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import { ARCHITECT_OUTCOME_JSON_SCHEMA } from "./architect-outcome.js"
import type { ModeContract } from "./planner-prompts.js"

export interface RunArchitectCodexOptions {
    goal: string
    cwd: string
    model?: string
    projectContext?: string
    modeContract?: ModeContract
    codexBin?: string
    /** Default 10 min — codex with reasoning + tool exploration blew
     *  past the old 3-minute timeout mid-exploration. */
    timeoutMs?: number
    outcomeMode?: boolean
    readOnly?: boolean
}

export async function runArchitectCodex(
    opts: RunArchitectCodexOptions,
): Promise<string> {
    const userMessage = buildArchitectUserMessage(opts.goal, opts.projectContext, opts.modeContract)
    const prompt = `${opts.outcomeMode ? ARCHITECT_OUTCOME_SYSTEM_PROMPT : ARCHITECT_SYSTEM_PROMPT}\n\n${userMessage}`

    const schemaDirectory = opts.outcomeMode
        ? mkdtempSync(join(tmpdir(), "baro-architect-schema-"))
        : undefined
    const schemaFile = schemaDirectory
        ? join(schemaDirectory, "architect-outcome-v1.json")
        : undefined
    if (schemaFile) {
        writeFileSync(schemaFile, JSON.stringify(ARCHITECT_OUTCOME_JSON_SCHEMA), {
            encoding: "utf8",
            mode: 0o600,
        })
    }

    let text: string
    try {
        text = await runCodexOneShot({
            prompt,
            cwd: opts.cwd,
            model: opts.model,
            codexBin: opts.codexBin,
            timeoutMs: opts.timeoutMs ?? 600_000,
            label: "codex-architect",
            ...(opts.readOnly
                ? {
                      bypassSandbox: false,
                      sandboxMode: "read-only" as const,
                      ephemeral: true,
                      ignoreUserConfig: true,
                      ignoreRules: true,
                      disableProjectDocs: true,
                  }
                : {}),
            ...(schemaFile ? { outputSchemaFile: schemaFile } : {}),
        })
    } finally {
        if (schemaDirectory) {
            rmSync(schemaDirectory, { recursive: true, force: true })
        }
    }

    const doc = text.trim()
    if (!doc) {
        throw new Error("ArchitectCodex: codex returned empty result")
    }
    return doc
}
