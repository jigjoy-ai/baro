/**
 * Shared helper: run a one-shot `pi --mode json -p --no-session` invocation
 * against a single combined prompt, collect the JSONL stream, and return
 * the concatenated assistant `text` output. Used by planning phases so
 * the spawn + parse logic lives in one place.
 *
 * Implementation note: uses `spawn()` + streaming rather than
 * `execFile()` + buffer because execFile discards stdout on timeout.
 * Streaming lets us:
 *   - forward Pi's structured events to stderr live so the audit
 *     log captures them even on timeout
 *   - track which event subtypes were observed for the error message
 *   - kill Pi with SIGTERM on timeout instead of execFile's
 *     harsher escalation
 */

import { ChildProcess, spawn } from "child_process"

/** Options for `runPiOneShot`. */
export interface RunPiOneShotOptions {
    /** Combined system+user prompt. Passed as the final positional argv. */
    prompt: string
    /** Working directory for the Pi process. */
    cwd: string
    /**
     * Provider override (e.g. "google", "anthropic"). Pi's default is
     * "google". Omit to use Pi's configured default.
     */
    provider?: string
    /**
     * Model identifier. Treated as an opaque string and forwarded via
     * `--model`. Omit to use Pi's configured default.
     */
    model?: string
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /**
     * Per-phase label written into the live stderr stream so users can
     * tell traffic apart in one log tail. Defaults to "pi".
     */
    label?: string
}

/**
 * Spawn `pi --mode json -p --no-session`, collect all assistant `text`
 * content from `message_end` events, and return the concatenated string.
 *
 * @throws Error if the process exits without producing any text output.
 */
export async function runPiOneShot(
    opts: RunPiOneShotOptions,
): Promise<string> {
    const label = opts.label ?? "pi"
    // Build args: flags first, then optional provider/model, then prompt.
    const args = ["--mode", "json", "-p", "--no-session"]
    if (opts.provider) args.push("--provider", opts.provider)
    if (opts.model) args.push("--model", opts.model)
    args.push(opts.prompt)

    const timeoutMs = opts.timeoutMs ?? 600_000

    return await new Promise<string>((resolve, reject) => {
        let proc: ChildProcess
        try {
            proc = spawn(opts.piBin ?? "pi", args, {
                cwd: opts.cwd,
                // stdin: ignore (one-shot, no interactive input)
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
        let killTimer: ReturnType<typeof setTimeout> | null = null

        const clearTimers = (): void => {
            clearTimeout(timer)
            if (killTimer !== null) {
                clearTimeout(killTimer)
                killTimer = null
            }
        }

        const startedAt = Date.now()
        const timer = setTimeout(() => {
            timedOut = true
            try {
                proc.kill("SIGTERM")
            } catch {
                /* noop */
            }
            // Escalate to SIGKILL if Pi ignores SIGTERM; otherwise neither
            // `exit` nor `error` ever fires and this Promise hangs forever.
            killTimer = setTimeout(() => {
                killTimer = null
                try {
                    proc.kill("SIGKILL")
                } catch {
                    /* noop */
                }
            }, 5_000)
            killTimer.unref?.()
        }, timeoutMs)

        const maxBufferBytes = 16 * 1024 * 1024

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

                // Pi emits final assembled text in message_end content blocks.
                // Do NOT collect from deltas — message_end has the complete text.
                if (type === "message_end") {
                    const message = event.message as Record<string, unknown> | undefined
                    if (message?.role === "assistant") {
                        // Pi's usage keys are `input`/`output` (NOT
                        // `input_tokens`/`output_tokens`) — verified against
                        // live message_end output.
                        const usage = message.usage as { input?: number; output?: number } | undefined
                        if (usage) {
                            process.stderr.write(
                                `[${label}] usage: in=${usage.input ?? 0} out=${usage.output ?? 0}\n`,
                            )
                        }
                        const content = message.content as Array<Record<string, unknown>> | undefined
                        if (Array.isArray(content)) {
                            for (const block of content) {
                                if (block.type === "text" && typeof block.text === "string") {
                                    assistantText = assistantText
                                        ? `${assistantText}\n${block.text}`
                                        : block.text
                                }
                            }
                        }
                    }
                    continue
                }

                // Log tool executions so the audit trail shows agent activity.
                // Real Pi field is `toolName` on tool_execution_start; keep
                // `tool`/`name` only as defensive fallbacks.
                if (type === "tool_execution_start") {
                    const toolName =
                        typeof event.toolName === "string"
                            ? event.toolName.slice(0, 120)
                            : typeof event.tool === "string"
                              ? event.tool.slice(0, 120)
                              : typeof event.name === "string"
                                ? event.name.slice(0, 120)
                                : "?"
                    process.stderr.write(`[${label}] tool: ${toolName}\n`)
                    continue
                }
                // Also catch the toolcall_start shape carried inside
                // message_update.assistantMessageEvent. The tool name lives on
                // the toolCall content block (`name`), not on the event itself.
                if (type === "message_update") {
                    const ame = event.assistantMessageEvent as Record<string, unknown> | undefined
                    if (ame?.type === "toolcall_start") {
                        const block = ame.toolCall as Record<string, unknown> | undefined
                        const toolName =
                            typeof block?.name === "string"
                                ? block.name.slice(0, 120)
                                : typeof ame.toolName === "string"
                                  ? ame.toolName.slice(0, 120)
                                  : typeof ame.name === "string"
                                    ? ame.name.slice(0, 120)
                                    : "?"
                        process.stderr.write(`[${label}] tool: ${toolName}\n`)
                    }
                    continue
                }
            }
            // Guard against unbounded growth from a newline-less stream
            // (a wedged Pi or one enormous line). Drop the partial so
            // memory can't balloon; well-formed lines that follow still parse.
            if (stdoutBuffer.length > maxBufferBytes) {
                process.stderr.write(
                    `[${label}] stdout buffer exceeded ${maxBufferBytes} bytes without a newline — discarding partial line\n`,
                )
                stdoutBuffer = ""
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
            clearTimers()
            reject(err)
        })

        proc.on("exit", (code, signal) => {
            clearTimers()
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

            // Abnormal termination must fail even if SOME text accumulated.
            // The callers feed the returned string into a markdown doc /
            // JSON extractor — resolving partial text on a timeout (SIGTERM)
            // or crash silently produces an incomplete doc with no error
            // surfaced. Treat timeout, a terminating signal, or a non-zero
            // exit as failure.
            if (timedOut || signal != null || (code != null && code !== 0)) {
                reject(
                    new Error(
                        `runPiOneShot: pi terminated abnormally before completing (${ctx})`,
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
                    `runPiOneShot: pi produced no text output (${ctx})`,
                ),
            )
        })
    })
}
