/**
 * Cartographer — observer that translates Mozaik bus events into a
 * coarser-grained "frame stream" suitable for downstream UI rendering.
 *
 * In Phase 1 the consumer is the Rust TUI (line-delimited JSON over
 * stdout). The same Cartographer will later serve a web UI by
 * subscribing a different sink. The protocol is one event object per
 * call to `sink`, no buffering.
 *
 * Library-grade: emits semantic frames (state changes, tool calls,
 * messages, results) regardless of who produced them.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
} from "@mozaik-ai/core"

import { BaroParticipant, BusEvent } from "../bus.js"
import {
    AgentStateItem,
    AgentTargetedMessageItem,
    AgentUserMessageItem,
    ClaudeRateLimitItem,
    AgentResultItem,
    ClaudeStreamChunkItem,
    ClaudeSystemItem,
    ClaudeUnknownEventItem,
} from "../types.js"

export type Frame =
    | { kind: "agent_state"; agentId: string; phase: string; detail?: string }
    | { kind: "user_message"; agentId: string | null; text: string }
    | { kind: "model_message"; agentId: string | null; text: string }
    | { kind: "tool_call"; agentId: string | null; callId: string; name: string; args: string }
    | { kind: "tool_result"; agentId: string | null; callId: string; output: string }
    | { kind: "result"; agentId: string; isError: boolean; text: string | null; durationMs: number | null; costUsd: number | null; numTurns: number | null; sessionId: string | null }
    | { kind: "rate_limit"; agentId: string; raw: unknown }
    | { kind: "system"; agentId: string; subtype: string }
    | { kind: "stream_chunk"; agentId: string }
    | { kind: "unknown"; sourceLabel: string; itemType: string }

export interface CartographerOptions {
    /** Where each frame is written. */
    sink: (frame: Frame) => void
    /**
     * Whether to emit `stream_chunk` frames. Default: false (high volume,
     * mainly useful for live token-streaming UIs).
     */
    emitStreamChunks?: boolean
}

export class Cartographer extends BaroParticipant {
    private readonly sink: (frame: Frame) => void
    private readonly emitStreamChunks: boolean

    constructor(opts: CartographerOptions) {
        super()
        this.sink = opts.sink
        this.emitStreamChunks = opts.emitStreamChunks ?? false
    }

    // ─── Mozaik-typed assistant events (now on their dedicated channels) ──

    override async onExternalModelMessage(
        source: Participant,
        item: ModelMessageItem,
    ): Promise<void> {
        const agentId = this.extractAgentId(source, item)
        const json = item.toJSON() as { content: Array<{ text: string }> }
        const text = json.content?.[0]?.text ?? ""
        this.sink({ kind: "model_message", agentId, text })
    }

    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        const agentId = this.extractAgentId(source, item)
        this.sink({
            kind: "tool_call",
            agentId,
            callId: item.callId,
            name: item.name,
            args: item.args,
        })
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        const agentId = this.extractAgentId(source, item)
        const json = item.toJSON() as { call_id: string; output: Array<{ text: string }> }
        const output = json.output?.[0]?.text ?? ""
        this.sink({ kind: "tool_result", agentId, callId: json.call_id, output })
    }

    // ─── baro custom bus events ───────────────────────────────────────

    override async onExternalBusEvent(source: Participant, event: BusEvent): Promise<void> {
        const agentId = this.extractAgentId(source, event)

        if (event instanceof AgentStateItem) {
            this.sink({
                kind: "agent_state",
                agentId: event.agentId,
                phase: event.phase,
                detail: event.detail,
            })
            return
        }

        if (event instanceof AgentUserMessageItem) {
            this.sink({ kind: "user_message", agentId: event.agentId, text: event.text })
            return
        }

        if (event instanceof AgentTargetedMessageItem) {
            this.sink({
                kind: "user_message",
                agentId: event.recipientId,
                text: event.text,
            })
            return
        }

        if (event instanceof AgentResultItem) {
            this.sink({
                kind: "result",
                agentId: event.agentId,
                isError: event.isError,
                text: event.resultText,
                durationMs: event.durationMs,
                costUsd: event.totalCostUsd,
                numTurns: event.numTurns,
                sessionId: event.sessionId,
            })
            return
        }

        if (event instanceof ClaudeRateLimitItem) {
            this.sink({ kind: "rate_limit", agentId: event.agentId, raw: event.raw })
            return
        }

        if (event instanceof ClaudeSystemItem) {
            this.sink({
                kind: "system",
                agentId: event.agentId,
                subtype: event.subtype,
            })
            return
        }

        if (event instanceof ClaudeStreamChunkItem) {
            if (this.emitStreamChunks) {
                this.sink({ kind: "stream_chunk", agentId: event.agentId })
            }
            return
        }

        if (event instanceof ClaudeUnknownEventItem) {
            this.sink({
                kind: "unknown",
                sourceLabel: source.constructor.name,
                itemType: event.claudeType,
            })
            return
        }

        // Anything else falls through into an "unknown" frame so the sink
        // sees that something happened.
        this.sink({
            kind: "unknown",
            sourceLabel: source.constructor.name,
            itemType: event.type ?? "unspecified",
        })
    }

    private extractAgentId(
        source: Participant,
        item: { agentId?: string } | object,
    ): string | null {
        const fromItem = (item as { agentId?: string }).agentId
        if (typeof fromItem === "string") return fromItem
        const fromSource = (source as unknown as { agentId?: string }).agentId
        return typeof fromSource === "string" ? fromSource : null
    }
}
