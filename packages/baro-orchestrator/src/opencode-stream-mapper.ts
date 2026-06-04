/**
 * Map OpenCode CLI `opencode run --format json` stream events to typed
 * items for bus delivery. Sibling of `codex-stream-mapper.ts` (the Codex
 * mapper) and `stream-json-mapper.ts` (the Claude mapper).
 *
 * OpenCode stream shape — observed against real `opencode run --format json`
 * output. Each stdout line is a JSONL envelope:
 *
 *   {"type":"step_start","timestamp":N,"sessionID":"…","part":{…}}
 *   {"type":"text","timestamp":N,"sessionID":"…","part":{"type":"text","text":"…",…}}
 *   {"type":"tool_call","timestamp":N,"sessionID":"…","part":{"type":"tool-call","id":"…","tool":"…","args":{…}}}
 *   {"type":"tool_result","timestamp":N,"sessionID":"…","part":{"type":"tool-result","id":"…","tool":"…","result":"…"}}
 *   {"type":"step_finish","timestamp":N,"sessionID":"…","part":{"type":"step-finish","tokens":{…},"cost":N,…}}
 *
 * Mapping strategy:
 *
 *   - `step_start` → OpenCodeSystem semantic event (subtype "step_start").
 *   - `text` → ModelMessageItem (assistant text) + OpenCodeStepEvent.
 *   - `tool_call` → FunctionCallItem + OpenCodeStepEvent.
 *   - `tool_result` → FunctionCallOutputItem + OpenCodeStepEvent.
 *   - `step_finish` → OpenCodeSystem semantic event (subtype "step_finish",
 *     carries token/cost metadata in `raw`).
 *   - Unknown → OpenCodeUnknownEvent so nothing is silently dropped.
 *
 * Every input event maps to a non-empty array — we never silently drop
 * data. Downstream observers (audit log, kaleidoskop replay, debug
 * consoles) see every envelope OpenCode produces.
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

/** Union of all item types the OpenCode mapper can produce. */
export type MappedOpenCodeItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

/** Result of mapping a single OpenCode JSONL event. */
export interface OpenCodeMapResult {
    /** Mapped items to deliver on the bus. Always non-empty. */
    items: MappedOpenCodeItem[]
    /** OpenCode `sessionID` observed on this event, if any. */
    sessionId: string | null
}

/**
 * Map a single parsed OpenCode JSONL event to typed Mozaik items.
 *
 * @param agentId - The baro agent ID (story ID) that owns this stream.
 * @param event - A parsed JSON object from OpenCode's stdout.
 * @returns Mapped items and optional session ID.
 */
export function mapOpenCodeEvent(
    agentId: string,
    event: Record<string, any>,
): OpenCodeMapResult {
    const sessionId =
        typeof event.sessionID === "string" ? event.sessionID : null
    const items: MappedOpenCodeItem[] = []
    const type = typeof event.type === "string" ? event.type : ""

    // ─── step_start ────────────────────────────────────────────────
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

    // ─── text (assistant message) ──────────────────────────────────
    if (type === "text") {
        const part = event.part as Record<string, any> | undefined
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

    // ─── tool_call ─────────────────────────────────────────────────
    if (type === "tool_call") {
        const part = event.part as Record<string, any> | undefined
        const callId = typeof part?.id === "string" ? part.id : `opencode:${Date.now()}`
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

    // ─── tool_result ───────────────────────────────────────────────
    if (type === "tool_result") {
        const part = event.part as Record<string, any> | undefined
        const callId = typeof part?.id === "string" ? part.id : `opencode:${Date.now()}`
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

    // ─── step_finish ───────────────────────────────────────────────
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

    // ─── unknown / future event type ───────────────────────────────
    items.push(
        OpenCodeUnknownEvent.create({
            agentId,
            openCodeType: type || "unspecified",
            raw: event,
        }),
    )
    return { items, sessionId }
}
