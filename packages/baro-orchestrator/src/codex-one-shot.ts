/**
 * One-shot `codex exec --json` against a combined prompt; returns the
 * concatenated `agent_message` text. Uses spawn() + streaming rather than
 * execFile() because execFile discards stdout on timeout — long Codex runs
 * often hit the wall-clock cap, and streaming keeps the live stderr audit
 * trail of what Codex did with those minutes, plus a gentler SIGTERM.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

import { harnessChildEnvironment } from "./harness-environment.js"
import { anyProcessAlive, signalProcessTree } from "./process-tree.js"

import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type ModelInvocationStatus,
    type ModelTokenMetrics,
} from "./model-telemetry.js"
import {
    RunnerInvocationTracker,
    type RunnerInvocationObserver,
    type UnsequencedRunnerInvocationObservation,
} from "./runner-invocation.js"

export interface RunCodexOneShotOptions {
    /** Combined system+user prompt. */
    prompt: string
    /** Pipe the prompt over stdin with a `-` positional marker. */
    promptViaStdin?: boolean
    /** Working directory. Must be a git repo (Codex enforces) unless
     *  skipGitRepoCheck=true. */
    cwd: string
    /** Model identifier. Defaults to Codex's own pick (gpt-5.5 on Plus+). */
    model?: string
    /** Bypass Codex's sandbox + approval prompts. Default: true. */
    bypassSandbox?: boolean
    /** Sandbox used when bypassSandbox=false. Conversation/intake calls use
     * read-only so a model classifying intent cannot mutate the checkout. */
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access"
    /** Use a Codex permission profile that grants spawned tools only minimal
     * runtime reads, denies the workspace, and disables tool network access. */
    isolateToolFilesystem?: boolean
    /** Do not persist a Codex harness thread for this isolated call. */
    ephemeral?: boolean
    /** Ignore user config while retaining CODEX_HOME authentication. */
    ignoreUserConfig?: boolean
    /** Ignore user/project exec-policy rules for this isolated call. */
    ignoreRules?: boolean
    /** Disable automatic AGENTS.md/project-document prompt injection. The
     * CLI is run with strict config so an older Codex fails closed instead of
     * silently losing this trust boundary. */
    disableProjectDocs?: boolean
    /** Native final-response JSON Schema file, owned by the caller. */
    outputSchemaFile?: string
    /** Skip the "must be inside a git repo" check. Default: false. */
    skipGitRepoCheck?: boolean
    /** Path to the `codex` binary. Default: "codex". */
    codexBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /** Grace after SIGTERM before SIGKILL. Default: 5_000ms; injectable for tests. */
    terminationGraceMs?: number
    /** Per-phase prefix for the live stderr stream. Default: "codex". */
    label?: string
    /** Optional invocation telemetry sink. It cannot alter runner success. */
    onInvocation?: RunnerInvocationObserver
    /** Caller cancellation. The child is terminated and partial output is
     * rejected exactly like a timeout or crash. */
    signal?: AbortSignal
}

export async function runCodexOneShot(
    opts: RunCodexOneShotOptions,
): Promise<string> {
    if (opts.signal?.aborted) {
        throw new Error("runCodexOneShot: aborted before launch")
    }
    const label = opts.label ?? "codex"
    const args = ["exec", "--json"]
    if (opts.skipGitRepoCheck) args.push("--skip-git-repo-check")
    if (opts.isolateToolFilesystem && opts.bypassSandbox !== false) {
        throw new TypeError(
            "runCodexOneShot: isolateToolFilesystem requires bypassSandbox=false",
        )
    }
    if (opts.isolateToolFilesystem && opts.sandboxMode) {
        throw new TypeError(
            "runCodexOneShot: permission profiles cannot be combined with sandboxMode",
        )
    }
    if (opts.bypassSandbox !== false) {
        args.push("--dangerously-bypass-approvals-and-sandbox")
    } else if (opts.isolateToolFilesystem) {
        args.push(
            "--strict-config",
            "--config",
            'default_permissions="baro_dialogue"',
            "--config",
            'permissions.baro_dialogue.description="Baro brokered text-only front door"',
            "--config",
            'permissions.baro_dialogue.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
            "--config",
            'approval_policy="never"',
            "--config",
            'web_search="disabled"',
            "--config",
            'shell_environment_policy.inherit="none"',
            "--config",
            "allow_login_shell=false",
        )
    } else if (opts.sandboxMode) {
        args.push("--sandbox", opts.sandboxMode)
    }
    if (opts.ephemeral) args.push("--ephemeral")
    if (opts.ignoreUserConfig) args.push("--ignore-user-config")
    if (opts.ignoreRules) args.push("--ignore-rules")
    if (opts.disableProjectDocs) {
        if (!args.includes("--strict-config")) args.push("--strict-config")
        args.push("--config", "project_doc_max_bytes=0")
    }
    if (opts.outputSchemaFile) args.push("--output-schema", opts.outputSchemaFile)
    if (opts.model) args.push("--model", opts.model)
    args.push(opts.promptViaStdin ? "-" : opts.prompt)

    const timeoutMs = opts.timeoutMs ?? 600_000
    const terminationGraceMs = opts.terminationGraceMs ?? 5_000
    if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 1) {
        throw new RangeError("runCodexOneShot: terminationGraceMs must be positive")
    }

    return await new Promise<string>((resolve, reject) => {
        const startedAt = Date.now()
        const invocations = new RunnerInvocationTracker(opts.onInvocation)
        let proc: ChildProcess
        try {
            proc = spawn(opts.codexBin ?? "codex", args, {
                cwd: opts.cwd,
                env: harnessChildEnvironment(),
                stdio: [opts.promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
            })
        } catch (e) {
            invocations.finish(
                unknownCodexObservation("failed", Date.now() - startedAt, opts),
            )
            reject(e instanceof Error ? e : new Error(String(e)))
            return
        }

        let agentMessage = ""
        let stdoutBuffer = ""
        const eventTypesSeen: string[] = []
        const itemTypesSeen: string[] = []
        let timedOut = false
        let aborted = false
        let stdinError: Error | null = null
        let killTimer: ReturnType<typeof setTimeout> | null = null
        let pollTimer: ReturnType<typeof setInterval> | null = null
        let signalledPids = new Set<number>()
        let deferredExit: {
            code: number | null
            signal: NodeJS.Signals | null
        } | null = null

        const cleanup = (): void => {
            clearTimeout(timer)
            if (killTimer !== null) {
                clearTimeout(killTimer)
                killTimer = null
            }
            if (pollTimer !== null) {
                clearInterval(pollTimer)
                pollTimer = null
            }
            opts.signal?.removeEventListener("abort", onAbort)
        }
        const finalizeExit = (
            code: number | null,
            signal: NodeJS.Signals | null,
        ): void => {
            cleanup()
            const elapsedMs = Date.now() - startedAt

            const ctx = [
                `elapsed=${elapsedMs}ms`,
                `exit=${code}`,
                signal ? `signal=${signal}` : null,
                timedOut ? `timedOut=true (cap=${timeoutMs}ms)` : null,
                aborted ? "aborted=true" : null,
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
            if (
                stdinError ||
                timedOut ||
                aborted ||
                signal != null ||
                (code != null && code !== 0)
            ) {
                if (
                    !invocations.finish(
                        unknownCodexObservation(
                            timedOut ? "timed_out" : "failed",
                            elapsedMs,
                            opts,
                        ),
                    )
                ) {
                    return
                }
                reject(
                    stdinError ?? new Error(
                        `runCodexOneShot: codex terminated abnormally before completing (${ctx})`,
                    ),
                )
                return
            }

            if (agentMessage.trim()) {
                if (
                    !invocations.finish(
                        unknownCodexObservation(
                            "succeeded",
                            elapsedMs,
                            opts,
                        ),
                    )
                ) {
                    return
                }
                resolve(agentMessage)
                return
            }

            if (
                !invocations.finish(
                    unknownCodexObservation("failed", elapsedMs, opts),
                )
            ) {
                return
            }
            reject(
                new Error(
                    `runCodexOneShot: codex produced no agent_message (${ctx})`,
                ),
            )
        }
        const finishDeferredExit = (): void => {
            const exit = deferredExit
            if (!exit) return
            deferredExit = null
            finalizeExit(exit.code, exit.signal)
        }
        const terminate = (): void => {
            signalledPids = signalProcessTree(proc, "SIGTERM", signalledPids)
            if (killTimer !== null) return
            killTimer = setTimeout(() => {
                killTimer = null
                signalledPids = signalProcessTree(
                    proc,
                    "SIGKILL",
                    signalledPids,
                )
                // If the direct CLI already exited, every captured descendant
                // has now received SIGKILL. Do not clear this timer merely
                // because the root exited before a resistant grandchild.
                finishDeferredExit()
            }, terminationGraceMs)
        }
        const onAbort = (): void => {
            if (aborted) return
            aborted = true
            terminate()
        }

        const timer = setTimeout(() => {
            if (timedOut) return
            timedOut = true
            terminate()
        }, timeoutMs)
        timer.unref?.()
        opts.signal?.addEventListener("abort", onAbort, { once: true })
        // Close the race between the pre-spawn check and listener install.
        if (opts.signal?.aborted) onAbort()

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
                    const usage = record(event.usage)
                    if (Object.keys(usage).length > 0) {
                        process.stderr.write(
                            `[${label}] usage: in=${numberForLog(usage.input_tokens)} out=${numberForLog(usage.output_tokens)}\n`,
                        )
                    }
                    // A thread id identifies the Codex harness session, not
                    // an upstream model request, so it must never populate
                    // providerRequestId.
                    if (!timedOut) {
                        invocations.observe(
                            codexObservation(
                                event,
                                Date.now() - startedAt,
                                opts,
                            ),
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
                            // Codex can emit completed assistant/status
                            // messages before the terminal response. Native
                            // output-schema validation applies to the final
                            // response, so concatenating earlier messages
                            // corrupts otherwise valid JSON/ADR output.
                            agentMessage = item.text
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
            cleanup()
            if (
                !invocations.finish(
                    unknownCodexObservation(
                        timedOut ? "timed_out" : "failed",
                        Date.now() - startedAt,
                        opts,
                    ),
                )
            ) {
                return
            }
            reject(err)
        })

        proc.on("exit", (code, signal) => {
            if ((timedOut || aborted) && anyProcessAlive(signalledPids)) {
                deferredExit = { code, signal }
                // Graceful descendants have no Node event to wake us when
                // they finish, so poll only after the direct child has exited.
                pollTimer = setInterval(() => {
                    if (!anyProcessAlive(signalledPids)) finishDeferredExit()
                }, 25)
                return
            }
            finalizeExit(code, signal)
        })
        if (opts.promptViaStdin) {
            if (!proc.stdin) {
                stdinError = new Error("runCodexOneShot: codex stdin is unavailable")
                terminate()
            } else {
                proc.stdin.on("error", (error) => {
                    stdinError = error
                    terminate()
                })
                proc.stdin.end(opts.prompt)
            }
        }
    })
}

function codexObservation(
    event: Record<string, unknown>,
    elapsedMs: number,
    opts: RunCodexOneShotOptions,
): UnsequencedRunnerInvocationObservation {
    const usage = record(event.usage)
    return {
        granularity: "turn",
        status: "succeeded",
        durationMs: knownMetric(elapsedMs, "cli_result"),
        tokens: codexTokenMetrics(usage),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: unknownMetric("not_reported"),
        },
        provider: "openai",
        resolvedModel: nonEmptyString(event.model) ?? opts.model ?? null,
        providerRequestId: null,
    }
}

function unknownCodexObservation(
    status: ModelInvocationStatus,
    elapsedMs: number,
    opts: RunCodexOneShotOptions,
): UnsequencedRunnerInvocationObservation {
    const reason = status === "timed_out" ? "timed_out" : "not_reported"
    const missing = unknownMetric(reason)
    return {
        granularity: "turn",
        status,
        durationMs: knownMetric(elapsedMs, "cli_result"),
        tokens: {
            inputTotal: missing,
            cachedInput: missing,
            cacheWriteInput: notApplicableMetric(),
            outputTotal: missing,
            reasoningOutput: missing,
            total: missing,
        },
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: missing,
        },
        provider: "openai",
        resolvedModel: opts.model ?? null,
        providerRequestId: null,
    }
}

function codexTokenMetrics(usage: Record<string, unknown>): ModelTokenMetrics {
    const input = metric(usage, "input_tokens")
    const output = metric(usage, "output_tokens")
    return {
        // Codex reports cached input as a subset of input_tokens.
        inputTotal: input,
        cachedInput: metric(usage, "cached_input_tokens"),
        cacheWriteInput: notApplicableMetric(),
        outputTotal: output,
        // Likewise reasoning_output_tokens is a subset of output_tokens.
        reasoningOutput: metric(usage, "reasoning_output_tokens"),
        total: optionalMetric(usage, "total_tokens") ?? sumKnown([input, output]),
    }
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

function metric(source: Record<string, unknown>, key: string): Metric {
    if (!(key in source) || source[key] == null) {
        return unknownMetric("not_reported")
    }
    const value = source[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? knownMetric(value, "provider_response")
        : unknownMetric("parse_error")
}

function optionalMetric(
    source: Record<string, unknown>,
    key: string,
): Metric | null {
    return key in source && source[key] != null ? metric(source, key) : null
}

function sumKnown(metrics: readonly Metric[]): Metric {
    if (metrics.every((item) => item.state === "known")) {
        return knownMetric(
            metrics.reduce(
                (sum, item) => sum + (item.state === "known" ? item.value : 0),
                0,
            ),
            "derived",
        )
    }
    const missing = metrics.find((item) => item.state === "unknown")
    return missing?.state === "unknown"
        ? unknownMetric(missing.reason)
        : unknownMetric("not_reported")
}

function numberForLog(value: unknown): number | "?" {
    return typeof value === "number" && Number.isFinite(value) ? value : "?"
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}
