/**
 * One-shot `pi --mode json -p --no-session` against a combined prompt;
 * returns the concatenated assistant text. Uses spawn() + streaming rather
 * than execFile() because execFile discards stdout on timeout — streaming
 * keeps the live stderr audit trail and allows a gentler SIGTERM.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

import { harnessChildEnvironment } from "./harness-environment.js"
import { ManagedProcessTree } from "./process-tree.js"

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

export interface RunPiOneShotOptions {
    /** Combined system+user prompt. Safe evaluators pipe it over stdin. */
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
    /** Grace after SIGTERM before SIGKILL. Default: 5_000ms. */
    terminationGraceMs?: number
    /** Per-phase prefix for the live stderr stream. Default: "pi". */
    label?: string
    /** Optional invocation telemetry sink. It cannot alter runner success. */
    onInvocation?: RunnerInvocationObserver
    /** Optional caller cancellation. Aborting terminates the harness child. */
    signal?: AbortSignal
    /**
     * Text-only evaluator hardening: pass this as Pi's real system prompt while
     * disabling every tool, extension, skill, template, theme, and context
     * file. Other callers retain the existing tool-capable invocation.
     */
    safeEvaluatorSystemPrompt?: string
}

/**
 * Collects assistant text from `message_end` events; throws if the process
 * exits without producing any.
 */
export async function runPiOneShot(
    opts: RunPiOneShotOptions,
): Promise<string> {
    if (opts.signal?.aborted) throw abortError()
    const label = opts.label ?? "pi"
    const safeEvaluator = opts.safeEvaluatorSystemPrompt !== undefined
    const args = ["--mode", "json", "-p", "--no-session"]
    if (safeEvaluator) {
        args.push(
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--system-prompt",
            opts.safeEvaluatorSystemPrompt!,
        )
    }
    if (opts.provider) args.push("--provider", opts.provider)
    if (opts.model) args.push("--model", opts.model)
    if (!safeEvaluator) args.push(opts.prompt)

    const timeoutMs = opts.timeoutMs ?? 600_000
    const terminationGraceMs = opts.terminationGraceMs ?? 5_000
    if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 1) {
        throw new RangeError("runPiOneShot: terminationGraceMs must be positive")
    }

    return await new Promise<string>((resolve, reject) => {
        const startedAt = Date.now()
        const invocations = new RunnerInvocationTracker(opts.onInvocation)
        let proc: ChildProcess
        try {
            proc = spawn(opts.piBin ?? "pi", args, {
                cwd: opts.cwd,
                env: harnessChildEnvironment(),
                stdio: [safeEvaluator ? "pipe" : "ignore", "pipe", "pipe"],
            })
        } catch (e) {
            invocations.finish(
                unknownPiObservation("failed", Date.now() - startedAt, opts),
            )
            reject(e instanceof Error ? e : new Error(String(e)))
            return
        }
        const processTree = new ManagedProcessTree(proc, {
            terminationGraceMs,
            pollIntervalMs: 25,
        })
        let assistantText = ""
        let stdoutBuffer = ""
        const eventTypesSeen: string[] = []
        let evaluatorToolUseSeen = false
        let timedOut = false
        let aborted = false
        let timer: ReturnType<typeof setTimeout> | null = null
        let forcedError: Error | null = null
        let finalized = false
        let treeRefreshed = false
        let rootExit: {
            code: number | null
            signal: NodeJS.Signals | null
        } | null = null

        const clearTimers = (): void => {
            if (timer !== null) {
                clearTimeout(timer)
                timer = null
            }
            opts.signal?.removeEventListener("abort", onAbort)
        }
        const refreshProcessTree = (): void => {
            if (treeRefreshed) return
            treeRefreshed = true
            processTree.refresh()
        }
        const finalizeAbnormalAfterTree = (): void => {
            void processTree.done.then(() => {
                proc.stdin?.destroy()
                proc.stdout?.destroy()
                proc.stderr?.destroy()
                const terminal = rootExit ?? { code: null, signal: null }
                finalizeExit(terminal.code, terminal.signal)
            })
        }
        const terminate = (): void => {
            processTree.terminate("SIGTERM")
            finalizeAbnormalAfterTree()
        }
        const onAbort = (): void => {
            if (aborted) return
            aborted = true
            terminate()
        }
        timer = setTimeout(() => {
            timedOut = true
            terminate()
        }, timeoutMs)
        timer.unref?.()
        opts.signal?.addEventListener("abort", onAbort, { once: true })
        // Close the race between the pre-spawn check and listener install.
        if (opts.signal?.aborted) onAbort()

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
                                `[${label}] usage: in=${numberForLog(usage.input)} out=${numberForLog(usage.output)}\n`,
                            )
                        }
                        if (!timedOut && !aborted) {
                            invocations.observe(piObservation(message, opts))
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
                    if (opts.safeEvaluatorSystemPrompt !== undefined) {
                        evaluatorToolUseSeen = true
                    }
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
                        if (opts.safeEvaluatorSystemPrompt !== undefined) {
                            evaluatorToolUseSeen = true
                        }
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
            refreshProcessTree()
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
            refreshProcessTree()
            const trimmed = chunk.trimEnd()
            if (trimmed) {
                process.stderr.write(`[${label}/stderr] ${trimmed}\n`)
            }
        })

        proc.on("error", (err) => {
            if (!timedOut && !aborted) forcedError ??= err
            if (proc.pid === undefined) processTree.markRootClosed()
            else processTree.terminate("SIGTERM")
            finalizeAbnormalAfterTree()
        })

        const finalizeExit = (
            code: number | null,
            signal: NodeJS.Signals | null,
        ): void => {
            if (finalized) return
            finalized = true
            clearTimers()
            const elapsedMs = Date.now() - startedAt

            const ctx = [
                `elapsed=${elapsedMs}ms`,
                `exit=${code}`,
                signal ? `signal=${signal}` : null,
                timedOut ? `timedOut=true (cap=${timeoutMs}ms)` : null,
                aborted ? "aborted=true" : null,
                `events=${eventTypesSeen.length}`,
                eventTypesSeen.length > 0
                    ? `event_types=[${[...new Set(eventTypesSeen)].join(",")}]`
                    : null,
            ]
                .filter((x): x is string => x !== null)
                .join(" ")

            if (forcedError) {
                if (
                    invocations.finish(
                        unknownPiObservation("failed", elapsedMs, opts),
                    )
                ) {
                    reject(forcedError)
                }
                return
            }

            // Abnormal termination must fail even if SOME text accumulated:
            // callers feed the string into a markdown/JSON extractor, so
            // partial text on timeout/crash would silently yield an
            // incomplete doc with no error surfaced.
            if (
                timedOut ||
                aborted ||
                signal != null ||
                (code != null && code !== 0)
            ) {
                if (
                    !invocations.finish(
                        unknownPiObservation(
                            timedOut || aborted ? "timed_out" : "failed",
                            elapsedMs,
                            opts,
                        ),
                    )
                ) {
                    return
                }
                if (aborted) {
                    reject(abortError())
                    return
                }
                reject(
                    new Error(
                        `runPiOneShot: pi terminated abnormally before completing (${ctx})`,
                    ),
                )
                return
            }

            if (
                opts.safeEvaluatorSystemPrompt !== undefined &&
                evaluatorToolUseSeen
            ) {
                if (
                    !invocations.finish(
                        unknownPiObservation("failed", elapsedMs, opts),
                    )
                ) {
                    return
                }
                reject(
                    new Error(
                        "runPiOneShot: safe evaluator attempted a tool call",
                    ),
                )
                return
            }

            if (assistantText.trim()) {
                if (
                    !invocations.finish(
                        unknownPiObservation("succeeded", elapsedMs, opts),
                    )
                ) {
                    return
                }
                resolve(assistantText)
                return
            }

            if (
                !invocations.finish(
                    unknownPiObservation("failed", elapsedMs, opts),
                )
            ) {
                return
            }
            reject(
                new Error(
                    `runPiOneShot: pi produced no text output (${ctx})`,
                ),
            )
        }

        proc.on("exit", (code, signal) => {
            rootExit = { code, signal }
            processTree.markRootClosed()
        })
        proc.on("close", (code, signal) => {
            rootExit ??= { code, signal }
            processTree.markRootClosed()
            const terminal = rootExit
            void processTree.done.then(() =>
                finalizeExit(terminal.code, terminal.signal),
            )
        })

        if (safeEvaluator) {
            if (!proc.stdin) {
                if (timer !== null) {
                    clearTimeout(timer)
                    timer = null
                }
                forcedError = new Error("pi subprocess stdin is unavailable")
                terminate()
                return
            }
            proc.stdin.on("error", (error) => {
                if (aborted || timedOut) return
                if (timer !== null) {
                    clearTimeout(timer)
                    timer = null
                }
                forcedError ??= error
                terminate()
            })
            proc.stdin.end(opts.prompt)
        }
    })
}

function abortError(): Error {
    const error = new Error("Pi one-shot aborted")
    error.name = "AbortError"
    return error
}

function piObservation(
    message: Record<string, unknown>,
    opts: RunPiOneShotOptions,
): UnsequencedRunnerInvocationObservation {
    const usage = record(message.usage)
    const cost = record(usage.cost)
    return {
        granularity: "turn",
        status: "succeeded",
        durationMs: unknownMetric("not_reported"),
        tokens: piTokenMetrics(usage),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd:
                firstMetric([
                    optionalMetric(usage, ["cost_usd", "costUsd"], "cli_result"),
                    optionalMetric(cost, ["total"], "cli_result"),
                ]) ?? unknownMetric("not_reported"),
        },
        provider: nonEmptyString(message.provider) ?? opts.provider ?? null,
        resolvedModel: nonEmptyString(message.model) ?? opts.model ?? null,
        providerRequestId:
            nonEmptyString(message.responseId) ??
            nonEmptyString(message.response_id),
    }
}

function unknownPiObservation(
    status: ModelInvocationStatus,
    elapsedMs: number,
    opts: RunPiOneShotOptions,
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
            cacheWriteInput: missing,
            outputTotal: missing,
            reasoningOutput: notApplicableMetric(),
            total: missing,
        },
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: missing,
        },
        provider: opts.provider ?? null,
        resolvedModel: opts.model ?? null,
        providerRequestId: null,
    }
}

function piTokenMetrics(usage: Record<string, unknown>): ModelTokenMetrics {
    const cache = record(usage.cache)
    const rawInput = metric(usage, ["input", "inputTokens", "input_tokens"])
    const cached =
        firstMetric([
            optionalMetric(
                usage,
                ["cacheRead", "cached_input_tokens", "cache_read_input_tokens"],
                "provider_response",
            ),
            optionalMetric(cache, ["read"], "provider_response"),
        ]) ?? unknownMetric("not_reported")
    const cacheWrite =
        firstMetric([
            optionalMetric(
                usage,
                ["cacheWrite", "cache_creation_input_tokens", "cache_write_input_tokens"],
                "provider_response",
            ),
            optionalMetric(cache, ["write"], "provider_response"),
        ]) ?? unknownMetric("not_reported")
    const output = metric(usage, ["output", "outputTokens", "output_tokens"])
    const inputTotal = sumKnown([rawInput, cached, cacheWrite])
    return {
        inputTotal,
        cachedInput: cached,
        cacheWriteInput: cacheWrite,
        outputTotal: output,
        // Pi exposes no separate reasoning token dimension.
        reasoningOutput: notApplicableMetric(),
        total:
            optionalMetric(
                usage,
                ["totalTokens", "total_tokens", "total"],
                "provider_response",
            ) ?? sumKnown([inputTotal, output]),
    }
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

function metric(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: "provider_response" | "cli_result" = "provider_response",
): Metric {
    for (const key of keys) {
        if (!(key in source) || source[key] == null) continue
        const value = source[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0
            ? knownMetric(value, metricSource)
            : unknownMetric("parse_error")
    }
    return unknownMetric("not_reported")
}

function optionalMetric(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: "provider_response" | "cli_result",
): Metric | null {
    return keys.some((key) => key in source && source[key] != null)
        ? metric(source, keys, metricSource)
        : null
}

function firstMetric(metrics: readonly (Metric | null)[]): Metric | null {
    return metrics.find((item): item is Metric => item !== null) ?? null
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
