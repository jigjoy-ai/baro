/**
 * Shared helper: run a one-shot `opencode run --format json` invocation
 * against a single combined prompt, collect the JSONL stream, and return
 * the concatenated assistant `text` output. Used by
 * `architect-opencode.ts`, `planner-opencode.ts`, and similar planning
 * phases so the spawn + parse logic lives in one place.
 *
 * Implementation note: uses `spawn()` + streaming rather than
 * `execFile()` + buffer because execFile discards stdout on timeout.
 * Streaming lets us:
 *   - forward OpenCode's structured events to stderr live so the audit
 *     log captures them even on timeout
 *   - track which event subtypes were observed for the error message
 *   - kill OpenCode with SIGTERM on timeout instead of execFile's
 *     harsher escalation
 */

import { ChildProcess, spawn } from "child_process"

/** Options for `runOpenCodeOneShot`. */
export interface RunOpenCodeOneShotOptions {
    /** Combined system+user prompt. Passed as the final positional argv. */
    prompt: string
    /** Working directory for the OpenCode process. */
    cwd: string
    /**
     * Model identifier in `provider/model` format. Omit to use
     * OpenCode's configured default.
     */
    model?: string
    /** Path to the `opencode` binary. Default: "opencode". */
    opencodeBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /**
     * Per-phase label written into the live stderr stream so users can
     * tell architect/planner/critic traffic apart in one log tail.
     * Defaults to "opencode".
     */
    label?: string
}

/**
 * Spawn `opencode run --format json --dangerously-skip-permissions`,
 * collect all `text` events, and return the concatenated assistant text.
 *
 * @throws Error if the process exits without producing any text output.
 */
export async function runOpenCodeOneShot(
    opts: RunOpenCodeOneShotOptions,
): Promise<string> {
    const label = opts.label ?? "opencode"
    const args = ["run", "--format", "json", "--dangerously-skip-permissions"]
    if (opts.model) args.push("-m", opts.model)
    if (opts.cwd) args.push("--dir", opts.cwd)
    args.push(opts.prompt)

    const timeoutMs = opts.timeoutMs ?? 600_000

    return await new Promise<string>((resolve, reject) => {
        let proc: ChildProcess
        try {
            proc = spawn(opts.opencodeBin ?? "opencode", args, {
                cwd: opts.cwd,
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
            return
        }

        let assistantText = ""
        let stdoutBuffer = ""
        const eventTypesSeen: string[] = []
        let timedOut = false

        const startedAt = Date.now()
        const timer = setTimeout(() => {
            timedOut = true
            try {
                proc.kill("SIGTERM")
            } catch {
                /* noop */
            }
        }, timeoutMs)

        proc.stdout!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => {
            stdoutBuffer += chunk
            let nl: number
            while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
                const line = stdoutBuffer.slice(0, nl).trim()
                stdoutBuffer = stdoutBuffer.slice(nl + 1)
                if (!line) continue
                let event: Record<string, unknown>
                try {
                    event = JSON.parse(line) as Record<string, unknown>
                } catch {
                    continue
                }
                const type = typeof event.type === "string" ? event.type : ""
                if (type) eventTypesSeen.push(type)

                if (type === "step_finish") {
                    const part = event.part as Record<string, unknown> | undefined
                    const tokens = part?.tokens as
                        | { input?: number; output?: number }
                        | undefined
                    if (tokens) {
                        process.stderr.write(
                            `[${label}] usage: in=${tokens.input ?? 0} out=${tokens.output ?? 0}\n`,
                        )
                    }
                    continue
                }
                if (type === "text") {
                    const part = event.part as Record<string, unknown> | undefined
                    if (part && typeof part.text === "string") {
                        assistantText = assistantText
                            ? `${assistantText}\n${part.text}`
                            : part.text
                    }
                    continue
                }
                if (type === "tool_call") {
                    const part = event.part as Record<string, unknown> | undefined
                    const tool =
                        typeof part?.tool === "string"
                            ? part.tool.slice(0, 120)
                            : "?"
                    process.stderr.write(`[${label}] tool: ${tool}\n`)
                    continue
                }
            }
        })

        proc.stderr!.setEncoding("utf8")
        proc.stderr!.on("data", (chunk: string) => {
            const trimmed = chunk.trimEnd()
            if (trimmed) {
                process.stderr.write(`[${label}/stderr] ${trimmed}\n`)
            }
        })

        proc.on("error", (err) => {
            clearTimeout(timer)
            reject(err)
        })

        proc.on("exit", (code, signal) => {
            clearTimeout(timer)
            const elapsedMs = Date.now() - startedAt

            if (assistantText.trim()) {
                resolve(assistantText)
                return
            }

            const ctx = [
                `elapsed=${elapsedMs}ms`,
                `exit=${code}`,
                signal ? `signal=${signal}` : null,
                timedOut ? `timedOut=true (cap=${timeoutMs}ms)` : null,
                `events=${eventTypesSeen.length}`,
                eventTypesSeen.length > 0
                    ? `event_types=[${[...new Set(eventTypesSeen)].join(",")}]`
                    : null,
            ]
                .filter((x): x is string => x !== null)
                .join(" ")
            reject(
                new Error(
                    `runOpenCodeOneShot: opencode produced no text output (${ctx})`,
                ),
            )
        })
    })
}
