/**
 * Map Claude Code CLI stream-json events to typed items for bus delivery.
 *
 * Strategy: assistant-side messages and tool I/O map cleanly onto Mozaik
 * built-in items (ModelMessageItem, FunctionCallItem,
 * FunctionCallOutputItem), which `ClaudeCliParticipant` dispatches via
 * the matching `env.deliverModelMessage` / `deliverFunctionCall` /
 * `deliverFunctionCallOutput` channels in Mozaik 3.9+. The rest
 * (user-side messages, system frames, result frames, rate-limits,
 * stream chunks, unknowns) become baro-specific `BusEvent` subclasses
 * because Mozaik 3.9 doesn't expose typed channels for them.
 *
 * Every input event still maps to a non-empty array — we never silently
 * drop data. Tested against real spike logs in
 * `packages/baro-app/scripts/spike-logs/`.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
} from "@mozaik-ai/core"

import { BusEvent } from "./bus.js"
import {
    AgentUserMessageItem,
    ClaudeRateLimitItem,
    ClaudeResultItem,
    ClaudeStreamChunkItem,
    ClaudeSystemItem,
    ClaudeUnknownEventItem,
} from "./types.js"

/**
 * Union of every kind of item the mapper can produce. Mozaik built-in
 * types are dispatched via their native bus channels; `BusEvent` ones
 * via `deliverBusEvent`.
 */
export type MappedItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | BusEvent

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
                new ClaudeSystemItem(
                    agentId,
                    typeof event.subtype === "string" ? event.subtype : "unknown",
                    event,
                ),
            )
            break
        }

        case "rate_limit_event": {
            items.push(new ClaudeRateLimitItem(agentId, event))
            break
        }

        case "stream_event": {
            items.push(new ClaudeStreamChunkItem(agentId, event))
            break
        }

        case "user": {
            // The `user` event carries either:
            //   1. an input replay  (message.content: string)
            //   2. a tool_result    (message.content: [{type:"tool_result",...}])
            const content = event?.message?.content
            if (typeof content === "string") {
                items.push(new AgentUserMessageItem(agentId, content))
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
            // `assistant` carries an array of content blocks. Each block is
            // either a `text` (→ ModelMessageItem) or a `tool_use`
            // (→ FunctionCallItem). One `assistant` event can produce both.
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
                new ClaudeResultItem(
                    agentId,
                    typeof event.subtype === "string" ? event.subtype : "unknown",
                    sessionId,
                    Boolean(event.is_error),
                    typeof event.result === "string" ? event.result : null,
                    event.usage ?? null,
                    typeof event.total_cost_usd === "number"
                        ? event.total_cost_usd
                        : null,
                    typeof event.num_turns === "number" ? event.num_turns : null,
                    typeof event.duration_ms === "number"
                        ? event.duration_ms
                        : null,
                    event,
                ),
            )
            break
        }

        default: {
            const unknownType =
                typeof event.type === "string" ? event.type : "unspecified"
            items.push(new ClaudeUnknownEventItem(agentId, unknownType, event))
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
