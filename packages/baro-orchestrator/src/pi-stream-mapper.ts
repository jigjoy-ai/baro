/**
 * Map Pi CLI `pi --mode json -p --no-session` stream events to typed
 * items for bus delivery. Sibling of `opencode-stream-mapper.ts` (the
 * OpenCode mapper) and `stream-json-mapper.ts` (the Claude mapper).
 *
 * Pi stream shape — observed against real `pi --mode json -p --no-session`
 * output. Each stdout line is a JSONL envelope:
 *
 *   {"type":"session","version":3,"id":"<uuid>","timestamp":"ISO","cwd":"…"}
 *   {"type":"agent_start"}
 *   {"type":"turn_start"}
 *   {"type":"message_start","message":{"role":"user"|"assistant","content":[…]}}
 *   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…",…},"message":{…}}
 *   {"type":"tool_execution_start"}
 *   {"type":"tool_execution_update"}
 *   {"type":"tool_execution_end","result":…}
 *   {"type":"message_end","message":{"role":"assistant","content":[…],"usage":{…}}}
 *   {"type":"turn_end","message":{…},"toolResults":[…]}
 *   {"type":"agent_end","messages":[…],"willRetry":false}
 *
 * NOTE: Pi differs from OpenCode in several important ways:
 *  - Session id lives only on the "session" event (field `id`), not on
 *    every envelope.
 *  - Assistant content arrives as streaming deltas via message_update, then
 *    is re-delivered as a finalised block list in message_end. We emit
 *    PiItemEvent for every delta (so nothing is dropped from the bus) but
 *    emit ModelMessageItem / FunctionCallItem only from the final message_end
 *    to avoid duplicates.
 *  - Tool calls and their results are split across separate events:
 *    toolCall blocks (with field `id`) appear in message_end content, while
 *    actual outputs appear in tool_execution_end (with field `toolCallId`).
 *    Those two ids are equal, so call/output reconciliation is exact;
 *    fallback fields are kept only for resilience against shape drift.
 *
 * Mapping strategy:
 *
 *   - "session"               → PiSystem subtype "session" (+ captures id).
 *   - "agent_start"           → PiSystem subtype "agent_start".
 *   - "turn_start"            → PiSystem subtype "turn_start".
 *   - "message_start"         → PiTurnEvent turnType "message_start".
 *   - "message_update"        → PiItemEvent (itemType derived from
 *                               assistantMessageEvent.type: text_* → "text",
 *                               thinking_* → "thinking", toolcall_* →
 *                               "tool_call", other → raw subtype string).
 *   - "message_end" (asst)    → ModelMessageItem(s) + FunctionCallItem(s)
 *                               from content blocks + PiTurnEvent "message_end".
 *   - "message_end" (user)    → PiTurnEvent "message_end" (turn lifecycle
 *                               record only; no content items extracted).
 *   - "tool_execution_start"  → PiItemEvent itemType "tool_result" (raw).
 *   - "tool_execution_update" → PiItemEvent itemType "tool_result" (raw).
 *   - "tool_execution_end"    → FunctionCallOutputItem (callId from
 *                               `toolCallId`, output from result.content[].text)
 *                               + PiItemEvent itemType "tool_result".
 *   - "turn_end"              → PiTurnEvent turnType "turn_end".
 *   - "agent_end"             → PiSystem subtype "agent_end".
 *   - Unknown                 → PiUnknownEvent so nothing is silently dropped.
 *
 * Every input event maps to a non-empty array — we never silently drop
 * data. Downstream observers (audit log, kaleidoskop replay, debug
 * consoles) see every envelope Pi produces.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    PiItemEvent,
    PiSystem,
    PiTurnEvent,
    PiUnknownEvent,
} from "./semantic-events.js"

/** Union of all item types the Pi mapper can produce. */
export type MappedPiItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

/** Result of mapping a single Pi JSONL event. */
export interface PiMapResult {
    /** Mapped items to deliver on the bus. Always non-empty. */
    items: MappedPiItem[]
    /** Pi session id, present only when the "session" event is parsed. */
    sessionId: string | null
}

/**
 * Best-effort stable id suffix from an event's own timestamp field.
 * Pi's `session` envelope carries an ISO-8601 *string* timestamp (unlike
 * OpenCode's numeric one) and `message_end` carries none at all, so accept
 * both number and string and fall back to "0" only when truly absent.
 */
function eventTimestamp(event: Record<string, unknown>): string {
    if (typeof event.timestamp === "number") return String(event.timestamp)
    if (typeof event.timestamp === "string" && event.timestamp) {
        return event.timestamp
    }
    return "0"
}

/**
 * Extract the human-readable output text from a tool_execution_end envelope.
 *
 * Real Pi shape: `event.result.content` is an array of {type:"text",text}.
 * We concatenate every text block. Legacy/alternate shapes (a plain string
 * output, or a nested `output` field) are honoured as fallbacks. Returns
 * undefined only when no usable output could be found at all.
 */
function extractToolOutput(event: Record<string, unknown>): string | undefined {
    const resultObj = event.result as Record<string, unknown> | undefined

    // Primary: result.content[] of {type:"text",text}. A content array that
    // contains at least one text block is authoritative — return its joined
    // text even when that text is the empty string (e.g. `bash` with no
    // stdout is a legitimate empty success, NOT "no usable output"). Only
    // fall through to the fallbacks when the array carried no text block at
    // all, so we never mis-dump the whole envelope over a real empty result.
    const content = resultObj?.content
    if (Array.isArray(content)) {
        const texts: string[] = []
        let sawTextBlock = false
        for (const block of content) {
            if (
                block !== null &&
                typeof block === "object" &&
                !Array.isArray(block)
            ) {
                const b = block as Record<string, unknown>
                if (b.type === "text" && typeof b.text === "string") {
                    texts.push(b.text)
                    sawTextBlock = true
                }
            }
        }
        if (sawTextBlock) return texts.join("")
    }

    // Fallbacks (older/alternate shapes): plain string outputs first.
    const outputObj = event.output as Record<string, unknown> | undefined
    const toolResultObj = event.toolResult as
        | Record<string, unknown>
        | undefined
    const candidates: unknown[] = [
        event.output,
        resultObj?.output,
        outputObj?.output,
        toolResultObj?.output,
        resultObj?.result,
    ]
    for (const c of candidates) {
        if (typeof c === "string") return c
    }

    // Last resort: stringify the whole result object so nothing is lost.
    // Cap this fallback — a pathological tool result could be arbitrarily
    // large, and unlike the real content[].text path above this is only a
    // best-effort dump. Same defensive spirit as the .slice() guards used
    // elsewhere. The normal output path is never truncated.
    if (resultObj !== undefined) {
        const dump = JSON.stringify(resultObj)
        const MAX = 8 * 1024
        return dump.length > MAX
            ? `${dump.slice(0, MAX)}…[truncated]`
            : dump
    }
    return undefined
}

/**
 * Derive a PiItemEvent itemType string from the assistantMessageEvent.type
 * field found inside a "message_update" envelope.
 */
function resolveUpdateItemType(subtype: string): string {
    if (subtype.startsWith("text_")) return "text"
    if (subtype.startsWith("thinking_")) return "thinking"
    if (subtype.startsWith("toolcall_")) return "tool_call"
    return subtype
}

/**
 * Map a single parsed Pi JSONL event to typed Mozaik items.
 *
 * @param agentId - The baro agent ID (story ID) that owns this stream.
 * @param event   - A parsed JSON object from Pi's stdout.
 * @returns Mapped items and optional session ID.
 */
export function mapPiEvent(
    agentId: string,
    event: Record<string, unknown>,
): PiMapResult {
    const items: MappedPiItem[] = []
    const type = typeof event.type === "string" ? event.type : ""

    // sessionId is only present on the "session" envelope.
    const sessionId =
        type === "session" && typeof event.id === "string" ? event.id : null

    // ─── session ───────────────────────────────────────────────────
    if (type === "session") {
        items.push(
            PiSystem.create({
                agentId,
                subtype: "session",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── agent_start ───────────────────────────────────────────────
    if (type === "agent_start") {
        items.push(
            PiSystem.create({
                agentId,
                subtype: "agent_start",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── turn_start ────────────────────────────────────────────────
    if (type === "turn_start") {
        items.push(
            PiSystem.create({
                agentId,
                subtype: "turn_start",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── message_start ────────────────────────────────────────────
    if (type === "message_start") {
        items.push(
            PiTurnEvent.create({
                agentId,
                turnType: "message_start",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── message_update (streaming deltas) ────────────────────────
    // Deltas are noisy — we emit one PiItemEvent per update so the bus
    // sees every packet, but we do NOT emit ModelMessageItem here to
    // avoid duplicating the final text from message_end.
    if (type === "message_update") {
        const ame = event.assistantMessageEvent as
            | Record<string, unknown>
            | undefined
        const subtype =
            typeof ame?.type === "string" ? ame.type : "unknown_delta"
        items.push(
            PiItemEvent.create({
                agentId,
                itemType: resolveUpdateItemType(subtype),
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── message_end ──────────────────────────────────────────────
    // The message object carries the final, resolved content blocks.
    // For assistant messages we extract text + toolCall blocks into
    // first-class Mozaik items. For user messages we just record a
    // turn event for symmetry.
    if (type === "message_end") {
        const message = event.message as Record<string, unknown> | undefined
        const role = typeof message?.role === "string" ? message.role : ""

        if (role === "assistant") {
            const content = Array.isArray(message?.content)
                ? (message.content as unknown[])
                : []

            for (let i = 0; i < content.length; i++) {
                const block = content[i]
                if (
                    block === null ||
                    typeof block !== "object" ||
                    Array.isArray(block)
                ) {
                    continue
                }
                const b = block as Record<string, unknown>
                const blockType = typeof b.type === "string" ? b.type : ""

                if (blockType === "text") {
                    const text = typeof b.text === "string" ? b.text : ""
                    if (text) {
                        items.push(ModelMessageItem.rehydrate({ text }))
                    }
                } else if (blockType === "toolCall") {
                    // Include the block index in the fallback so multiple
                    // id-less toolCall blocks in one message_end don't all
                    // collapse onto the same synthetic callId.
                    const callId =
                        typeof b.id === "string"
                            ? b.id
                            : `pi:${eventTimestamp(event)}:${i}`
                    const name =
                        typeof b.name === "string" ? b.name : "unknown"
                    const args =
                        b.arguments !== undefined
                            ? typeof b.arguments === "string"
                                ? b.arguments
                                : JSON.stringify(b.arguments)
                            : "{}"
                    items.push(
                        FunctionCallItem.rehydrate({ callId, name, args }),
                    )
                }
            }
        }

        // Always emit the turn event regardless of role so the bus has
        // a complete turn lifecycle record.
        items.push(
            PiTurnEvent.create({
                agentId,
                turnType: "message_end",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── tool_execution_start ─────────────────────────────────────
    if (type === "tool_execution_start") {
        items.push(
            PiItemEvent.create({
                agentId,
                itemType: "tool_result",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── tool_execution_update ────────────────────────────────────
    if (type === "tool_execution_update") {
        items.push(
            PiItemEvent.create({
                agentId,
                itemType: "tool_result",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── tool_execution_end ───────────────────────────────────────
    // Real Pi shape (verified against live output):
    //   {"type":"tool_execution_end","toolCallId":"call_…","toolName":"bash",
    //    "result":{"content":[{"type":"text","text":"hello\n"}]},"isError":false}
    // The `toolCallId` here EQUALS the `id` of the toolCall block emitted in
    // message_end, so call/output reconciliation works. The output text lives
    // in result.content[].text — concatenate those rather than stringifying
    // the whole result object. Fallbacks remain for forward/backward compat.
    if (type === "tool_execution_end") {
        const resultObj = event.result as Record<string, unknown> | undefined
        const outputObj = event.output as Record<string, unknown> | undefined
        const toolResultObj = event.toolResult as
            | Record<string, unknown>
            | undefined

        // Primary field is `toolCallId`; keep legacy `callId` candidates as
        // fallbacks so we degrade gracefully if Pi's shape shifts.
        const callId: string | undefined =
            typeof event.toolCallId === "string"
                ? event.toolCallId
                : typeof event.callId === "string"
                  ? event.callId
                  : typeof resultObj?.callId === "string"
                    ? resultObj.callId
                    : typeof outputObj?.callId === "string"
                      ? outputObj.callId
                      : typeof toolResultObj?.callId === "string"
                        ? toolResultObj.callId
                        : undefined

        const outputStr = extractToolOutput(event)

        // Emit the output whenever we have a callId — even if no output text
        // could be extracted. The matching FunctionCallItem was already put on
        // the bus from message_end; skipping the output here would leave a
        // dangling, unreconciled tool call (breaks audit replay and any
        // model-side transcript reconstruction). Default to empty string; on
        // an error result with no body, surface the failure explicitly.
        if (callId !== undefined) {
            const isError = event.isError === true
            const body = outputStr ?? (isError ? "no output" : "")
            // Prefix on error so downstream readers can tell a failed tool
            // run apart from a successful one (the bus item carries no
            // dedicated error flag for this type).
            const finalOutput = isError ? `[error] ${body}` : body
            items.push(FunctionCallOutputItem.create(callId, finalOutput))
        }

        // Always emit the item event — carries the raw envelope for audit.
        items.push(
            PiItemEvent.create({
                agentId,
                itemType: "tool_result",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── turn_end ─────────────────────────────────────────────────
    if (type === "turn_end") {
        items.push(
            PiTurnEvent.create({
                agentId,
                turnType: "turn_end",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── agent_end ────────────────────────────────────────────────
    if (type === "agent_end") {
        items.push(
            PiSystem.create({
                agentId,
                subtype: "agent_end",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // ─── unknown / future event type ──────────────────────────────
    items.push(
        PiUnknownEvent.create({
            agentId,
            piType: type || "unspecified",
            raw: event,
        }),
    )
    return { items, sessionId }
}
