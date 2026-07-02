/**
 * Map OpenCode CLI `opencode run --format json` JSONL events to typed
 * items for bus delivery. Every input event maps to a non-empty array —
 * nothing is silently dropped. Wire format and full mapping table:
 * docs/stream-protocols.md ("OpenCode").
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    OpenCodeStepEvent,
    OpenCodeSystem,
    OpenCodeUnknownEvent,
} from "./semantic-events.js"

export type MappedOpenCodeItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

export interface OpenCodeMapResult {
    /** Always non-empty. */
    items: MappedOpenCodeItem[]
    sessionId: string | null
}

function eventTimestamp(event: Record<string, unknown>): string {
    return typeof event.timestamp === "number"
        ? String(event.timestamp)
        : "0"
}

export function mapOpenCodeEvent(
    agentId: string,
    event: Record<string, unknown>,
): OpenCodeMapResult {
    const sessionId =
        typeof event.sessionID === "string" ? event.sessionID : null
    const items: MappedOpenCodeItem[] = []
    const type = typeof event.type === "string" ? event.type : ""

    if (type === "step_start") {
        items.push(
            OpenCodeSystem.create({
                agentId,
                subtype: "step_start",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    if (type === "text") {
        const part = event.part as Record<string, unknown> | undefined
        const text = typeof part?.text === "string" ? part.text : ""
        if (text) {
            items.push(ModelMessageItem.rehydrate({ text }))
        }
        items.push(
            OpenCodeStepEvent.create({
                agentId,
                stepType: "text",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // One `tool_use` event carries both the call and its result in
    // `part.state` — NOT a `tool_call`/`tool_result` pair (the paired
    // handlers below are only a fallback; see docs/stream-protocols.md).
    if (type === "tool_use") {
        const part = event.part as Record<string, unknown> | undefined
        const state =
            (part?.state as Record<string, unknown> | undefined) ?? undefined
        const callId =
            typeof part?.callID === "string"
                ? part.callID
                : typeof part?.id === "string"
                  ? part.id
                  : `opencode:${eventTimestamp(event)}`
        const name = typeof part?.tool === "string" ? part.tool : "unknown"
        const args =
            state?.input !== undefined
                ? typeof state.input === "string"
                    ? state.input
                    : JSON.stringify(state.input)
                : "{}"
        items.push(FunctionCallItem.rehydrate({ callId, name, args }))
        items.push(
            OpenCodeStepEvent.create({
                agentId,
                stepType: "tool_call",
                raw: event,
            }),
        )
        if (state?.output !== undefined) {
            const result =
                typeof state.output === "string"
                    ? state.output
                    : JSON.stringify(state.output)
            items.push(FunctionCallOutputItem.create(callId, result))
            items.push(
                OpenCodeStepEvent.create({
                    agentId,
                    stepType: "tool_result",
                    raw: event,
                }),
            )
        }
        return { items, sessionId }
    }

    if (type === "tool_call") {
        const part = event.part as Record<string, unknown> | undefined
        const callId = typeof part?.id === "string" ? part.id : `opencode:${eventTimestamp(event)}`
        const name = typeof part?.tool === "string" ? part.tool : "unknown"
        const args =
            part?.args !== undefined
                ? typeof part.args === "string"
                    ? part.args
                    : JSON.stringify(part.args)
                : "{}"
        items.push(FunctionCallItem.rehydrate({ callId, name, args }))
        items.push(
            OpenCodeStepEvent.create({
                agentId,
                stepType: "tool_call",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    if (type === "tool_result") {
        const part = event.part as Record<string, unknown> | undefined
        const callId = typeof part?.id === "string" ? part.id : `opencode:${eventTimestamp(event)}`
        const result = typeof part?.result === "string" ? part.result : ""
        items.push(FunctionCallOutputItem.create(callId, result))
        items.push(
            OpenCodeStepEvent.create({
                agentId,
                stepType: "tool_result",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    if (type === "step_finish") {
        items.push(
            OpenCodeSystem.create({
                agentId,
                subtype: "step_finish",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    items.push(
        OpenCodeUnknownEvent.create({
            agentId,
            openCodeType: type || "unspecified",
            raw: event,
        }),
    )
    return { items, sessionId }
}
