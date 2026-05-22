/**
 * Shared helper: run a one-shot `codex exec --json` invocation against
 * a single combined prompt, collect the JSONL stream, and return the
 * concatenated `agent_message` text. Used by `architect-codex.ts`,
 * `planner-codex.ts`, `critic-codex.ts`, and `surgeon-codex.ts` so the
 * spawn + parse logic lives in one place.
 *
 * Implementation note: uses `spawn()` + streaming rather than
 * `execFile()` + buffer because execFile discards stdout on timeout
 * (the error object contains it, but observed in practice that long
 * Codex runs hit the wall-clock cap before emitting a final
 * `agent_message`, and we want to *see* what Codex did with those
 * minutes — not just "codex produced no agent_message"). Streaming
 * lets us:
 *   - forward Codex's structured events to stderr live so the audit
 *     log captures them even on timeout
 *   - track which event subtypes were observed for the error message
 *   - kill Codex with SIGTERM on timeout instead of execFile's harsher
 *     SIGTERM-then-SIGKILL escalation
 */

import { ChildProcess, spawn } from "child_process"

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
    /**
     * Per-phase label written into the live stderr stream so users can
     * tell architect/planner/critic/surgeon traffic apart in one log
     * tail. Defaults to "codex".
     */
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

            if (agentMessage.trim()) {
                resolve(agentMessage)
                return
            }

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
            reject(
                new Error(
                    `runCodexOneShot: codex produced no agent_message (${ctx})`,
                ),
            )
        })
    })
}
