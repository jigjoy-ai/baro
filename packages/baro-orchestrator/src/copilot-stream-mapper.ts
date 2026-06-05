/**
 * Map GitHub Copilot CLI `copilot -p ... --output-format json` stream
 * events to typed items for bus delivery. Sibling of
 * `codex-stream-mapper.ts` and `opencode-stream-mapper.ts`.
 *
 * Copilot stream shape — observed against real
 * `copilot -p "…" --output-format json --yolo --no-ask-user` output
 * (S1 probe 2026-06-05, copilot v1.0.59 on gpt-5.5; logs in
 * packages/baro-app/scripts/spike-logs/copilot-*.jsonl). Each stdout line
 * is a JSONL envelope whose discriminant is the top-level `type` and whose
 * payload lives under `data`:
 *
 *   {"type":"session.mcp_server_status_changed","data":{…},"id":"…","timestamp":"…","ephemeral":true}
 *   {"type":"session.mcp_servers_loaded","data":{"servers":[…]},…}
 *   {"type":"session.skills_loaded","data":{"skills":[…]},…}
 *   {"type":"session.tools_updated","data":{"model":"gpt-5.5"},…}
 *   {"type":"session.background_tasks_changed","data":{},…}
 *   {"type":"user.message","data":{"content":"…","transformedContent":"…",…},…}
 *   {"type":"assistant.turn_start","data":{"turnId":"0","interactionId":"…"},…}
 *   {"type":"assistant.message_start","data":{"messageId":"…","phase":"final_answer"},…,"ephemeral":true}
 *   {"type":"assistant.message_delta","data":{"messageId":"…","deltaContent":"…"},…,"ephemeral":true}
 *   {"type":"assistant.message","data":{"messageId":"…","content":"…","toolRequests":[…],"phase":"…",…},…}
 *   {"type":"tool.execution_start","data":{"toolCallId":"…","toolName":"powershell","arguments":{…}},…}
 *   {"type":"tool.execution_complete","data":{"toolCallId":"…","success":true,"result":{"content":"…","detailedContent":"…"}},…}
 *   {"type":"assistant.turn_end","data":{"turnId":"0"},…}
 *   {"type":"result","sessionId":"…","exitCode":0,"usage":{…},"timestamp":"…"}
 *
 * The session id is carried ONLY on the terminal `result` envelope, at
 * top level as `sessionId` (not under `data`, unlike every other field).
 *
 * Mapping strategy:
 *
 *   - Assistant-side final messages (`assistant.message`) map their
 *     `data.content` to Mozaik's `ModelMessageItem`. The streaming
 *     partials (`assistant.message_start` / `assistant.message_delta`,
 *     both `ephemeral`) carry the same text incrementally — they go
 *     through CopilotItemEvent ONLY, so we don't double-count the text.
 *   - Tool calls arrive as a `tool.execution_start` /
 *     `tool.execution_complete` pair sharing `data.toolCallId`. The
 *     start emits a `FunctionCallItem` (the invocation), the complete
 *     emits the paired `FunctionCallOutputItem` (the result content).
 *     The `toolRequests` array embedded in `assistant.message` mirrors
 *     these same calls, so we do NOT map it to FunctionCallItem — that
 *     would duplicate every tool call.
 *   - session.* / assistant.turn_* / result lifecycle become
 *     `CopilotSystem` events carrying the raw envelope. The
 *     CopilotCliParticipant uses these to drive AgentState transitions.
 *   - Unknown / future event types fall through to CopilotUnknownEvent so
 *     nothing is silently dropped — downstream tooling sees every
 *     envelope Copilot produces.
 *
 * Every input event maps to a non-empty array — we never silently drop
 * data.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    CopilotItemEvent,
    CopilotSystem,
    CopilotUnknownEvent,
} from "./semantic-events.js"

/** Union of all item types the Copilot mapper can produce. */
export type MappedCopilotItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

/** Result of mapping a single Copilot JSONL event. */
export interface CopilotMapResult {
    /** Mapped items to deliver on the bus. Always non-empty. */
    items: MappedCopilotItem[]
    /** Copilot `sessionId` observed on this event, if any. Carried only
     *  on the terminal `result` envelope. Used by the participant for
     *  session-id correlation (same role as Claude's `session_id`). */
    sessionId: string | null
}

/**
 * Map a single parsed Copilot JSONL event to typed Mozaik items.
 *
 * @param agentId - The baro agent ID (story ID) that owns this stream.
 * @param event - A parsed JSON object from Copilot's stdout.
 * @returns Mapped items and optional session ID.
 */
export function mapCopilotEvent(
    agentId: string,
    event: Record<string, any>,
): CopilotMapResult {
    const sessionId =
        typeof event.sessionId === "string" ? event.sessionId : null
    const items: MappedCopilotItem[] = []
    const type = typeof event.type === "string" ? event.type : ""
    const data: Record<string, any> =
        event.data && typeof event.data === "object" ? event.data : {}

    // ─── session.* lifecycle ───────────────────────────────────────
    if (type.startsWith("session.")) {
        items.push(
            CopilotSystem.create({
                agentId,
                subtype: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── assistant turn lifecycle ──────────────────────────────────
    if (type === "assistant.turn_start" || type === "assistant.turn_end") {
        items.push(
            CopilotSystem.create({
                agentId,
                subtype: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── assistant streaming partials (ephemeral) ──────────────────
    // message_start / message_delta carry the assistant text
    // incrementally; the consolidated text arrives on assistant.message.
    // Map them to CopilotItemEvent only so we don't double-count text.
    if (
        type === "assistant.message_start" ||
        type === "assistant.message_delta"
    ) {
        items.push(
            CopilotItemEvent.create({
                agentId,
                itemType: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── assistant final message ───────────────────────────────────
    // `data.content` is the full assistant text for this message. The
    // embedded `data.toolRequests` mirror the tool.execution_* pair, so
    // we deliberately don't map them here (avoids duplicate calls).
    if (type === "assistant.message") {
        const text = typeof data.content === "string" ? data.content : ""
        if (text) {
            items.push(ModelMessageItem.rehydrate({ text }))
        }
        items.push(
            CopilotItemEvent.create({
                agentId,
                itemType: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── user message echo ─────────────────────────────────────────
    // Copilot echoes the (transformed) user prompt back on the stream.
    // It's not assistant output, so it stays a lifecycle item event.
    if (type === "user.message") {
        items.push(
            CopilotItemEvent.create({
                agentId,
                itemType: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── tool invocation ───────────────────────────────────────────
    if (type === "tool.execution_start") {
        const callId = toolCallId(data)
        const name =
            typeof data.toolName === "string" ? data.toolName : "tool"
        const args = stringifyToolArgs(data.arguments)
        items.push(FunctionCallItem.rehydrate({ callId, name, args }))
        items.push(
            CopilotItemEvent.create({
                agentId,
                itemType: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── tool result ───────────────────────────────────────────────
    if (type === "tool.execution_complete") {
        const callId = toolCallId(data)
        const output = extractToolOutput(data)
        if (output !== null) {
            items.push(FunctionCallOutputItem.create(callId, output))
        }
        items.push(
            CopilotItemEvent.create({
                agentId,
                itemType: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── terminal result ───────────────────────────────────────────
    if (type === "result") {
        items.push(
            CopilotSystem.create({
                agentId,
                subtype: type,
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── unknown / future event type ───────────────────────────────
    items.push(
        CopilotUnknownEvent.create({
            agentId,
            copilotType: type || "unspecified",
            raw: event,
        }),
    )
    return { items, sessionId }
}

/** Best-effort stable id for a tool-call envelope's `data`. */
function toolCallId(data: Record<string, any>): string {
    if (typeof data.toolCallId === "string") return data.toolCallId
    if (typeof data.id === "string") return data.id
    const hint =
        typeof data.toolName === "string" ? data.toolName : "anon"
    return `copilot:tool:${hint}`
}

/** Render tool-call arguments to a string for FunctionCallItem.args. */
function stringifyToolArgs(args: unknown): string {
    if (args === undefined) return "{}"
    return typeof args === "string" ? args : JSON.stringify(args)
}

/**
 * Extract the tool result text from a `tool.execution_complete` payload.
 * Copilot wraps it as `data.result.content` (with a parallel
 * `detailedContent`); fall back through plausible shapes. Returns null
 * when no result text is present so the paired FunctionCallOutputItem is
 * emitted only when there's something to carry.
 */
function extractToolOutput(data: Record<string, any>): string | null {
    const result = data.result
    if (result && typeof result === "object") {
        const r = result as Record<string, unknown>
        if (typeof r.content === "string") return r.content
        if (typeof r.detailedContent === "string") return r.detailedContent
    }
    if (typeof data.result === "string") return data.result
    if (typeof data.output === "string") return data.output
    return null
}
