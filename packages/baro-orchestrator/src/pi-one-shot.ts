/**
 * One-shot `pi --mode json -p --no-session` against a combined prompt;
 * returns the concatenated assistant text. Uses spawn() + streaming rather
 * than execFile() because execFile discards stdout on timeout — streaming
 * keeps the live stderr audit trail and allows a gentler SIGTERM.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

export interface RunPiOneShotOptions {
    /** Combined system+user prompt. Passed as the final positional argv. */
    prompt: string
    cwd: string
    /** Provider override (e.g. "google"); omit for Pi's configured default. */
    provider?: string
    /** Model id, forwarded opaquely via `--model`; omit for Pi's default. */
    model?: string
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /** Per-phase prefix for the live stderr stream. Default: "pi". */
    label?: string
}

/**
 * Collects assistant text from `message_end` events; throws if the process
 * exits without producing any.
 */
export async function runPiOneShot(
    opts: RunPiOneShotOptions,
): Promise<string> {
    const label = opts.label ?? "pi"
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

        // Shared with the stream-`end` flush so a final line without a
        // trailing newline still parses.
        const processLine = (rawLine: string): void => {
                const line = rawLine.trim()
                if (!line) return
                let event: Record<string, unknown>
                try {
                    event = JSON.parse(line) as Record<string, unknown>
                } catch {
                    return
                }
                const type = typeof event.type === "string" ? event.type : ""
                if (type) eventTypesSeen.push(type)

                // Pi emits final assembled text in message_end content blocks.
                // Do NOT collect from deltas — message_end has the complete text.
                if (type === "message_end") {
                    const message = event.message as Record<string, unknown> | undefined
                    if (message?.role === "assistant") {
                        // Pi's usage keys are `input`/`output`, NOT
                        // `input_tokens`/`output_tokens`.
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
                    return
                }

                // Real Pi field is `toolName`; `tool`/`name` are defensive
                // fallbacks against shape drift.
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
                    return
                }
                // toolcall_start also arrives inside message_update; the tool
                // name lives on the toolCall block, not the event itself.
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
                    return
                }
        }

        proc.stdout!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => {
            stdoutBuffer += chunk
            let nl: number
            while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
                const line = stdoutBuffer.slice(0, nl)
                stdoutBuffer = stdoutBuffer.slice(nl + 1)
                processLine(line)
            }
            // A newline-less stream (wedged Pi, one enormous line) would grow
            // unbounded; drop the partial — later well-formed lines still parse.
            if (stdoutBuffer.length > maxBufferBytes) {
                process.stderr.write(
                    `[${label}] stdout buffer exceeded ${maxBufferBytes} bytes without a newline — discarding partial line\n`,
                )
                stdoutBuffer = ""
            }
        })
        // Flush a final newline-less line — dropping it would lose message_end
        // and fail a successful run. 'end' fires after the last 'data', before 'exit'.
        proc.stdout!.on("end", () => {
            if (stdoutBuffer.length > 0) {
                processLine(stdoutBuffer)
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

            // Abnormal termination must fail even if SOME text accumulated:
            // callers feed the string into a markdown/JSON extractor, so
            // partial text on timeout/crash would silently yield an
            // incomplete doc with no error surfaced.
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
