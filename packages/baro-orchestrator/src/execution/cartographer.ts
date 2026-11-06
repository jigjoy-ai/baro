/**
 * Cartographer — observer that translates Mozaik bus events into a
 * coarser-grained frame stream for UI rendering. One frame object per
 * `sink` call, no buffering.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
    toWire,
} from "../runtime/mozaik.js"
import { BusMember } from "../runtime/coordination.js"

import {
    AgentResult,
    AgentState,
    AgentTargetedMessage,
    AgentUserMessage,
    ClaudeRateLimit,
    ClaudeStreamChunk,
    ClaudeSystem,
    ClaudeUnknownEvent,
} from "../semantic-events.js"

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
    sink: (frame: Frame) => void
    /** Default: false — high volume, mainly for live token-streaming UIs. */
    emitStreamChunks?: boolean
}

export class Cartographer extends BusMember {
    private readonly sink: (frame: Frame) => void
    private readonly emitStreamChunks: boolean

    constructor(opts: CartographerOptions) {
        super()
        this.sink = opts.sink
        this.emitStreamChunks = opts.emitStreamChunks ?? false
    }

    override async onExternalModelMessage(
        source: BusMember,
        item: ModelMessageItem,
    ): Promise<void> {
        const agentId = this.extractAgentId(source, item)
        const json = toWire(item) as { content: Array<{ text: string }> }
        const text = json.content?.[0]?.text ?? ""
        this.sink({ kind: "model_message", agentId, text })
    }

    override async onExternalFunctionCall(
        source: BusMember,
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
        source: BusMember,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        const agentId = this.extractAgentId(source, item)
        const json = toWire(item) as { call_id: string; output: Array<{ text: string }> }
        const output = json.output?.[0]?.text ?? ""
        this.sink({ kind: "tool_result", agentId, callId: json.call_id, output })
    }

    override async onExternalEvent(
        source: BusMember,
        event: SemanticEvent<string, unknown>,
    ): Promise<void> {
        if (AgentState.is(event)) {
            this.sink({
                kind: "agent_state",
                agentId: event.payload.agentId,
                phase: event.payload.phase,
                detail: event.payload.detail,
            })
            return
        }

        if (AgentUserMessage.is(event)) {
            this.sink({
                kind: "user_message",
                agentId: event.payload.agentId,
                text: event.payload.text,
            })
            return
        }

        if (AgentTargetedMessage.is(event)) {
            this.sink({
                kind: "user_message",
                agentId: event.payload.recipientId,
                text: event.payload.text,
            })
            return
        }

        if (AgentResult.is(event)) {
            this.sink({
                kind: "result",
                agentId: event.payload.agentId,
                isError: event.payload.isError,
                text: event.payload.resultText,
                durationMs: event.payload.durationMs,
                costUsd: event.payload.totalCostUsd,
                numTurns: event.payload.numTurns,
                sessionId: event.payload.sessionId,
            })
            return
        }

        if (ClaudeRateLimit.is(event)) {
            this.sink({
                kind: "rate_limit",
                agentId: event.payload.agentId,
                raw: event.payload.raw,
            })
            return
        }

        if (ClaudeSystem.is(event)) {
            this.sink({
                kind: "system",
                agentId: event.payload.agentId,
                subtype: event.payload.subtype,
            })
            return
        }

        if (ClaudeStreamChunk.is(event)) {
            if (this.emitStreamChunks) {
                this.sink({ kind: "stream_chunk", agentId: event.payload.agentId })
            }
            return
        }

        if (ClaudeUnknownEvent.is(event)) {
            this.sink({
                kind: "unknown",
                sourceLabel: source.constructor.name,
                itemType: event.payload.claudeType,
            })
            return
        }

        // Unknown frame so the sink still sees that something happened.
        this.sink({
            kind: "unknown",
            sourceLabel: source.constructor.name,
            itemType: event.type ?? "unspecified",
        })
    }

    private extractAgentId(
        source: BusMember,
        item: { agentId?: string } | object,
    ): string | null {
        const fromItem = (item as { agentId?: string }).agentId
        if (typeof fromItem === "string") return fromItem
        const fromSource = (source as unknown as { agentId?: string }).agentId
        return typeof fromSource === "string" ? fromSource : null
    }
}
