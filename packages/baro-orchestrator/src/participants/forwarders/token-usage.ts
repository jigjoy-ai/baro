import { BaseObserver, Participant, SemanticEvent } from "../../runtime/mozaik.js"

import {
    ClaudeStreamChunk,
    type ClaudeStreamChunkData,
    ModelInvocationMeasured,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../semantic-events.js"
import type {
    Metric,
    ModelInvocationPhase,
    ModelInvocationMeasuredData,
} from "../../model-telemetry.js"
import { emit } from "../../tui-protocol.js"
import { ActiveLeaseRegistry } from "../../runtime/active-lease-registry.js"
import type { StoryOutcomeAuthority } from "../../runtime/story-outcome-authority.js"

// Don't flood the event stream with sub-turn progress: at most one
// token_progress per agent per this interval (the dashboard polls ~2s anyway).
const PROGRESS_THROTTLE_MS = 1500

/**
 * Mirrors agent usage accounting as `token_usage` BaroEvents for the Rust TUI.
 *
 * Subscribes to backend-neutral ModelInvocationMeasured totals and
 * ClaudeStreamChunk (live sub-turn estimates).
 *
 * Emits: token_usage (authoritative, summed downstream) and token_progress
 * (latest cumulative snapshot per agent; consumers take the max, not a sum).
 */
export class TokenUsageForwarder extends BaseObserver {
    // Per-agent live accumulator for Claude streaming. Claude reports
    // output_tokens cumulatively *within a message*, restarting each turn — so
    // we carry committed output across turns and add the current message's count.
    // We track OUTPUT only: per-message input_tokens includes the whole replayed
    // context, so summing it across turns would wildly over-count. Input comes
    // from the authoritative token_usage total at the end instead.
    private readonly live = new Map<
        string,
        { committedOut: number; curOut: number; lastEmit: number }
    >()
    private readonly seenMeasurementIds = new Set<string>()
    private readonly leases = new ActiveLeaseRegistry()
    private collectiveAuthorities: Readonly<CollectiveTokenUsageAuthorities> | null = null

    constructor(private readonly collectiveFailClosed = false) {
        super()
    }

    sealCollectiveAuthorities(
        authorities: CollectiveTokenUsageAuthorities,
    ): void {
        if (this.collectiveAuthorities) {
            throw new Error(
                "token usage forwarder collective authorities are already sealed",
            )
        }
        this.collectiveAuthorities = Object.freeze({
            ...authorities,
            measurementAuthorities: Object.freeze(
                authorities.measurementAuthorities.map((item) =>
                    Object.freeze({
                        source: item.source,
                        phases: Object.freeze([...item.phases]),
                    }),
                ),
            ),
        })
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (WorkLeaseGranted.is(event) || WorkLeaseReleased.is(event)) {
            const authorities = this.collectiveAuthorities
            if (
                !authorities ||
                source !== authorities.broker ||
                event.data.runId !== authorities.runId
            ) return
            if (
                WorkLeaseReleased.is(event) &&
                !this.leases.matchesLease(
                    event.data.storyId,
                    event.data.runId,
                    event.data.leaseId,
                )
            ) return
            this.leases.observe(event, authorities.runId)
            return
        }
        if (ModelInvocationMeasured.is(event)) {
            if (!this.acceptsMeasurement(source, event.data)) return
            if (this.seenMeasurementIds.has(event.data.measurementId)) return
            this.seenMeasurementIds.add(event.data.measurementId)
            this.handleMeasurement(event.data)
            return
        }
        if (ClaudeStreamChunk.is(event)) {
            if (!this.acceptsStreamSource(source, event.data.agentId)) return
            this.handleStreamChunk(event.data)
            return
        }
    }

    private handleStreamChunk(item: ClaudeStreamChunkData): void {
        // raw is the stream-json `stream_event` envelope; the nested `event` is
        // the Anthropic SSE frame (message_start / message_delta / …).
        const inner = (item.raw.event ?? item.raw) as Record<string, unknown>
        const type = typeof inner.type === "string" ? inner.type : ""
        const num = (v: unknown) => (typeof v === "number" ? v : 0)
        const st =
            this.live.get(item.agentId) ?? { committedOut: 0, curOut: 0, lastEmit: 0 }
        if (type === "message_start") {
            // New message: bank the finished message's output, then seed from this one.
            st.committedOut += st.curOut
            const msg = (inner.message ?? {}) as { usage?: Record<string, unknown> }
            st.curOut = num((msg.usage ?? {}).output_tokens)
        } else if (type === "message_delta") {
            const usage = (inner.usage ?? {}) as Record<string, unknown>
            st.curOut = num(usage.output_tokens) || st.curOut
        } else {
            this.live.set(item.agentId, st)
            return
        }
        this.live.set(item.agentId, st)
        const now = Date.now()
        if (type !== "message_start" && now - st.lastEmit < PROGRESS_THROTTLE_MS) return
        st.lastEmit = now
        emit({
            type: "token_progress",
            id: item.agentId,
            input_tokens: 0, // input comes from the authoritative total; see above
            output_tokens: st.committedOut + st.curOut,
        })
    }

    private handleMeasurement(item: ModelInvocationMeasuredData): void {
        emit({
            type: "model_usage",
            measurement: item,
        })
        // Gateway/cloud records are alternate observations of the same
        // invocation, not token deltas. Keep them in model_usage for the
        // reducer, but project only the runner record into legacy additive
        // token_usage or Rust would double-count one call.
        if (item.evidence.producer !== "runner") return
        const inputTokens = knownValue(item.tokens.inputTotal)
        const outputTokens = knownValue(item.tokens.outputTotal)
        // The legacy projection cannot represent unknown. Emit it only when
        // both token totals are truly known; never manufacture a numeric zero.
        if (inputTokens === null || outputTokens === null) return
        const equivalentCost = knownValue(item.cost.equivalentUsd)
        const providerCost = knownValue(item.cost.providerUsd)
        emit({
            type: "token_usage",
            id: item.storyId ?? item.phase,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_usd: equivalentCost ?? providerCost ?? undefined,
        })
    }

    private acceptsMeasurement(
        source: Participant,
        item: ModelInvocationMeasuredData,
    ): boolean {
        const isCollective =
            this.collectiveFailClosed || this.collectiveAuthorities !== null
        if (!isCollective) return true
        const authorities = this.collectiveAuthorities
        if (!authorities || item.runId !== authorities.runId) return false
        return authorities.measurementAuthorities.some(
            (authority) =>
                authority.source === source &&
                authority.phases.includes(item.phase),
        )
    }

    private acceptsStreamSource(
        source: Participant,
        storyId: string,
    ): boolean {
        const isCollective =
            this.collectiveFailClosed || this.collectiveAuthorities !== null
        if (!isCollective) return true
        const authorities = this.collectiveAuthorities
        if (!authorities) return false
        const correlation =
            authorities.outcomeAuthority.terminalCorrelationForSource(
                source,
                storyId,
            )
        if (!correlation) return false
        return this.leases.matches(
            {
                storyId: correlation.storyId,
                success: false,
                attempts: 0,
                durationSecs: 0,
                error: null,
                runId: correlation.runId,
                leaseId: correlation.leaseId,
                generation: correlation.generation,
            },
            authorities.runId,
        )
    }
}

export interface CollectiveTokenUsageAuthorities {
    runId: string
    broker: Participant
    outcomeAuthority: StoryOutcomeAuthority
    measurementAuthorities: readonly {
        source: Participant
        phases: readonly ModelInvocationPhase[]
    }[]
}

function knownValue(metric: Metric): number | null {
    return metric.state === "known" ? metric.value : null
}
