#!/usr/bin/env tsx
/**
 * Probe: GitHub Copilot CLI JSONL schema (story S1).
 *
 * The single biggest risk in adding the Copilot backend is the
 * UNDOCUMENTED `--output-format json` event schema. `copilot -p` is a
 * one-shot, non-interactive invocation (like `codex exec` / `opencode
 * run`) that streams one JSON event per stdout line and exits. Before we
 * can write `mapCopilotEvent`, we have to capture that stream from the
 * real binary and record the observed event/field names — exactly as the
 * Codex spike did. Until then the mapper falls EVERYTHING through to
 * `CopilotUnknownEvent` rather than guessing field names.
 *
 * Unlike probe-codex.ts, this probe does NOT go through a Mozaik
 * participant: `CopilotCliParticipant` does not exist yet (it is a later
 * story and must be written AGAINST the schema this probe discovers). So
 * this script spawns the `copilot` binary directly via child_process and
 * captures the raw JSONL, mirroring the M1/M2 one-liner smoke tests that
 * probe-codex.ts documents at the bottom.
 *
 * Argv (per the design spec):
 *   copilot -p <PROMPT> --output-format json --yolo --no-ask-user
 *           [--model <MODEL>] [--reasoning-effort <EFFORT>]
 *
 * `<PROMPT>` is passed as a SINGLE argv element (no shell, no quoting):
 * spawn() passes argv directly, which is the correct mitigation for the
 * Windows `-p` whitespace-tokenisation bug (github/copilot-cli#3186). Do
 * NOT wrap the prompt in extra quotes.
 *
 * Usage:
 *   tsx packages/baro-app/scripts/probe-copilot.ts \
 *     --prompt "print the word hello and exit" \
 *     [--cwd <path>] [--model <name>] [--reasoning-effort <low|medium|high>]
 *
 * Output:
 *   - Each stdout line printed with a brief one-liner summary (parsed
 *     JSON top-level `type` + key names, or a raw-text marker for
 *     non-JSON lines) so you can watch the run unfold.
 *   - Full raw stream written verbatim to
 *     packages/baro-app/scripts/spike-logs/copilot-<unix-ts>.jsonl.
 *   - A catalogue of the distinct top-level event `type` values and the
 *     union of field names seen per type, printed at the end and appended
 *     to the log as a trailing `__probe_summary__` line.
 *
 * Budget caution: each invocation consumes GitHub Copilot quota. Don't
 * run this casually.
 */

import { spawn } from "child_process"
import { appendFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"

interface ProbeArgs {
    prompt: string
    cwd: string
    model?: string
    effort?: string
    copilotBin: string
}

function parseArgs(): ProbeArgs {
    const argv = process.argv.slice(2)
    let prompt: string | undefined
    let cwd = process.cwd()
    let model: string | undefined
    let effort: string | undefined
    let copilotBin = "copilot"
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
            case "--reasoning-effort":
            case "--effort":
                effort = argv[++i]
                break
            case "--copilot-bin":
                copilotBin = argv[++i]!
                break
            case "--help":
            case "-h":
                process.stdout.write(
                    `usage: probe-copilot.ts --prompt <text> [--cwd <path>] [--model <name>] [--reasoning-effort <low|medium|high>] [--copilot-bin <path>]\n`,
                )
                process.exit(0)
        }
    }
    if (!prompt) {
        process.stderr.write("error: --prompt is required\n")
        process.exit(2)
    }
    return { prompt, cwd, model, effort, copilotBin }
}

/**
 * Effort clamp preview — Copilot accepts only low|medium|high. baro's
 * values are low|medium|high|xhigh|max. The real backend clamps in a
 * shared helper in copilot-one-shot.ts; we mirror it here so the probe
 * exercises the exact flag the backend will pass.
 */
function clampEffort(effort?: string): string | undefined {
    switch (effort) {
        case "low":
        case "medium":
        case "high":
            return effort
        case "xhigh":
        case "max":
            return "high"
        default:
            return undefined
    }
}

function buildArgs(args: ProbeArgs): string[] {
    const argv = [
        "-p",
        args.prompt,
        "--output-format",
        "json",
        "--yolo",
        "--no-ask-user",
    ]
    if (args.model) {
        argv.push("--model", args.model)
    }
    const effort = clampEffort(args.effort)
    if (effort) {
        argv.push("--reasoning-effort", effort)
    }
    return argv
}

/** Accumulates the distinct top-level `type`s and their field names. */
class SchemaCatalogue {
    private readonly fieldsByType = new Map<string, Set<string>>()
    private nonJsonLines = 0
    private totalLines = 0

    observe(line: string): { parsed: boolean; type: string; keys: string[] } {
        this.totalLines++
        let obj: unknown
        try {
            obj = JSON.parse(line)
        } catch {
            this.nonJsonLines++
            return { parsed: false, type: "<non-json>", keys: [] }
        }
        if (obj === null || typeof obj !== "object") {
            return { parsed: true, type: `<${typeof obj}>`, keys: [] }
        }
        const record = obj as Record<string, unknown>
        const type =
            typeof record.type === "string"
                ? record.type
                : typeof record.event === "string"
                    ? record.event
                    : "<untyped>"
        const keys = Object.keys(record)
        let set = this.fieldsByType.get(type)
        if (!set) {
            set = new Set<string>()
            this.fieldsByType.set(type, set)
        }
        for (const k of keys) set.add(k)
        return { parsed: true, type, keys }
    }

    toJSON(): Record<string, unknown> {
        const types: Record<string, string[]> = {}
        for (const [type, fields] of this.fieldsByType) {
            types[type] = [...fields].sort()
        }
        return {
            __probe_summary__: true,
            totalLines: this.totalLines,
            nonJsonLines: this.nonJsonLines,
            distinctTypes: this.fieldsByType.size,
            types,
        }
    }

    print(): void {
        process.stdout.write(
            `\nprobe-copilot: ${this.totalLines} line(s), ${this.fieldsByType.size} distinct type(s)` +
                (this.nonJsonLines ? `, ${this.nonJsonLines} non-JSON line(s)` : "") +
                `\n`,
        )
        const sorted = [...this.fieldsByType.keys()].sort()
        for (const type of sorted) {
            const fields = [...this.fieldsByType.get(type)!].sort()
            process.stdout.write(`  ${type}: { ${fields.join(", ")} }\n`)
        }
    }
}

function summarize(line: string, info: { parsed: boolean; type: string; keys: string[] }): string {
    if (!info.parsed) {
        const snip = line.slice(0, 80)
        return `[raw] "${snip}${line.length > 80 ? "…" : ""}"`
    }
    return `[${info.type}] ${info.keys.join(" ")}`
}

async function main(): Promise<void> {
    const args = parseArgs()

    const logsDir = join(process.cwd(), "packages/baro-app/scripts/spike-logs")
    mkdirSync(logsDir, { recursive: true })
    const logPath = join(logsDir, `copilot-${Date.now()}.jsonl`)
    writeFileSync(logPath, "")

    const argv = buildArgs(args)
    process.stdout.write(`probe-copilot: log file ${logPath}\n`)
    process.stdout.write(`probe-copilot: cwd ${args.cwd}\n`)
    process.stdout.write(`probe-copilot: spawn ${args.copilotBin} ${argv.join(" ")}\n`)
    process.stdout.write(`probe-copilot: prompt ${args.prompt}\n\n`)

    const catalogue = new SchemaCatalogue()

    const child = spawn(args.copilotBin, argv, {
        cwd: args.cwd,
        stdio: ["ignore", "pipe", "pipe"],
    })

    let stdoutBuf = ""
    const handleLine = (line: string): void => {
        if (line.length === 0) return
        appendFileSync(logPath, line + "\n")
        const info = catalogue.observe(line)
        const ts = new Date().toISOString().slice(11, 23)
        process.stdout.write(`${ts}  ${summarize(line, info)}\n`)
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk
        let nl: number
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
            const line = stdoutBuf.slice(0, nl).replace(/\r$/, "")
            stdoutBuf = stdoutBuf.slice(nl + 1)
            handleLine(line)
        }
    })

    let stderrBuf = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk
        process.stderr.write(chunk)
    })

    const exitCode: number = await new Promise((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code) => {
            // flush any trailing partial line
            if (stdoutBuf.length > 0) handleLine(stdoutBuf.replace(/\r$/, ""))
            resolve(code ?? -1)
        })
    })

    catalogue.print()
    appendFileSync(logPath, JSON.stringify(catalogue.toJSON()) + "\n")

    process.stdout.write(
        `\nprobe-copilot: done. exitCode=${exitCode}` +
            (stderrBuf.trim() ? ` (stderr present — see above)` : "") +
            `\n`,
    )
    process.stdout.write(`probe-copilot: log persisted at ${logPath}\n`)
}

main().catch((err) => {
    process.stderr.write(`probe-copilot: fatal — ${err?.stack ?? err}\n`)
    process.exit(1)
})

/* ─── Smoke baseline: one-liner shell command (no Node wiring needed) ──
 *
 * Capture the raw stream directly to eyeball the envelope shape:
 *
 *   copilot -p "print the word hello and exit" \
 *     --output-format json --yolo --no-ask-user \
 *     | tee copilot-smoke.jsonl
 *
 * NOTE (github/copilot-cli#3186): on Windows, `-p` tokenises its value on
 * whitespace when invoked through a shell. This probe spawns copilot with
 * argv passed directly (no shell), so the prompt stays a single argument —
 * the correct mitigation. Do NOT work around it with extra quoting.
 * ─────────────────────────────────────────────────────────────────── */
