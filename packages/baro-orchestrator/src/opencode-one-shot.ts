/**
 * One-shot `opencode run --format json` against a combined prompt; returns
 * the concatenated assistant text. Uses spawn() + streaming rather than
 * execFile() because execFile discards stdout on timeout — streaming keeps
 * the live stderr audit trail and allows a gentler SIGTERM.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

export interface RunOpenCodeOneShotOptions {
    /** Combined system+user prompt. Passed as the final positional argv. */
    prompt: string
    cwd: string
    /** Model in `provider/model` format; omit for OpenCode's configured default. */
    model?: string
    /** Path to the `opencode` binary. Default: "opencode". */
    opencodeBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /** Per-phase prefix for the live stderr stream. Default: "opencode". */
    label?: string
}

/**
 * Collects assistant text from `text` events; throws if the process exits
 * without producing any. Runs with `--dangerously-skip-permissions`.
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
                // Real opencode emits `tool_use`; `tool_call` is the
                // legacy paired-shape fallback. Log either.
                if (type === "tool_use" || type === "tool_call") {
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

            // Abnormal termination must fail even if SOME text accumulated:
            // callers feed the string into a markdown/JSON extractor that
            // accepts truncated-but-closed fragments, so partial text on
            // timeout/crash would silently yield an incomplete doc or PRD.
            if (timedOut || signal != null || (code != null && code !== 0)) {
                reject(
                    new Error(
                        `runOpenCodeOneShot: opencode terminated abnormally before completing (${ctx})`,
                    ),
                )
                return
            }

            if (assistantText.trim()) {
                resolve(assistantText)
                return
            }

            reject(
                new Error(
                    `runOpenCodeOneShot: opencode produced no text output (${ctx})`,
                ),
            )
        })
    })
}
