/**
 * Claude-lane Surgeon: drives `claude --print` (or the deterministic
 * fallback) over the shared recovery leaf in execution/surgeon.ts.
 */

import { execFileCli } from "../exec-file-cli.js"
import { ClaudeStreamResultCollector } from "./stream-result.js"

import { BaseObserver, Participant, SemanticEvent } from "../../runtime/mozaik.js"

import { harnessChildEnvironment } from "../environment.js"
import {
    Critique,
    type CritiqueData,
    ModelInvocationMeasured,
    RecoveryDecision,
    RecoveryEvaluationStarted,
    Replan,
    type ReplanData,
    type ReplanStoryAdd,
    type StoryResultData,
} from "../../semantic-events.js"
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
} from "../../telemetry/model-telemetry.js"
import { ActiveLeaseRegistry } from "../../runtime/active-lease-registry.js"
import { RecoverySourceAuthority } from "../../runtime/recovery-source-authority.js"
import type { StoryOutcomeAuthority } from "../../runtime/story-outcome-authority.js"
import {
    correlateRecoveryReplan,
    recoveryInput,
} from "../../execution/recovery-input.js"
import {
    CritiqueLog,
    SURGEON_SYSTEM_PROMPT,
    buildSurgeonPrompt,
    extractJsonObject,
    surgeonDeterministicReplan,
    type PrdSnapshot,
    type RouteDescriber,
} from "../../execution/surgeon.js"

export interface SurgeonOptions {
    /** Returns a fresh snapshot of the current PRD. */
    snapshot: () => PrdSnapshot
    /** Describes the model a story actually ran on (see RouteDescriber). */
    resolveRoute?: RouteDescriber
    /** Exact routing selector for escalating a right-sized story (`heavy`
     * under tier routing, otherwise an explicit backend:model). */
    escalationRoute?: string
    /** Use Claude CLI to evaluate replans. Default: false (deterministic). */
    useLlm?: boolean
    /** Model for LLM evaluations. Default: "opus". */
    model?: string
    /** Max replans this Surgeon will emit per run. Default: 10. */
    maxReplans?: number
    /** Path to the `claude` binary. Default: "claude". */
    claudeBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 90_000. */
    timeoutMs?: number
    runId?: string
    emitRecoveryDecisions?: boolean
    /** Collective-only dynamic authority for terminal execution results. */
    outcomeAuthority?: StoryOutcomeAuthority
}

interface SurgeonLlmEvaluation {
    replan: ReplanData | null
    telemetry: SurgeonLlmTelemetry
}

interface SurgeonLlmTelemetry {
    status: ModelInvocationStatus
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
}

export class Surgeon extends BaseObserver {
    private readonly opts: Required<
        Pick<
            SurgeonOptions,
            "useLlm" | "model" | "maxReplans" | "claudeBin" | "timeoutMs"
        >
    > &
        SurgeonOptions

    private replansEmitted = 0
    /** Monotonic correlation for legacy failures that have no lease generation. */
    private evaluationSequence = 0
    private readonly pending = new Set<Promise<void>>()
    private readonly critiques = new CritiqueLog()
    private readonly leases = new ActiveLeaseRegistry()
    private readonly sources: RecoverySourceAuthority

    constructor(opts: SurgeonOptions) {
        super()
        this.sources = new RecoverySourceAuthority(opts.outcomeAuthority)
        this.opts = {
            useLlm: opts.useLlm ?? true,
            model: opts.model ?? "opus",
            maxReplans: opts.maxReplans ?? Infinity,
            claudeBin: opts.claudeBin ?? "claude",
            timeoutMs: opts.timeoutMs ?? 90_000,
            snapshot: opts.snapshot,
            resolveRoute: opts.resolveRoute,
            escalationRoute: opts.escalationRoute,
            runId: opts.runId,
            emitRecoveryDecisions: opts.emitRecoveryDecisions,
        }
    }

    /** Resolves once every in-flight LLM evaluation has completed. */
    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    setLeaseAuthority(authority: Participant): void {
        this.sources.setLeaseAuthority(authority)
    }

    setQualityAuthority(authority: Participant): void {
        this.sources.setQualityAuthority(authority)
    }

    setBlockAuthority(authority: Participant): void {
        this.sources.setBlockAuthority(authority)
    }

    setCriticAuthority(authority: Participant): void {
        this.sources.setCriticAuthority(authority)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (this.sources.observeLease(source, event, this.leases, this.opts.runId)) return
        if (!this.sources.accepts(source, event)) return
        this.critiques.record(event)
        const failure = recoveryInput(event)
        if (!failure) return
        if (
            this.opts.emitRecoveryDecisions &&
            !this.leases.consumeResult(failure, this.opts.runId)
        ) return
        if (this.replansEmitted >= this.opts.maxReplans) {
            this.emitRecoveryDecision(failure, "abort", "replan budget exhausted")
            return
        }

        this.emitRecoveryStarted(failure)

        const work = (async () => {
            try {
                let replan: ReplanData | null
                if (this.opts.useLlm) {
                    const sequence = ++this.evaluationSequence
                    const evaluation = await this.evaluateWithLlm(failure)
                    this.publishMeasurement(failure, sequence, evaluation.telemetry)
                    replan = evaluation.replan
                } else {
                    replan = this.evaluateDeterministic(failure)
                }
                if (!replan) {
                    this.emitRecoveryDecision(failure, "abort", "surgeon chose abort")
                    return
                }
                this.replansEmitted += 1
                for (const env of this.getEnvironments()) {
                    env.deliverSemanticEvent(
                        this,
                        Replan.create(correlateRecoveryReplan(replan, failure)),
                    )
                }
                this.emitRecoveryDecision(failure, "replan", replan.reason)
            } catch (error) {
                this.emitRecoveryDecision(
                    failure,
                    "abort",
                    `surgeon failed: ${(error as Error)?.message ?? String(error)}`,
                )
            }
        })()

        this.pending.add(work)
        work.finally(() => this.pending.delete(work))
        await work
    }

    private publishMeasurement(
        failure: StoryResultData,
        sequence: number,
        telemetry: SurgeonLlmTelemetry,
    ): void {
        const runId = this.opts.runId ?? failure.runId ?? null
        const correlation = failure.generation == null
            ? `evaluation-${sequence}`
            : `generation-${failure.generation}`
        const invocationId = `${runId ?? "local"}:surgeon:${failure.storyId}:${correlation}`
        const data: ModelInvocationMeasuredData = {
            schemaVersion: 1,
            measurementId: `${invocationId}:runner`,
            invocationId,
            runId,
            phase: "surgeon",
            storyId: failure.storyId,
            attempt: null,
            turn: sequence,
            round: null,
            backend: "claude",
            // Claude CLI may route through Anthropic, Bedrock, or Vertex.
            provider: null,
            requestedModel: this.opts.model,
            resolvedModel: this.opts.model,
            status: telemetry.status,
            durationMs: telemetry.durationMs,
            tokens: telemetry.tokens,
            cost: telemetry.cost,
            evidence: {
                producer: "runner",
                // session_id is resumable conversation state, not a provider
                // request/charge identifier, so it is intentionally omitted.
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

    private emitRecoveryStarted(failure: StoryResultData): void {
        if (!this.opts.emitRecoveryDecisions || !this.opts.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(
                this,
                RecoveryEvaluationStarted.create({
                    runId: this.opts.runId,
                    storyId: failure.storyId,
                    source: "surgeon:claude",
                }),
            )
        }
    }

    private emitRecoveryDecision(
        failure: StoryResultData,
        action: "replan" | "abort",
        reason: string,
    ): void {
        if (!this.opts.emitRecoveryDecisions || !this.opts.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(
                this,
                RecoveryDecision.create({
                    runId: this.opts.runId,
                    storyId: failure.storyId,
                    source: "surgeon:claude",
                    action,
                    reason,
                }),
            )
        }
    }

    /**
     * Deterministic strategy: emit a "skip" — remove the failing story
     * so its dependents either run unblocked (if they had multiple
     * deps) or get cascade-removed by buildDag's cycle-detection
     * skipping (if their only dep is now gone, they become unreachable).
     */
    private evaluateDeterministic(failure: StoryResultData): ReplanData {
        return surgeonDeterministicReplan(failure)
    }

    /**
     * LLM strategy: ask Claude (via CLI subprocess) to propose a replan
     * grounded in the PRD snapshot + failure reason. Falls back to
     * deterministic on parsing or subprocess error.
     */
    private async evaluateWithLlm(
        failure: StoryResultData,
    ): Promise<SurgeonLlmEvaluation> {
        const snap = this.opts.snapshot()
        const prompt = buildSurgeonPrompt(
            snap,
            failure,
            this.opts.resolveRoute,
            this.opts.escalationRoute,
            this.critiques.forStory(failure.storyId),
        )

        let stdout: string
        try {
            const collector = new ClaudeStreamResultCollector()
            await execFileCli(
                this.opts.claudeBin,
                [
                    "--print",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--model",
                    this.opts.model,
                    "--permission-mode",
                    "bypassPermissions",
                    "--system-prompt",
                    SURGEON_SYSTEM_PROMPT,
                    "-p",
                    prompt,
                ],
                {
                    env: harnessChildEnvironment(),
                    timeout: this.opts.timeoutMs,
                    idleTimeoutMs: this.opts.timeoutMs,
                    maxBuffer: 4 * 1024 * 1024,
                    onStdoutData: (chunk) => collector.feed(chunk),
                },
            )
            stdout = collector.resultLine() ?? ""
        } catch (err) {
            const timedOut = isExecTimeout(err)
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                err,
                unknownClaudeTelemetry(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
            )
        }

        let wrapper: Record<string, unknown>
        try {
            const parsedWrapper: unknown = JSON.parse(stdout)
            if (!isRecord(parsedWrapper)) {
                throw new Error("claude returned a non-object JSON wrapper")
            }
            wrapper = parsedWrapper
        } catch (err) {
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                err,
                unknownClaudeTelemetry("failed", "parse_error"),
            )
        }

        if (wrapper.is_error === true || isErrorSubtype(wrapper.subtype)) {
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                new Error("claude returned an error result"),
                unknownClaudeTelemetry("failed", "not_reported"),
            )
        }

        // A valid, non-error wrapper proves that the provider call completed.
        // Replan JSON parsing below may still fail closed without rewriting
        // successful usage/cost evidence as a provider failure.
        const telemetry = claudeTelemetry(wrapper)
        try {
            const verdictText =
                typeof wrapper.result === "string" ? wrapper.result.trim() : ""
            if (!verdictText) throw new Error("empty result")

            const verdictJson = extractJsonObject(verdictText)
            const parsed = JSON.parse(verdictJson) as {
                action: string
                reason?: string
                added?: ReplanStoryAdd[]
                removed?: string[]
                modifiedDeps?: { id: string; newDependsOn: string[] }[]
            }

            if (parsed.action === "abort") {
                return { replan: null, telemetry }
            }

            const modifiedDeps: Record<string, readonly string[]> = {}
            for (const m of parsed.modifiedDeps ?? []) {
                if (typeof m.id === "string" && Array.isArray(m.newDependsOn)) {
                    modifiedDeps[m.id] = [...m.newDependsOn]
                }
            }
            return {
                replan: {
                    source: "surgeon",
                    reason: `${parsed.action}: ${parsed.reason ?? ""}`,
                    addedStories: parsed.added ?? [],
                    removedStoryIds: parsed.removed ?? [],
                    modifiedDeps,
                },
                telemetry,
            }
        } catch (err) {
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                err,
                telemetry,
            )
        }
    }
}

function surgeonLlmFallback(
    fallback: ReplanData,
    error: unknown,
    telemetry: SurgeonLlmTelemetry,
): SurgeonLlmEvaluation {
    return {
        replan: {
            ...fallback,
            reason: `${fallback.reason} (llm fallback after error: ${(error as Error)?.message ?? String(error)})`,
        },
        telemetry,
    }
}

function claudeTelemetry(
    wrapper: Record<string, unknown>,
): SurgeonLlmTelemetry {
    const usage = isRecord(wrapper.usage) ? wrapper.usage : null
    return {
        status: "succeeded",
        durationMs: metricFromKeys(wrapper, ["duration_ms"], "cli_result"),
        tokens: usage
            ? claudeTokenMetrics(usage)
            : unknownClaudeTokens(
                  wrapper.usage == null ? "not_reported" : "parse_error",
              ),
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
): SurgeonLlmTelemetry {
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
    if (!isRecord(error)) return false
    if (error.killed === true || error.code === "ETIMEDOUT") return true
    return (
        typeof error.message === "string" &&
        /(?:timed?\s*out|timeout)/i.test(error.message)
    )
}

function isErrorSubtype(value: unknown): boolean {
    return typeof value === "string" && value.toLowerCase().startsWith("error")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

