/**
 * Critic — live acceptance-criteria evaluator.
 *
 * Observes AgentResultItem events on the bus. For each watched agent that
 * completes a turn without error, the Critic spawns a short-lived
 * `claude --print --model <haiku-default>` subprocess to ask whether the
 * output satisfies the agent's acceptance criteria.
 *
 * The verdict is *always* published as a CritiqueItem (audit trail). On
 * "fail", an AgentTargetedMessageItem is emitted back to the agent as its
 * next conversational turn — up to `maxEmissionsPerAgent` times, after which
 * corrective messages are suppressed but CritiqueItem-s keep accumulating.
 *
 * Architectural note: Critic uses the Claude CLI subprocess (same auth path
 * as every other agent in this system). It does NOT call the Anthropic SDK
 * directly because that would fragment the auth model — Claude Code runs
 * via OAuth session, not via ANTHROPIC_API_KEY. The CLI subprocess inherits
 * whatever auth `claude` is configured with, so Critic just works wherever
 * `claude` does.
 *
 * Library-grade: no imports from prd.ts, story-agent.ts, or conductor.ts.
 */

import { execFile } from "child_process"
import { promisify } from "util"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    AgentTargetedMessage,
    Critique,
    ModelInvocationMeasured,
} from "../semantic-events.js"
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
import { criticInput } from "./critic-input.js"

const execFileAsync = promisify(execFile)

export const VERDICT_SYSTEM_PROMPT = `\
You are a strict acceptance-criteria evaluator. You will receive:
1. A list of acceptance criteria that must ALL be satisfied.
2. The output text produced by an agent.

Evaluate whether every criterion is fully satisfied by the output.
Respond ONLY with a JSON object — no prose, no markdown fences — in exactly this shape:
{"verdict":"pass","reasoning":"…","violated_criteria":[]}
or
{"verdict":"fail","reasoning":"…","violated_criteria":["criterion A","criterion B"]}

Rules:
- "verdict" must be "pass" or "fail".
- "reasoning" must be a concise explanation (≤ 200 words).
- "violated_criteria" must list the exact criterion strings that are NOT satisfied.
- If ALL criteria pass, "violated_criteria" must be an empty array.
- Do NOT include any text outside the JSON object.`

export interface CriticOptions {
    /** Map from agentId to its acceptance-criteria strings. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Max corrective AgentTargetedMessageItem-s per agent. Default: 2. */
    maxEmissionsPerAgent?: number
    /** Claude model used for verdict calls. Default: "haiku". */
    model?: string
    /** Path to the `claude` binary. Default: "claude" (resolved via PATH). */
    claudeBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 60_000. */
    timeoutMs?: number
    /** Run correlation used by model-invocation telemetry. */
    runId?: string
}

interface CriticEvaluation {
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: string[]
    /** Optional only so existing test/subclass overrides remain compatible. */
    telemetry?: CriticEvaluationTelemetry
}

interface CriticEvaluationTelemetry {
    status: ModelInvocationStatus
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
}

export class Critic extends BaseObserver {
    private readonly opts: Required<Omit<CriticOptions, "runId">> & {
        runId?: string
    }
    /** agentId → number of AgentTargetedMessageItem-s emitted so far. */
    private readonly emissions = new Map<string, number>()
    /** agentId → number of result turns seen (for CritiqueItem.turn). */
    private readonly turnCount = new Map<string, number>()
    private readonly seenTerminalIds = new Set<string>()
    /**
     * Critic's evaluate() spawns an async `claude --print` subprocess.
     * Mozaik's deliverContextItem fan-out doesn't await onContextItem's
     * returned promise, so we track in-flight evaluations here and let
     * callers (e.g. orchestrate()) await `idle()` before tearing down.
     */
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: CriticOptions) {
        super()
        this.opts = {
            maxEmissionsPerAgent: opts.maxEmissionsPerAgent ?? 2,
            model: opts.model ?? "haiku",
            claudeBin: opts.claudeBin ?? "claude",
            timeoutMs: opts.timeoutMs ?? 60_000,
            targets: opts.targets,
            runId: opts.runId,
        }
    }

    /** Resolves once every in-flight evaluation has emitted its CritiqueItem. */
    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        const input = criticInput(event)
        if (!input) return
        const { agentId, isError, resultText, canContinue, terminalId } = input
        if (isError || !resultText) return

        const criteria = this.opts.targets.get(agentId)
        if (!criteria || criteria.length === 0) return
        if (terminalId) {
            if (this.seenTerminalIds.has(terminalId)) return
            this.seenTerminalIds.add(terminalId)
        }

        const turn = (this.turnCount.get(agentId) ?? 0) + 1
        this.turnCount.set(agentId, turn)

        const work = (async () => {
            const evaluation = await this.evaluate(
                resultText,
                criteria,
            )
            const { verdict, reasoning, violatedCriteria } = evaluation

            // Telemetry is authoritative audit context for the verdict and
            // must be visible on the bus before the Critique it describes.
            this.publishMeasurement(
                agentId,
                turn,
                evaluation.telemetry ?? unknownClaudeTelemetry("succeeded", "not_reported"),
            )

            // Always emit audit trail.
            const critiqueEvent = Critique.create({
                agentId,
                verdict,
                reasoning,
                violatedCriteria,
                turn,
                modelUsed: this.opts.model,
            })
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, critiqueEvent)
            }

            // Emit corrective message only on fail and under the per-agent cap.
            if (verdict === "fail" && canContinue) {
                const emitted = this.emissions.get(agentId) ?? 0
                if (emitted < this.opts.maxEmissionsPerAgent) {
                    this.emissions.set(agentId, emitted + 1)
                    const text = buildCorrectiveMessage(reasoning, violatedCriteria)
                    const msg = AgentTargetedMessage.create({
                        recipientId: agentId,
                        text,
                        metadata: {
                            criticTurn: turn,
                            emissionIndex: emitted + 1,
                        },
                    })
                    for (const env of this.getEnvironments()) {
                        env.deliverSemanticEvent(this, msg)
                    }
                }
            }
        })()

        this.pending.add(work)
        work.finally(() => {
            this.pending.delete(work)
        })

        await work
    }

    private publishMeasurement(
        agentId: string,
        turn: number,
        telemetry: CriticEvaluationTelemetry,
    ): void {
        const invocationId = `${this.opts.runId ?? "local"}:critic:${agentId}:${turn}`
        const data: ModelInvocationMeasuredData = {
            schemaVersion: 1,
            measurementId: `${invocationId}:runner`,
            invocationId,
            runId: this.opts.runId ?? null,
            phase: "critic",
            storyId: agentId,
            attempt: null,
            turn,
            round: null,
            backend: "claude",
            // Claude CLI may be configured for Anthropic, Bedrock, or Vertex;
            // the wrapper does not independently identify the upstream.
            provider: null,
            requestedModel: this.opts.model,
            resolvedModel: this.opts.model,
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

    private async evaluate(
        resultText: string,
        criteria: readonly string[],
    ): Promise<CriticEvaluation> {
        const prompt = buildEvalPrompt(criteria, resultText)

        let stdout: string
        try {
            const response = await execFileAsync(
                this.opts.claudeBin,
                [
                    "--print",
                    "--output-format",
                    "json",
                    "--model",
                    this.opts.model,
                    "--permission-mode",
                    "bypassPermissions",
                    "--system-prompt",
                    VERDICT_SYSTEM_PROMPT,
                    "-p",
                    prompt,
                ],
                {
                    timeout: this.opts.timeoutMs,
                    maxBuffer: 4 * 1024 * 1024,
                },
            )
            stdout = response.stdout
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
}

function criticFailure(
    err: unknown,
    telemetry: CriticEvaluationTelemetry,
): CriticEvaluation {
    return {
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

export function buildEvalPrompt(
    criteria: readonly string[],
    resultText: string,
): string {
    const criteriaList = criteria
        .map((c, i) => `${i + 1}. ${c}`)
        .join("\n")
    return [
        "## Acceptance criteria",
        criteriaList,
        "",
        "## Agent output",
        resultText,
    ].join("\n")
}

export function buildCorrectiveMessage(
    reasoning: string,
    violatedCriteria: string[],
): string {
    const lines: string[] = [
        "Your output did not satisfy all acceptance criteria. Please revise.",
        "",
        `**Reasoning:** ${reasoning}`,
    ]
    if (violatedCriteria.length > 0) {
        lines.push("", "**Violated criteria:**")
        for (const c of violatedCriteria) {
            lines.push(`- ${c}`)
        }
    }
    lines.push("", "Please address the above and resubmit your work.")
    return lines.join("\n")
}

/**
 * Claude's response to the verdict prompt should be just the JSON object,
 * but the model occasionally wraps it in a markdown fence or adds a
 * leading/trailing sentence even with strict instructions. Tolerate that
 * by extracting the first balanced `{...}` block.
 */
export function extractVerdictJson(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return trimmed
    }
    const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fenceMatch) {
        return fenceMatch[1]!
    }
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(`no JSON object found in critic response: ${trimmed.slice(0, 200)}`)
    }
    let depth = 0
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (ch === "{") depth += 1
        else if (ch === "}") {
            depth -= 1
            if (depth === 0) {
                return trimmed.slice(start, i + 1)
            }
        }
    }
    throw new Error(`unbalanced JSON object in critic response: ${trimmed.slice(0, 200)}`)
}
