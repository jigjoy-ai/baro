/**
 * Cartographer — observer that translates Mozaik bus events into a
 * coarser-grained frame stream for UI rendering. One frame object per
 * `sink` call, no buffering.
 */

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

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

export class Cartographer extends BaseObserver {
    private readonly sink: (frame: Frame) => void
    private readonly emitStreamChunks: boolean

    constructor(opts: CartographerOptions) {
        super()
        this.sink = opts.sink
        this.emitStreamChunks = opts.emitStreamChunks ?? false
    }

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

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (AgentState.is(event)) {
            this.sink({
                kind: "agent_state",
                agentId: event.data.agentId,
                phase: event.data.phase,
                detail: event.data.detail,
            })
            return
        }

        if (AgentUserMessage.is(event)) {
            this.sink({
                kind: "user_message",
                agentId: event.data.agentId,
                text: event.data.text,
            })
            return
        }

        if (AgentTargetedMessage.is(event)) {
            this.sink({
                kind: "user_message",
                agentId: event.data.recipientId,
                text: event.data.text,
            })
            return
        }

        if (AgentResult.is(event)) {
            this.sink({
                kind: "result",
                agentId: event.data.agentId,
                isError: event.data.isError,
                text: event.data.resultText,
                durationMs: event.data.durationMs,
                costUsd: event.data.totalCostUsd,
                numTurns: event.data.numTurns,
                sessionId: event.data.sessionId,
            })
            return
        }

        if (ClaudeRateLimit.is(event)) {
            this.sink({
                kind: "rate_limit",
                agentId: event.data.agentId,
                raw: event.data.raw,
            })
            return
        }

        if (ClaudeSystem.is(event)) {
            this.sink({
                kind: "system",
                agentId: event.data.agentId,
                subtype: event.data.subtype,
            })
            return
        }

        if (ClaudeStreamChunk.is(event)) {
            if (this.emitStreamChunks) {
                this.sink({ kind: "stream_chunk", agentId: event.data.agentId })
            }
            return
        }

        if (ClaudeUnknownEvent.is(event)) {
            this.sink({
                kind: "unknown",
                sourceLabel: source.constructor.name,
                itemType: event.data.claudeType,
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
        source: Participant,
        item: { agentId?: string } | object,
    ): string | null {
        const fromItem = (item as { agentId?: string }).agentId
        if (typeof fromItem === "string") return fromItem
        const fromSource = (source as unknown as { agentId?: string }).agentId
        return typeof fromSource === "string" ? fromSource : null
    }
}
