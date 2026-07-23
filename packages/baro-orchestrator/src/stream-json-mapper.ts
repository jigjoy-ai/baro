/**
 * Map Claude Code CLI stream-json events to typed items for bus delivery.
 * Every input event maps to a non-empty array — nothing is silently
 * dropped. Wire format and full mapping table: docs/stream-protocols.md
 * ("Claude Code").
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "./runtime/mozaik.js"

import {
    AgentResult,
    AgentUserMessage,
    ClaudeRateLimit,
    ClaudeStreamChunk,
    ClaudeSystem,
    ClaudeUnknownEvent,
} from "./semantic-events.js"

// Mozaik built-in types dispatch via their native bus channels;
// SemanticEvents via deliverSemanticEvent.
export type MappedItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

export interface MapResult {
    items: MappedItem[]
    /** session_id observed on this event, if any. */
    sessionId: string | null
}

export function mapClaudeEvent(
    agentId: string,
    event: Record<string, any>,
): MapResult {
    const sessionId =
        typeof event.session_id === "string" ? event.session_id : null
    const items: MappedItem[] = []

    switch (event.type) {
        case "system": {
            items.push(
                ClaudeSystem.create({
                    agentId,
                    subtype:
                        typeof event.subtype === "string" ? event.subtype : "unknown",
                    raw: event,
                }),
            )
            break
        }

        case "rate_limit_event": {
            items.push(ClaudeRateLimit.create({ agentId, raw: event }))
            break
        }

        case "stream_event": {
            items.push(ClaudeStreamChunk.create({ agentId, raw: event }))
            break
        }

        case "user": {
            // Either an input replay (content: string) or tool_result blocks.
            const content = event?.message?.content
            if (typeof content === "string") {
                items.push(AgentUserMessage.create({ agentId, text: content }))
            } else if (Array.isArray(content)) {
                for (const block of content) {
                    if (
                        block &&
                        typeof block === "object" &&
                        block.type === "tool_result"
                    ) {
                        const toolUseId =
                            typeof block.tool_use_id === "string"
                                ? block.tool_use_id
                                : ""
                        const output = stringifyToolResultContent(block.content)
                        items.push(FunctionCallOutputItem.create(toolUseId, output))
                    }
                }
            }
            break
        }

        case "assistant": {
            // One assistant event can produce both text and tool_use items.
            const blocks = event?.message?.content
            if (Array.isArray(blocks)) {
                for (const block of blocks) {
                    if (!block || typeof block !== "object") continue
                    if (block.type === "text" && typeof block.text === "string") {
                        items.push(ModelMessageItem.rehydrate({ text: block.text }))
                    } else if (block.type === "tool_use") {
                        const callId =
                            typeof block.id === "string" ? block.id : ""
                        const name =
                            typeof block.name === "string" ? block.name : ""
                        const args =
                            block.input !== undefined
                                ? JSON.stringify(block.input)
                                : "{}"
                        items.push(
                            FunctionCallItem.rehydrate({ callId, name, args }),
                        )
                    }
                }
            }
            break
        }

        case "result": {
            items.push(
                AgentResult.create({
                    agentId,
                    subtype:
                        typeof event.subtype === "string" ? event.subtype : "unknown",
                    sessionId,
                    isError: Boolean(event.is_error),
                    resultText:
                        typeof event.result === "string" ? event.result : null,
                    usage: event.usage ?? null,
                    totalCostUsd:
                        typeof event.total_cost_usd === "number"
                            ? event.total_cost_usd
                            : null,
                    numTurns:
                        typeof event.num_turns === "number" ? event.num_turns : null,
                    durationMs:
                        typeof event.duration_ms === "number"
                            ? event.duration_ms
                            : null,
                }),
            )
            break
        }

        default: {
            const unknownType =
                typeof event.type === "string" ? event.type : "unspecified"
            items.push(
                ClaudeUnknownEvent.create({
                    agentId,
                    claudeType: unknownType,
                    raw: event,
                }),
            )
        }
    }

    return { items, sessionId }
}

function stringifyToolResultContent(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
        const parts: string[] = []
        for (const block of content) {
            if (
                block &&
                typeof block === "object" &&
                "text" in (block as Record<string, unknown>) &&
                typeof (block as { text: unknown }).text === "string"
            ) {
                parts.push((block as { text: string }).text)
            } else {
                parts.push(JSON.stringify(block))
            }
        }
        return parts.join("\n")
    }
    if (content == null) return ""
    return JSON.stringify(content)
}
