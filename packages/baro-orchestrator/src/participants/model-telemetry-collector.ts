import { createHash } from "node:crypto"

import type { SemanticEvent } from "@mozaik-ai/core"

import {
    AgentResult,
    CodexTurnEvent,
    ModelInvocationMeasured,
    OpenCodeSystem,
    PiTurnEvent,
    StoryRouted,
    type AgentResultData,
    type CodexTurnEventData,
    type OpenCodeSystemData,
    type PiTurnEventData,
} from "../semantic-events.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type MetricSource,
    type ModelCostMetrics,
    type ModelInvocationGranularity,
    type ModelInvocationMeasuredData,
    type ModelInvocationStatus,
    type ModelTokenMetrics,
} from "../model-telemetry.js"
import {
    SerializedObserver,
    type SerializedEventContext,
} from "../runtime/serialized-observer.js"

export interface ModelTelemetryCollectorOptions {
    runId: string
}

interface RouteInfo {
    backend: string
    model: string
}

interface InvocationObservation {
    agentId: string
    backend: string
    model: string | null
    status: ModelInvocationStatus
    granularity: ModelInvocationGranularity
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
    provider?: string | null
    providerRequestId?: string | null
}

/**
 * Converts backend-specific terminal usage frames into one semantic contract.
 * It is joined for every run, independently from the TUI, so audit/replay and
 * future routing policy see the same evidence.
 */
export class ModelTelemetryCollector extends SerializedObserver {
    private readonly routes = new Map<string, RouteInfo>()
    private readonly sequences = new Map<string, number>()
    private readonly seenTerminalObservations = new Set<string>()

    constructor(private readonly opts: ModelTelemetryCollectorOptions) {
        super()
    }

    protected override handleEvent(context: SerializedEventContext): void {
        const { event } = context
        if (StoryRouted.is(event)) {
            this.routes.set(event.data.storyId, {
                backend: event.data.backend,
                model: event.data.model,
            })
            return
        }
        if (AgentResult.is(event)) {
            this.publishOnce(event, this.fromAgentResult(event.data))
            return
        }
        if (CodexTurnEvent.is(event) && event.data.phase === "completed") {
            this.publishOnce(event, this.fromCodex(event.data))
            return
        }
        if (OpenCodeSystem.is(event) && event.data.subtype === "step_finish") {
            this.publishOnce(event, this.fromOpenCode(event.data))
            return
        }
        if (PiTurnEvent.is(event) && event.data.turnType === "message_end") {
            const message = record(event.data.raw.message)
            if (message.role !== "assistant") return
            this.publishOnce(event, this.fromPi(event.data))
        }
    }

    private publishOnce(
        event: SemanticEvent<unknown>,
        observation: InvocationObservation,
    ): void {
        const key = terminalFingerprint(event)
        if (this.seenTerminalObservations.has(key)) return
        this.seenTerminalObservations.add(key)
        this.publishObservation(observation)
    }

    private publishObservation(observation: InvocationObservation): void {
        const sequence = (this.sequences.get(observation.agentId) ?? 0) + 1
        this.sequences.set(observation.agentId, sequence)
        const invocationId = [
            this.opts.runId,
            "story",
            observation.agentId,
            observation.backend,
            sequence,
        ].join(":")
        const data: ModelInvocationMeasuredData = {
            schemaVersion: 1,
            measurementId: `${invocationId}:runner`,
            invocationId,
            runId: this.opts.runId,
            phase: "story",
            storyId: observation.agentId,
            attempt: null,
            turn: observation.granularity === "process" ? null : sequence,
            round: observation.granularity === "round" ? sequence : null,
            backend: observation.backend,
            provider: observation.provider ?? null,
            requestedModel: null,
            resolvedModel: observation.model,
            status: observation.status,
            durationMs: observation.durationMs,
            tokens: observation.tokens,
            cost: observation.cost,
            evidence: {
                producer: "runner",
                providerRequestId: observation.providerRequestId ?? null,
                rateCardVersion: null,
                granularity: observation.granularity,
            },
        }
        this.publish(ModelInvocationMeasured.create(data))
    }

    private route(agentId: string, fallbackBackend: string): RouteInfo {
        return this.routes.get(agentId) ?? {
            backend: fallbackBackend,
            model: "default",
        }
    }

    private fromAgentResult(item: AgentResultData): InvocationObservation {
        const route = this.route(item.agentId, "claude")
        const usage = record(item.usage)
        const tokens = tokenMetrics(usage, route.backend)
        const equivalentUsd = metricFromKeys(
            { total_cost_usd: item.totalCostUsd },
            ["total_cost_usd"],
            "cli_result",
        )
        return {
            agentId: item.agentId,
            backend: route.backend,
            model: route.model,
            status: item.isError ? "failed" : "succeeded",
            granularity: route.backend === "openai" ? "turn" : "process",
            durationMs: metricFromKeys(
                { duration_ms: item.durationMs },
                ["duration_ms"],
                "cli_result",
            ),
            tokens,
            cost: localCostMetrics(route.backend, equivalentUsd),
            providerRequestId: null,
        }
    }

    private fromCodex(item: CodexTurnEventData): InvocationObservation {
        const route = this.route(item.agentId, "codex")
        const raw = record(item.raw)
        return {
            agentId: item.agentId,
            backend: route.backend,
            model: route.model,
            status: "succeeded",
            granularity: "turn",
            durationMs: unknownMetric("not_reported"),
            tokens: tokenMetrics(record(raw.usage), "codex"),
            cost: localCostMetrics("codex", unknownMetric("not_reported")),
            providerRequestId: null,
        }
    }

    private fromOpenCode(item: OpenCodeSystemData): InvocationObservation {
        const route = this.route(item.agentId, "opencode")
        const raw = record(item.raw)
        const part = record(raw.part)
        return {
            agentId: item.agentId,
            backend: route.backend,
            model: route.model,
            status: "succeeded",
            granularity: "round",
            durationMs: unknownMetric("not_reported"),
            tokens: tokenMetrics(record(part.tokens), "opencode"),
            cost: localCostMetrics(
                "opencode",
                metricFromKeys(part, ["cost"], "cli_result"),
            ),
            providerRequestId: null,
        }
    }

    private fromPi(item: PiTurnEventData): InvocationObservation {
        const route = this.route(item.agentId, "pi")
        const message = record(item.raw.message)
        const usage = record(message.usage)
        const cost = record(usage.cost)
        const equivalent =
            metricFromKeys(usage, ["cost_usd", "costUsd"], "cli_result", true) ??
            metricFromKeys(cost, ["total"], "cli_result", true) ??
            unknownMetric("not_reported")
        return {
            agentId: item.agentId,
            backend: route.backend,
            model:
                typeof message.model === "string" && message.model.trim()
                    ? message.model
                    : route.model,
            status: "succeeded",
            granularity: "turn",
            durationMs: unknownMetric("not_reported"),
            tokens: tokenMetrics(usage, "pi"),
            cost: localCostMetrics("pi", equivalent),
            provider:
                typeof message.provider === "string" && message.provider.trim()
                    ? message.provider
                    : null,
            providerRequestId:
                typeof message.responseId === "string"
                    ? message.responseId
                    : typeof message.response_id === "string"
                      ? message.response_id
                      : null,
        }
    }
}

function tokenMetrics(usage: Record<string, unknown>, backend: string): ModelTokenMetrics {
    const cache = record(usage.cache)
    const rawInput = metricFromKeys(
        usage,
        ["input_tokens", "input", "inputTokens"],
        "provider_response",
    )
    const cached = firstMetric([
        metricFromKeys(
            usage,
            ["cached_input_tokens", "cache_read_input_tokens", "cacheRead"],
            "provider_response",
            true,
        ),
        metricFromKeys(cache, ["read"], "provider_response", true),
    ])
    const cacheWrite = firstMetric([
        metricFromKeys(
            usage,
            ["cache_creation_input_tokens", "cache_write_input_tokens", "cacheWrite"],
            "provider_response",
            true,
        ),
        metricFromKeys(cache, ["write"], "provider_response", true),
    ])
    const output = metricFromKeys(
        usage,
        ["output_tokens", "output", "outputTokens"],
        "provider_response",
    )
    const reasoning = metricFromKeys(
        usage,
        ["reasoning_output_tokens", "reasoning_tokens", "reasoning"],
        "provider_response",
    )
    const inputTotal = ["claude", "opencode", "pi"].includes(backend)
        ? sumKnown([rawInput, cached, cacheWrite])
        : rawInput
    const outputTotal = backend === "opencode"
        ? sumKnown([output, reasoning])
        : output
    const reportedTotal = metricFromKeys(
        usage,
        ["total_tokens", "total", "totalTokens"],
        "provider_response",
        true,
    )

    return {
        inputTotal,
        cachedInput: supportsCachedInput(backend)
            ? cached
            : notApplicableMetric(),
        cacheWriteInput: supportsCacheWrite(backend)
            ? cacheWrite
            : notApplicableMetric(),
        outputTotal,
        reasoningOutput: supportsReasoning(backend)
            ? reasoning
            : notApplicableMetric(),
        total: reportedTotal ?? sumKnown([inputTotal, outputTotal]),
    }
}

function localCostMetrics(backend: string, equivalentUsd: Metric): ModelCostMetrics {
    if (backend === "openai") {
        return {
            providerUsd: unknownMetric("pending_gateway_meter"),
            customerUsd: unknownMetric("pending_gateway_meter"),
            equivalentUsd: notApplicableMetric(),
        }
    }
    return {
        providerUsd: notApplicableMetric(),
        customerUsd: notApplicableMetric(),
        equivalentUsd,
    }
}

function metricFromKeys(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
): Metric
function metricFromKeys(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
    optional: true,
): Metric | null
function metricFromKeys(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
    optional = false,
): Metric | null {
    for (const key of keys) {
        if (!(key in source) || source[key] == null) continue
        const value = source[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0
            ? knownMetric(value, metricSource)
            : unknownMetric("parse_error")
    }
    return optional ? null : unknownMetric("not_reported")
}

function sumKnown(metrics: readonly Metric[]): Metric {
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

function firstMetric(metrics: readonly (Metric | null)[]): Metric {
    return metrics.find((metric): metric is Metric => metric !== null) ??
        unknownMetric("not_reported")
}

function supportsCachedInput(backend: string): boolean {
    return ["claude", "openai", "codex", "opencode", "pi"].includes(backend)
}

function supportsCacheWrite(backend: string): boolean {
    return backend === "claude" || backend === "opencode" || backend === "pi"
}

function supportsReasoning(backend: string): boolean {
    return ["openai", "codex", "opencode"].includes(backend)
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

function terminalFingerprint(event: SemanticEvent<unknown>): string {
    return createHash("sha256")
        .update(event.type)
        .update("\0")
        .update(JSON.stringify(event.data))
        .digest("hex")
}
