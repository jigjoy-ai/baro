/**
 * One-shot `opencode run --format json` against a combined prompt; returns
 * the concatenated assistant text. Uses spawn() + streaming rather than
 * execFile() because execFile discards stdout on timeout — streaming keeps
 * the live stderr audit trail and allows a gentler SIGTERM.
 */

import { ChildProcess } from "child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import spawn from "cross-spawn"

import { harnessChildEnvironment } from "./harness-environment.js"

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

export interface RunOpenCodeOneShotOptions {
    /** Combined system+user prompt. Safe evaluators pipe it over stdin. */
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
    /** Optional invocation telemetry sink. It cannot alter runner success. */
    onInvocation?: RunnerInvocationObserver
    /**
     * Critic-only hardening. Installs a local, deny-all agent whose prompt is
     * this real system prompt, disables plugins, and rejects any tool event.
     * The caller must provide a fresh empty cwd. Other callers are unchanged.
     */
    safeEvaluatorSystemPrompt?: string
}

/**
 * Collects assistant text from `text` events; throws if the process exits
 * without producing any. Legacy callers run with
 * `--dangerously-skip-permissions`; safe evaluators use a deny-all agent.
 */
export async function runOpenCodeOneShot(
    opts: RunOpenCodeOneShotOptions,
): Promise<string> {
    const label = opts.label ?? "opencode"
    const safeEvaluator = opts.safeEvaluatorSystemPrompt !== undefined
    const safeConfig = safeEvaluator
        ? await installSafeEvaluatorAgent(
              opts.cwd,
              opts.safeEvaluatorSystemPrompt!,
          )
        : null

    const args = ["run", "--format", "json"]
    if (safeEvaluator) {
        args.push("--pure", "--agent", "baro-critic")
    } else {
        args.push("--dangerously-skip-permissions")
    }
    if (opts.model) args.push("-m", opts.model)
    if (opts.cwd) args.push("--dir", opts.cwd)
    if (!safeEvaluator) args.push(opts.prompt)

    const timeoutMs = opts.timeoutMs ?? 600_000

    return await new Promise<string>((resolve, reject) => {
        const startedAt = Date.now()
        const invocations = new RunnerInvocationTracker(opts.onInvocation)
        let proc: ChildProcess
        try {
            const childEnvironment = harnessChildEnvironment()
            proc = spawn(opts.opencodeBin ?? "opencode", args, {
                cwd: opts.cwd,
                env: safeConfig
                    ? {
                          ...childEnvironment,
                          // Pin both supported config injection paths so an
                          // inherited OPENCODE_CONFIG(_CONTENT) cannot replace
                          // the deny-all Critic agent after project discovery.
                          OPENCODE_CONFIG: safeConfig.path,
                          OPENCODE_CONFIG_CONTENT: safeConfig.content,
                      }
                    : childEnvironment,
                stdio: [safeEvaluator ? "pipe" : "ignore", "pipe", "pipe"],
            })
        } catch (e) {
            invocations.finish(
                unknownOpenCodeObservation(
                    "failed",
                    Date.now() - startedAt,
                    opts,
                ),
            )
            reject(e instanceof Error ? e : new Error(String(e)))
            return
        }

        let assistantText = ""
        let stdoutBuffer = ""
        const eventTypesSeen: string[] = []
        let evaluatorToolUseSeen = false
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

                if (type === "step_finish") {
                    const part = record(event.part)
                    const tokens = record(part.tokens)
                    if (Object.keys(tokens).length > 0) {
                        process.stderr.write(
                            `[${label}] usage: in=${numberForLog(tokens.input)} out=${numberForLog(tokens.output)}\n`,
                        )
                    }
                    if (!timedOut) {
                        invocations.observe(openCodeObservation(event, opts))
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
                    if (safeEvaluator) evaluatorToolUseSeen = true
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
            if (
                !invocations.finish(
                    unknownOpenCodeObservation(
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
                if (
                    !invocations.finish(
                        unknownOpenCodeObservation(
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
                        `runOpenCodeOneShot: opencode terminated abnormally before completing (${ctx})`,
                    ),
                )
                return
            }

            if (safeEvaluator && evaluatorToolUseSeen) {
                if (
                    !invocations.finish(
                        unknownOpenCodeObservation("failed", elapsedMs, opts),
                    )
                ) {
                    return
                }
                reject(
                    new Error(
                        "runOpenCodeOneShot: safe evaluator attempted a tool call",
                    ),
                )
                return
            }

            if (assistantText.trim()) {
                if (
                    !invocations.finish(
                        unknownOpenCodeObservation(
                            "succeeded",
                            elapsedMs,
                            opts,
                        ),
                    )
                ) {
                    return
                }
                resolve(assistantText)
                return
            }

            if (
                !invocations.finish(
                    unknownOpenCodeObservation("failed", elapsedMs, opts),
                )
            ) {
                return
            }
            reject(
                new Error(
                    `runOpenCodeOneShot: opencode produced no text output (${ctx})`,
                ),
            )
        })

        if (safeEvaluator) {
            if (!proc.stdin) {
                proc.kill()
                invocations.finish(
                    unknownOpenCodeObservation(
                        "failed",
                        Date.now() - startedAt,
                        opts,
                    ),
                )
                reject(new Error("opencode subprocess stdin is unavailable"))
                return
            }
            proc.stdin.on("error", (error) => {
                proc.kill()
                if (
                    invocations.finish(
                        unknownOpenCodeObservation(
                            "failed",
                            Date.now() - startedAt,
                            opts,
                        ),
                    )
                ) {
                    reject(error)
                }
            })
            proc.stdin.end(opts.prompt)
        }
    })
}

async function installSafeEvaluatorAgent(
    cwd: string,
    systemPrompt: string,
): Promise<{ path: string; content: string }> {
    const disabledTools = Object.fromEntries(
        [
            "bash",
            "read",
            "edit",
            "write",
            "glob",
            "grep",
            "webfetch",
            "task",
            "todowrite",
            "websearch",
            "lsp",
            "skill",
        ].map((name) => [name, false]),
    )
    const config = {
        agent: {
            "baro-critic": {
                description: "Baro inference-only acceptance evaluator",
                mode: "primary",
                prompt: systemPrompt,
                tools: disabledTools,
                permission: { "*": "deny" },
            },
        },
    }
    const path = join(cwd, "opencode.json")
    const content = `${JSON.stringify(config)}\n`

    // `wx` deliberately fails closed if a caller accidentally points the
    // supposedly isolated evaluator at a real project with its own config.
    await writeFile(
        path,
        content,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
    )
    return { path, content }
}

function openCodeObservation(
    event: Record<string, unknown>,
    opts: RunOpenCodeOneShotOptions,
): UnsequencedRunnerInvocationObservation {
    const part = record(event.part)
    return {
        granularity: "round",
        status: "succeeded",
        durationMs: unknownMetric("not_reported"),
        tokens: openCodeTokenMetrics(record(part.tokens)),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: metric(part, "cost", "cli_result"),
        },
        provider:
            nonEmptyString(part.providerID) ?? providerFromModel(opts.model),
        resolvedModel:
            nonEmptyString(part.modelID) ?? modelFromModel(opts.model),
        // sessionID is an OpenCode harness session, not a provider request.
        providerRequestId: null,
    }
}

function unknownOpenCodeObservation(
    status: ModelInvocationStatus,
    elapsedMs: number,
    opts: RunOpenCodeOneShotOptions,
): UnsequencedRunnerInvocationObservation {
    const reason = status === "timed_out" ? "timed_out" : "not_reported"
    const missing = unknownMetric(reason)
    return {
        granularity: "round",
        status,
        durationMs: knownMetric(elapsedMs, "cli_result"),
        tokens: {
            inputTotal: missing,
            cachedInput: missing,
            cacheWriteInput: missing,
            outputTotal: missing,
            reasoningOutput: missing,
            total: missing,
        },
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: missing,
        },
        provider: providerFromModel(opts.model),
        resolvedModel: modelFromModel(opts.model),
        providerRequestId: null,
    }
}

function openCodeTokenMetrics(usage: Record<string, unknown>): ModelTokenMetrics {
    const cache = record(usage.cache)
    const rawInput = metric(usage, "input", "provider_response")
    const cached = metric(cache, "read", "provider_response")
    const cacheWrite = metric(cache, "write", "provider_response")
    const rawOutput = metric(usage, "output", "provider_response")
    const reasoning = metric(usage, "reasoning", "provider_response")
    const inputTotal = sumKnown([rawInput, cached, cacheWrite])
    const outputTotal = sumKnown([rawOutput, reasoning])
    return {
        inputTotal,
        cachedInput: cached,
        cacheWriteInput: cacheWrite,
        outputTotal,
        reasoningOutput: reasoning,
        total:
            optionalMetric(usage, "total", "provider_response") ??
            sumKnown([inputTotal, outputTotal]),
    }
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

function metric(
    source: Record<string, unknown>,
    key: string,
    metricSource: "provider_response" | "cli_result",
): Metric {
    if (!(key in source) || source[key] == null) {
        return unknownMetric("not_reported")
    }
    const value = source[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? knownMetric(value, metricSource)
        : unknownMetric("parse_error")
}

function optionalMetric(
    source: Record<string, unknown>,
    key: string,
    metricSource: "provider_response" | "cli_result",
): Metric | null {
    return key in source && source[key] != null
        ? metric(source, key, metricSource)
        : null
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

function providerFromModel(model: string | undefined): string | null {
    if (!model?.includes("/")) return null
    return nonEmptyString(model.slice(0, model.indexOf("/")))
}

function modelFromModel(model: string | undefined): string | null {
    if (!model) return null
    if (!model.includes("/")) return model
    return nonEmptyString(model.slice(model.indexOf("/") + 1))
}

function numberForLog(value: unknown): number | "?" {
    return typeof value === "number" && Number.isFinite(value) ? value : "?"
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}
