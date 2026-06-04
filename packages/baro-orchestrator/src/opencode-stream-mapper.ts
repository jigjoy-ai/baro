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
 *   {"type":"tool_use","timestamp":N,"sessionID":"…","part":{"type":"tool","tool":"write","callID":"…","state":{"status":"completed","input":{…},"output":"…"}}}
 *   {"type":"step_finish","timestamp":N,"sessionID":"…","part":{"type":"step-finish","tokens":{…},"cost":N,…}}
 *
 * NOTE: a tool invocation arrives as ONE `tool_use` event carrying both
 * the call (`part.state.input`) and its result (`part.state.output`),
 * NOT as a `tool_call`/`tool_result` pair. The pair shape is kept as a
 * fallback for forward/backward compatibility but is not what the
 * current binary emits.
 *
 * Mapping strategy:
 *
 *   - `step_start` → OpenCodeSystem semantic event (subtype "step_start").
 *   - `text` → ModelMessageItem (assistant text) + OpenCodeStepEvent.
 *   - `tool_use` → FunctionCallItem (+ FunctionCallOutputItem once the
 *     tool completed) + OpenCodeStepEvent(s).
 *   - `tool_call` / `tool_result` → fallback for the legacy paired shape.
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
/** Best-effort stable id suffix from an event's own timestamp. */
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

    // ─── tool_use ──────────────────────────────────────────────────
    // The real `opencode run --format json` stream emits a SINGLE
    // `tool_use` event per tool invocation (verified against the live
    // binary), carrying both the call and its result in `part.state`:
    //   part.tool             — tool name (e.g. "write", "bash", "read")
    //   part.callID           — invocation id
    //   part.state.input      — the arguments object
    //   part.state.output     — the textual result (present once completed)
    //   part.state.status     — "completed" | …
    // The earlier `tool_call` / `tool_result` two-event shape (kept as a
    // fallback below) was an assumption that never matched real output,
    // so tool activity silently fell through to OpenCodeUnknownEvent —
    // breaking function-call delivery and any tool-based success check.
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
        // Emit the result too when the tool has finished, so observers see
        // a matched call/output pair from the single event.
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

    // ─── tool_call (legacy/fallback shape) ─────────────────────────
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

    // ─── tool_result (legacy/fallback shape) ───────────────────────
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
