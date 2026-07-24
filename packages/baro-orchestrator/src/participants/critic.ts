/**
 * Critic — live acceptance-criteria evaluator on the Claude CLI.
 *
 * The shared observer lifecycle (authority gating, replay dedup, evidence
 * preparation, Critique/corrective emission) lives in OneShotCritic; this
 * backend contributes the `claude --print` invocation, the CLI JSON wrapper
 * parsing, and runner telemetry extracted from that wrapper.
 *
 * Architectural note: Critic uses the Claude CLI subprocess (same auth path
 * as every other agent in this system) rather than the Anthropic SDK,
 * because that would fragment the auth model — Claude Code runs via OAuth
 * session, not via ANTHROPIC_API_KEY.
 *
 * Library-grade: no imports from prd.ts, story-agent.ts, or conductor.ts.
 */

import type { SpawnOptions } from "child_process"
import spawn from "cross-spawn"

import { harnessChildEnvironment } from "../harness-environment.js"
import { ModelInvocationMeasured } from "../semantic-events.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type MetricSource,
    type ModelCostMetrics,
    type ModelInvocationMeasuredData,
    type ModelInvocationStatus,
    type ModelTokenMetrics,
    type UnknownMetricReason,
} from "../model-telemetry.js"
import { withIsolatedCriticCwd } from "./critic-cli-isolation.js"
import {
    OneShotCritic,
    type OneShotCriticCoreOptions,
    type OneShotCriticEvaluation,
    type OneShotCriticInvocationContext,
} from "./critic-one-shot.js"
import { VERDICT_SYSTEM_PROMPT, extractVerdictJson } from "./critic-verdict.js"

export { buildEvalPrompt } from "./critic-evidence.js"
export {
    VERDICT_SYSTEM_PROMPT,
    buildCorrectiveMessage,
    extractVerdictJson,
    verdictSystemPrompt,
} from "./critic-verdict.js"

export interface CriticOptions extends OneShotCriticCoreOptions {
    /** Claude model used for verdict calls. Default: "haiku". */
    model?: string
    /** Path to the `claude` binary. Default: "claude" (resolved via PATH). */
    claudeBin?: string
}

interface CriticEvaluation extends OneShotCriticEvaluation {
    /** Optional only so existing test/subclass overrides remain compatible. */
    telemetry?: CriticEvaluationTelemetry
}

interface CriticEvaluationTelemetry {
    status: ModelInvocationStatus
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
}

export class Critic extends OneShotCritic {
    private readonly model: string
    private readonly claudeBin: string

    constructor(opts: CriticOptions) {
        super(
            { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
            {
                backend: "claude",
                defaultModelLabel: "haiku",
                errorLabel: "Critic",
            },
            opts.model ?? "haiku",
        )
        this.model = opts.model ?? "haiku"
        this.claudeBin = opts.claudeBin ?? "claude"
    }

    protected override async invoke(
        prompt: string,
        context: OneShotCriticInvocationContext,
    ): Promise<string> {
        const response = await execFileWithStdin(
            this.claudeBin,
            [
                "--print",
                "--output-format",
                "json",
                "--model",
                this.model,
                // The evidence and agent summary below are untrusted.
                // Critic is inference-only: disable every built-in tool,
                // project customisation, MCP server, slash command, and
                // persisted session before passing the user prompt.
                "--tools",
                "",
                "--safe-mode",
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{}}',
                "--no-session-persistence",
                "--system-prompt",
                VERDICT_SYSTEM_PROMPT,
                "--input-format",
                "text",
            ],
            prompt,
            {
                cwd: context.cwd,
                timeout: context.timeoutMs,
                maxBuffer: 4 * 1024 * 1024,
            },
        )
        return response.stdout
    }

    protected override async evaluate(
        prompt: string,
    ): Promise<CriticEvaluation> {
        let stdout: string
        try {
            stdout = await withIsolatedCriticCwd(async (cwd) =>
                this.invoke(prompt, {
                    cwd,
                    timeoutMs: this.timeoutMs,
                    onInvocation: () => {},
                }),
            )
        } catch (err) {
            const timedOut = isExecTimeout(err)
            return criticFailure(
                err,
                unknownClaudeTelemetry(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
            )
        }

        let wrapper: Record<string, unknown>
        try {
            // `claude --output-format json` returns one JSON object on stdout
            // with a `result` field containing the assistant's text answer
            // (per packages/baro-app/scripts/SPIKE-FINDINGS.md).
            const parsedWrapper: unknown = JSON.parse(stdout)
            if (!isRecord(parsedWrapper)) {
                throw new Error("claude returned a non-object JSON wrapper")
            }
            wrapper = parsedWrapper
        } catch (err) {
            return criticFailure(
                err,
                unknownClaudeTelemetry("failed", "parse_error"),
            )
        }

        if (wrapper.is_error === true || isErrorSubtype(wrapper.subtype)) {
            return criticFailure(
                new Error("claude returned an error result"),
                unknownClaudeTelemetry("failed", "not_reported"),
            )
        }

        // Once a well-formed, non-error wrapper exists the provider call
        // succeeded. Verdict parsing is deliberately separate: malformed
        // model output must fail closed without rewriting successful usage.
        const telemetry = claudeTelemetry(wrapper)
        try {
            const verdictText =
                typeof wrapper.result === "string" ? wrapper.result.trim() : ""
            if (!verdictText) {
                throw new Error("claude returned empty result")
            }

            const verdictJson = extractVerdictJson(verdictText)
            const parsed = JSON.parse(verdictJson) as {
                verdict: "pass" | "fail"
                reasoning: string
                violated_criteria: string[]
            }

            return {
                status: "evaluated",
                verdict: parsed.verdict === "pass" ? "pass" : "fail",
                reasoning: parsed.reasoning ?? "",
                violatedCriteria: Array.isArray(parsed.violated_criteria)
                    ? parsed.violated_criteria
                    : [],
                telemetry,
            }
        } catch (err) {
            return criticFailure(err, telemetry)
        }
    }

    // Telemetry is authoritative audit context for the verdict and must be
    // visible on the bus before the Critique it describes.
    protected override onEvaluationSettled(
        agentId: string,
        turn: number,
        evaluation: OneShotCriticEvaluation,
        preparationReady: boolean,
    ): void {
        if (!preparationReady) return
        const telemetry =
            (evaluation as CriticEvaluation).telemetry ??
            unknownClaudeTelemetry("succeeded", "not_reported")
        this.publishMeasurement(agentId, turn, telemetry)
    }

    private publishMeasurement(
        agentId: string,
        turn: number,
        telemetry: CriticEvaluationTelemetry,
    ): void {
        const invocationId = `${this.runId ?? "local"}:critic:${agentId}:${turn}`
        const data: ModelInvocationMeasuredData = {
            schemaVersion: 1,
            measurementId: `${invocationId}:runner`,
            invocationId,
            runId: this.runId ?? null,
            phase: "critic",
            storyId: agentId,
            attempt: null,
            turn,
            round: null,
            backend: "claude",
            // Claude CLI may be configured for Anthropic, Bedrock, or Vertex;
            // the wrapper does not independently identify the upstream.
            provider: null,
            requestedModel: this.model,
            resolvedModel: this.model,
            status: telemetry.status,
            durationMs: telemetry.durationMs,
            tokens: telemetry.tokens,
            cost: telemetry.cost,
            evidence: {
                producer: "runner",
                // A Claude session ID resumes a conversation; it is not a
                // provider request/charge identifier and must not be reused.
                providerRequestId: null,
                rateCardVersion: null,
                granularity: "process",
            },
        }
        const event = ModelInvocationMeasured.create(data)
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}

/**
 * Claude print mode accepts a plain-text prompt on stdin. Keeping the bounded
 * evidence payload out of argv is required on Windows, where CreateProcess
 * limits the entire command line to roughly 32 KiB while Critic prompts can
 * reach 90K characters.
 */
function execFileWithStdin(
    file: string,
    args: string[],
    input: string,
    options: { cwd: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            cwd: options.cwd,
            env: harnessChildEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
        } as SpawnOptions)

        let stdout = ""
        let stderr = ""
        let stdoutBytes = 0
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const finish = (fn: () => void): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            fn()
        }

        if (options.timeout > 0) {
            timer = setTimeout(() => {
                child.kill("SIGTERM")
                finish(() => {
                    const error = new Error(
                        `${file} timed out after ${options.timeout}ms`,
                    ) as Error & { killed: boolean }
                    error.killed = true
                    reject(error)
                })
            }, options.timeout)
        }

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString()
            stdoutBytes += chunk.byteLength
            if (stdoutBytes > options.maxBuffer) {
                child.kill("SIGTERM")
                finish(() =>
                    reject(new Error(`${file} stdout exceeded maxBuffer`)),
                )
            }
        })
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString()
        })
        child.on("error", (error) => finish(() => reject(error)))
        child.on("close", (code) => {
            finish(() => {
                if (code === 0) {
                    resolve({ stdout, stderr })
                    return
                }
                const error = new Error(
                    `${file} exited with code ${code}\n${stderr}`,
                ) as Error & {
                    code: number | null
                    stdout: string
                    stderr: string
                }
                error.code = code
                error.stdout = stdout
                error.stderr = stderr
                reject(error)
            })
        })

        if (!child.stdin) {
            child.kill()
            finish(() =>
                reject(new Error("claude subprocess stdin is unavailable")),
            )
            return
        }
        child.stdin.on("error", (error) => {
            child.kill()
            finish(() => reject(error))
        })
        child.stdin.end(input)
    })
}

function criticFailure(
    err: unknown,
    telemetry: CriticEvaluationTelemetry,
): CriticEvaluation {
    return {
        status: "inconclusive",
        verdict: "fail",
        reasoning: `Critic LLM call failed: ${String((err as Error)?.message ?? err)}`,
        violatedCriteria: ["[critic error — could not evaluate]"],
        telemetry,
    }
}

function claudeTelemetry(
    wrapper: Record<string, unknown>,
): CriticEvaluationTelemetry {
    const usage = isRecord(wrapper.usage) ? wrapper.usage : null
    const tokens = usage
        ? claudeTokenMetrics(usage)
        : unknownClaudeTokens(
              wrapper.usage == null ? "not_reported" : "parse_error",
          )

    return {
        status: "succeeded",
        durationMs: metricFromKeys(
            wrapper,
            ["duration_ms"],
            "cli_result",
        ),
        tokens,
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: metricFromKeys(
                wrapper,
                ["total_cost_usd"],
                "cli_result",
            ),
        },
    }
}

function claudeTokenMetrics(
    usage: Record<string, unknown>,
): ModelTokenMetrics {
    const cache = isRecord(usage.cache) ? usage.cache : null
    const rawInput = metricFromKeys(
        usage,
        ["input_tokens", "inputTokens"],
        "provider_response",
    )
    const cachedInput = firstReportedMetric([
        metricFromKeysOptional(
            usage,
            ["cache_read_input_tokens", "cached_input_tokens"],
            "provider_response",
        ),
        cache
            ? metricFromKeysOptional(cache, ["read"], "provider_response")
            : null,
    ])
    const cacheWriteInput = firstReportedMetric([
        metricFromKeysOptional(
            usage,
            ["cache_creation_input_tokens", "cache_write_input_tokens"],
            "provider_response",
        ),
        cache
            ? metricFromKeysOptional(cache, ["write"], "provider_response")
            : null,
    ])
    const outputTotal = metricFromKeys(
        usage,
        ["output_tokens", "outputTokens"],
        "provider_response",
    )
    const inputTotal = sumMetrics([rawInput, cachedInput, cacheWriteInput])
    const reportedTotal = metricFromKeysOptional(
        usage,
        ["total_tokens", "totalTokens"],
        "provider_response",
    )

    return {
        inputTotal,
        cachedInput,
        cacheWriteInput,
        outputTotal,
        reasoningOutput: notApplicableMetric(),
        total: reportedTotal ?? sumMetrics([inputTotal, outputTotal]),
    }
}

function unknownClaudeTelemetry(
    status: ModelInvocationStatus,
    reason: UnknownMetricReason,
): CriticEvaluationTelemetry {
    return {
        status,
        durationMs: unknownMetric(reason),
        tokens: unknownClaudeTokens(reason),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: unknownMetric(reason),
        },
    }
}

function unknownClaudeTokens(reason: UnknownMetricReason): ModelTokenMetrics {
    return {
        inputTotal: unknownMetric(reason),
        cachedInput: unknownMetric(reason),
        cacheWriteInput: unknownMetric(reason),
        outputTotal: unknownMetric(reason),
        reasoningOutput: notApplicableMetric(),
        total: unknownMetric(reason),
    }
}

function metricFromKeys(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
): Metric {
    return (
        metricFromKeysOptional(source, keys, metricSource) ??
        unknownMetric("not_reported")
    )
}

function metricFromKeysOptional(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
): Metric | null {
    for (const key of keys) {
        if (!(key in source) || source[key] == null) continue
        const value = source[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0
            ? knownMetric(value, metricSource)
            : unknownMetric("parse_error")
    }
    return null
}

function firstReportedMetric(metrics: readonly (Metric | null)[]): Metric {
    return (
        metrics.find((metric): metric is Metric => metric !== null) ??
        unknownMetric("not_reported")
    )
}

function sumMetrics(metrics: readonly Metric[]): Metric {
    if (metrics.every((metric) => metric.state === "known")) {
        return knownMetric(
            metrics.reduce(
                (sum, metric) =>
                    sum + (metric.state === "known" ? metric.value : 0),
                0,
            ),
            "derived",
        )
    }
    const unknown = metrics.find((metric) => metric.state === "unknown")
    return unknown?.state === "unknown"
        ? unknownMetric(unknown.reason)
        : unknownMetric("not_reported")
}

function isExecTimeout(error: unknown): boolean {
    return isRecord(error) && error.killed === true
}

function isErrorSubtype(value: unknown): boolean {
    return typeof value === "string" && value.toLowerCase().startsWith("error")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
