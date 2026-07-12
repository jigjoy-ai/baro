/**
 * One-shot `codex exec --json` against a combined prompt; returns the
 * concatenated `agent_message` text. Uses spawn() + streaming rather than
 * execFile() because execFile discards stdout on timeout — long Codex runs
 * often hit the wall-clock cap, and streaming keeps the live stderr audit
 * trail of what Codex did with those minutes, plus a gentler SIGTERM.
 */

import { ChildProcess, spawn } from "child_process"

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
    /** Optional invocation telemetry sink. It cannot alter runner success. */
    onInvocation?: RunnerInvocationObserver
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
        const startedAt = Date.now()
        const invocations = new RunnerInvocationTracker(opts.onInvocation)
        let proc: ChildProcess
        try {
            proc = spawn(opts.codexBin ?? "codex", args, {
                cwd: opts.cwd,
                stdio: ["ignore", "pipe", "pipe"],
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
                    new Error(
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
        })
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
