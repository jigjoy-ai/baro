/**
 * Map Pi CLI `pi --mode json -p --no-session` JSONL events to typed items
 * for bus delivery. Every input event maps to a non-empty array — nothing
 * is silently dropped. Wire format and full mapping table:
 * docs/stream-protocols.md ("Pi").
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "./runtime/mozaik.js"

import {
    PiItemEvent,
    PiSystem,
    PiTurnEvent,
    PiUnknownEvent,
} from "./semantic-events.js"

export type MappedPiItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

export interface PiMapResult {
    /** Always non-empty. */
    items: MappedPiItem[]
    /** Present only when the "session" event is parsed. */
    sessionId: string | null
}

// Pi's `session` envelope carries an ISO-8601 *string* timestamp (unlike
// OpenCode's numeric one) and `message_end` carries none at all.
function eventTimestamp(event: Record<string, unknown>): string {
    if (typeof event.timestamp === "number") return String(event.timestamp)
    if (typeof event.timestamp === "string" && event.timestamp) {
        return event.timestamp
    }
    return "0"
}

function extractToolOutput(event: Record<string, unknown>): string | undefined {
    const resultObj = event.result as Record<string, unknown> | undefined

    // A content array with at least one text block is authoritative even
    // when the joined text is "" (e.g. bash with no stdout is a legitimate
    // empty success) — only fall through when no text block exists at all.
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

    // Fallbacks for older/alternate shapes.
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

    // Last resort: dump the whole result object. Capped because a
    // pathological result can be huge; the normal path is never truncated.
    if (resultObj !== undefined) {
        const dump = JSON.stringify(resultObj)
        const MAX = 8 * 1024
        return dump.length > MAX
            ? `${dump.slice(0, MAX)}…[truncated]`
            : dump
    }
    return undefined
}

function resolveUpdateItemType(subtype: string): string {
    if (subtype.startsWith("text_")) return "text"
    if (subtype.startsWith("thinking_")) return "thinking"
    if (subtype.startsWith("toolcall_")) return "tool_call"
    return subtype
}

export function mapPiEvent(
    agentId: string,
    event: Record<string, unknown>,
): PiMapResult {
    const items: MappedPiItem[] = []
    const type = typeof event.type === "string" ? event.type : ""

    const sessionId =
        type === "session" && typeof event.id === "string" ? event.id : null

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

    // Deltas become PiItemEvents only — no ModelMessageItem here, or we'd
    // duplicate the final text re-delivered in message_end.
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

        // Emitted regardless of role so the turn lifecycle is complete.
        items.push(
            PiTurnEvent.create({
                agentId,
                turnType: "message_end",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    if (type === "tool_execution_start") {
        items.push(
            PiItemEvent.create({
                agentId,
                itemType: "tool_start",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    if (type === "tool_execution_update") {
        items.push(
            PiItemEvent.create({
                agentId,
                itemType: "tool_update",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

    // `toolCallId` equals the `id` of the toolCall block from message_end,
    // so call/output reconciliation is exact; legacy candidates are kept as
    // fallbacks against shape drift.
    if (type === "tool_execution_end") {
        const resultObj = event.result as Record<string, unknown> | undefined
        const outputObj = event.output as Record<string, unknown> | undefined
        const toolResultObj = event.toolResult as
            | Record<string, unknown>
            | undefined

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

        // Emit even with no extractable output text: the FunctionCallItem is
        // already on the bus from message_end, and skipping here would leave
        // a dangling unreconciled call (breaks audit replay). The [error]
        // prefix exists because this bus item has no dedicated error flag.
        if (callId !== undefined) {
            const isError = event.isError === true
            const body = outputStr ?? (isError ? "no output" : "")
            const finalOutput = isError ? `[error] ${body}` : body
            items.push(FunctionCallOutputItem.create(callId, finalOutput))
        }

        items.push(
            PiItemEvent.create({
                agentId,
                itemType: "tool_result",
                raw: event,
            }),
        )
        return { items, sessionId }
    }

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

    items.push(
        PiUnknownEvent.create({
            agentId,
            piType: type || "unspecified",
            raw: event,
        }),
    )
    return { items, sessionId }
}
