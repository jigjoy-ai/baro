/**
 * One-shot `codex exec --json` against a combined prompt; returns the
 * concatenated `agent_message` text. Uses spawn() + streaming rather than
 * execFile() because execFile discards stdout on timeout — long Codex runs
 * often hit the wall-clock cap, and streaming keeps the live stderr audit
 * trail of what Codex did with those minutes, plus a gentler SIGTERM.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

export interface RunCodexOneShotOptions {
    /** Combined system+user prompt. Passed as the final positional argv. */
    prompt: string
    /** Working directory. Must be a git repo (Codex enforces) unless
     *  skipGitRepoCheck=true. */
    cwd: string
    /** Model identifier. Defaults to Codex's own pick (gpt-5.5 on Plus+). */
    model?: string
    /** Bypass Codex's sandbox + approval prompts. Default: true. */
    bypassSandbox?: boolean
    /** Skip the "must be inside a git repo" check. Default: false. */
    skipGitRepoCheck?: boolean
    /** Path to the `codex` binary. Default: "codex". */
    codexBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /** Per-phase prefix for the live stderr stream. Default: "codex". */
    label?: string
}

export async function runCodexOneShot(
    opts: RunCodexOneShotOptions,
): Promise<string> {
    const label = opts.label ?? "codex"
    const args = ["exec", "--json"]
    if (opts.skipGitRepoCheck) args.push("--skip-git-repo-check")
    if (opts.bypassSandbox !== false) {
        args.push("--dangerously-bypass-approvals-and-sandbox")
    }
    if (opts.model) args.push("--model", opts.model)
    args.push(opts.prompt)

    const timeoutMs = opts.timeoutMs ?? 600_000

    return await new Promise<string>((resolve, reject) => {
        let proc: ChildProcess
        try {
            proc = spawn(opts.codexBin ?? "codex", args, {
                cwd: opts.cwd,
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
            return
        }

        let agentMessage = ""
        let stdoutBuffer = ""
        const eventTypesSeen: string[] = []
        const itemTypesSeen: string[] = []
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

                if (type === "turn.completed") {
                    const usage = event.usage as
                        | { input_tokens?: number; output_tokens?: number }
                        | undefined
                    if (usage) {
                        process.stderr.write(
                            `[${label}] usage: in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}\n`,
                        )
                    }
                    continue
                }
                if (type === "item.completed") {
                    const item = event.item as Record<string, unknown> | undefined
                    if (item) {
                        const innerType =
                            typeof item.type === "string" ? item.type : "?"
                        itemTypesSeen.push(innerType)
                        if (
                            item.type === "agent_message" &&
                            typeof item.text === "string"
                        ) {
                            agentMessage = agentMessage
                                ? `${agentMessage}\n${item.text}`
                                : item.text
                        } else if (innerType === "command_execution") {
                            const cmd =
                                typeof item.command === "string"
                                    ? item.command.slice(0, 120)
                                    : "?"
                            process.stderr.write(`[${label}] $ ${cmd}\n`)
                        }
                    }
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
                `items=${itemTypesSeen.length}`,
                eventTypesSeen.length > 0
                    ? `event_types=[${[...new Set(eventTypesSeen)].join(",")}]`
                    : null,
                itemTypesSeen.length > 0
                    ? `item_types=[${[...new Set(itemTypesSeen)].join(",")}]`
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
                        `runCodexOneShot: codex terminated abnormally before completing (${ctx})`,
                    ),
                )
                return
            }

            if (agentMessage.trim()) {
                resolve(agentMessage)
                return
            }

            reject(
                new Error(
                    `runCodexOneShot: codex produced no agent_message (${ctx})`,
                ),
            )
        })
    })
}
