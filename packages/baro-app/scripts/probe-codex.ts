#!/usr/bin/env tsx
/**
 * Probe: Codex CLI as a Mozaik Participant.
 *
 * Validates milestones M1–M3 of the codex backend plan:
 *
 *   M1  — `codex exec --json` runs against a context-free cwd, JSONL
 *          stream lands on stdout (no Mozaik wiring; pure CLI smoke).
 *
 *   M2  — same, but run from inside the baro repo so we measure the
 *          incremental cost of Codex indexing a non-trivial repo.
 *
 *   M3  — CodexCliParticipant spawns `codex exec --json` and the
 *          codex-stream-mapper translates JSONL → Mozaik items, with
 *          every emitted event captured to `spike-logs/codex-<ts>.jsonl`
 *          for offline analysis.
 *
 * This script implements M3. M1 and M2 are one-liner shell commands the
 * user runs directly (no orchestrator wiring needed); see the comments
 * at the bottom of this file.
 *
 * Usage:
 *   tsx packages/baro-app/scripts/probe-codex.ts \
 *     --prompt "list files in packages/baro-orchestrator/src/participants/ and output their count" \
 *     [--cwd <path>] [--model gpt-5.5] [--full-auto]
 *
 * Output:
 *   - Every Mozaik bus event printed to stdout with a brief one-liner
 *     summary so you can see the run unfold.
 *   - Full raw JSONL audit log written to
 *     packages/baro-app/scripts/spike-logs/codex-<unix-ts>.jsonl. Compare
 *     side-by-side with the Claude spike logs in the same directory
 *     to verify the mapper produces the same Mozaik shape from both
 *     backends.
 *
 * Budget caution: each invocation costs ~3% of the ChatGPT Free weekly
 * cap (per Codex documentation; observed 2026-05-22). Don't run this
 * casually.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    ReasoningItem,
    SemanticEvent,
} from "@mozaik-ai/core"

import { CodexCliParticipant } from "@baro/orchestrator"

type Loggable =
    | SemanticEvent<unknown>
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | ReasoningItem

interface ProbeArgs {
    prompt: string
    cwd: string
    model?: string
    fullAuto: boolean
    skipGitRepoCheck: boolean
}

function parseArgs(): ProbeArgs {
    const argv = process.argv.slice(2)
    let prompt: string | undefined
    let cwd = process.cwd()
    let model: string | undefined
    let fullAuto = false
    let skipGitRepoCheck = false
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "--prompt":
                prompt = argv[++i]
                break
            case "--cwd":
                cwd = argv[++i]!
                break
            case "--model":
                model = argv[++i]
                break
            case "--full-auto":
                fullAuto = true
                break
            case "--skip-git-repo-check":
                skipGitRepoCheck = true
                break
            case "--help":
            case "-h":
                process.stdout.write(
                    `usage: probe-codex.ts --prompt <text> [--cwd <path>] [--model <name>] [--full-auto] [--skip-git-repo-check]\n`,
                )
                process.exit(0)
        }
    }
    if (!prompt) {
        process.stderr.write("error: --prompt is required\n")
        process.exit(2)
    }
    return { prompt, cwd, model, fullAuto, skipGitRepoCheck }
}

function summarize(item: Loggable): string {
    if (item instanceof SemanticEvent) {
        const type = item.type
        const data = item.data as Record<string, unknown>
        const hints: string[] = []
        if (typeof data.subtype === "string") hints.push(`subtype=${data.subtype}`)
        if (typeof data.phase === "string") hints.push(`phase=${data.phase}`)
        if (typeof data.itemType === "string") hints.push(`item=${data.itemType}`)
        return `[${type}] ${hints.join(" ")}`
    }
    const json = (item as { toJSON: () => Record<string, unknown> }).toJSON()
    const type = typeof json.type === "string" ? json.type : "item"
    const text =
        typeof json.text === "string"
            ? `"${(json.text as string).slice(0, 80)}${
                  (json.text as string).length > 80 ? "…" : ""
              }"`
            : typeof (json as { name?: unknown }).name === "string"
                ? `name=${(json as { name?: string }).name}`
                : ""
    return `[${type}] ${text}`
}

class LoggingObserver extends BaseObserver {
    constructor(private readonly logPath: string) {
        super()
    }

    private write(source: Participant, item: Loggable): void {
        const entry = {
            ts: new Date().toISOString(),
            source: source.constructor.name,
            item: (item as { toJSON: () => Record<string, unknown> }).toJSON(),
        }
        appendFileSync(this.logPath, JSON.stringify(entry) + "\n")
        process.stdout.write(`${entry.ts.slice(11, 23)}  ${summarize(item)}\n`)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        this.write(source, event)
    }

    override async onExternalModelMessage(
        source: Participant,
        item: ModelMessageItem,
    ): Promise<void> {
        this.write(source, item)
    }

    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        this.write(source, item)
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        this.write(source, item)
    }
}

async function main(): Promise<void> {
    const { prompt, cwd, model, fullAuto, skipGitRepoCheck } = parseArgs()

    const logsDir = join(process.cwd(), "packages/baro-app/scripts/spike-logs")
    mkdirSync(logsDir, { recursive: true })
    const logPath = join(logsDir, `codex-${Date.now()}.jsonl`)
    writeFileSync(logPath, "")
    process.stdout.write(`probe-codex: log file ${logPath}\n`)
    process.stdout.write(`probe-codex: cwd ${cwd}\n`)
    process.stdout.write(`probe-codex: prompt ${prompt}\n\n`)

    const env = new AgenticEnvironment()
    const observer = new LoggingObserver(logPath)
    observer.join(env)

    const codex = new CodexCliParticipant("probe", {
        cwd,
        prompt,
        model,
        fullAuto,
        skipGitRepoCheck,
    })
    codex.join(env)
    codex.start(env)

    const summary = await codex.done
    process.stdout.write(
        `\nprobe-codex: done. threadId=${summary.threadId} exitCode=${summary.exitCode} error=${summary.error?.message ?? "—"}\n`,
    )
    process.stdout.write(`probe-codex: log persisted at ${logPath}\n`)
}

main().catch((err) => {
    process.stderr.write(`probe-codex: fatal — ${err?.stack ?? err}\n`)
    process.exit(1)
})

/* ─── M1 & M2: one-liner shell commands (no Node wiring needed) ──────
 *
 * M1 — context-free baseline (non-repo dir needs --skip-git-repo-check
 *      because Codex refuses to run outside a trusted git repo by
 *      default):
 *   mkdir -p /tmp/codex-probe && cd /tmp/codex-probe
 *   codex exec --json --skip-git-repo-check \
 *     "print the word hello and exit" \
 *     | tee ~/Desktop/codex-probe-M1.jsonl
 *
 * M2 — baro-repo indexing cost (no flag needed; baro is a git repo):
 *   cd ~/Desktop/baro
 *   codex exec --json "print the word hello and exit" \
 *     | tee ~/Desktop/codex-probe-M2.jsonl
 *
 * Diff the resulting JSONLs to measure repo-indexing overhead. Both
 * runs cost weekly-cap units even on success, so plan carefully.
 * ─────────────────────────────────────────────────────────────────── */
