/**
 * Map OpenAI Codex CLI `codex exec --json` JSONL events to typed items
 * for bus delivery. Every input event maps to a non-empty array — nothing
 * is silently dropped. Wire format and full mapping table:
 * docs/stream-protocols.md ("Codex").
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    CodexItemEvent,
    CodexSystem,
    CodexTurnEvent,
    CodexUnknownEvent,
} from "./semantic-events.js"

export type MappedCodexItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

export interface CodexMapResult {
    items: MappedCodexItem[]
    /** Same session-correlation role as Claude's `session_id`. */
    threadId: string | null
}

export function mapCodexEvent(
    agentId: string,
    event: Record<string, any>,
): CodexMapResult {
    const threadId =
        typeof event.thread_id === "string" ? event.thread_id : null
    const items: MappedCodexItem[] = []
    const type = typeof event.type === "string" ? event.type : ""

    if (type === "thread.started" || type === "thread.completed") {
        items.push(
            CodexSystem.create({
                agentId,
                subtype: type,
                raw: event,
            }),
        )
        return { items, threadId }
    }

    if (
        type === "turn.started" ||
        type === "turn.completed" ||
        type === "turn.failed"
    ) {
        items.push(
            CodexTurnEvent.create({
                agentId,
                phase: type.slice("turn.".length),
                raw: event,
            }),
        )
        return { items, threadId }
    }

    if (type === "error") {
        items.push(
            CodexSystem.create({
                agentId,
                subtype: "error",
                raw: event,
            }),
        )
        return { items, threadId }
    }

    // Typed channels are emitted ONLY on item.completed — started/updated
    // carry partial state and would double-count. They still pass through
    // as CodexItemEvent so observers see the streaming lifecycle.
    if (type === "item.started" || type === "item.updated") {
        const inner =
            event.item && typeof event.item === "object"
                ? (event.item as Record<string, unknown>)
                : {}
        const innerType =
            typeof inner.type === "string" ? inner.type : "unknown"
        items.push(
            CodexItemEvent.create({
                agentId,
                itemType: `${type.slice("item.".length)}:${innerType}`,
                raw: event,
            }),
        )
        return { items, threadId }
    }

    if (type === "item.completed") {
        const inner =
            event.item && typeof event.item === "object"
                ? (event.item as Record<string, any>)
                : {}
        const innerType =
            typeof inner.type === "string" ? inner.type : "unknown"

        if (innerType === "agent_message" || innerType === "message") {
            const text = typeof inner.text === "string" ? inner.text : ""
            if (text) {
                items.push(ModelMessageItem.rehydrate({ text }))
            }
            items.push(
                CodexItemEvent.create({
                    agentId,
                    itemType: innerType,
                    raw: event,
                }),
            )
            return { items, threadId }
        }

        // No Mozaik ReasoningItem exists yet — surface as typed event.
        if (innerType === "reasoning") {
            items.push(
                CodexItemEvent.create({
                    agentId,
                    itemType: innerType,
                    raw: event,
                }),
            )
            return { items, threadId }
        }

        if (
            innerType === "command_execution" ||
            innerType === "file_change" ||
            innerType === "mcp_tool_call" ||
            innerType === "web_search"
        ) {
            const callId = stringifyId(inner)
            const name = inferToolName(innerType, inner)
            const args = inferToolArgs(inner)
            items.push(FunctionCallItem.rehydrate({ callId, name, args }))

            const output = inferToolOutput(innerType, inner)
            if (output !== null) {
                items.push(FunctionCallOutputItem.create(callId, output))
            }

            items.push(
                CodexItemEvent.create({
                    agentId,
                    itemType: innerType,
                    raw: event,
                }),
            )
            return { items, threadId }
        }

        items.push(
            CodexItemEvent.create({
                agentId,
                itemType: innerType,
                raw: event,
            }),
        )
        return { items, threadId }
    }

    items.push(
        CodexUnknownEvent.create({
            agentId,
            codexType: type || "unspecified",
            raw: event,
        }),
    )
    return { items, threadId }
}

function stringifyId(event: Record<string, any>): string {
    if (typeof event.id === "string") return event.id
    if (typeof event.call_id === "string") return event.call_id
    if (typeof event.item_id === "string") return event.item_id
    // Synthetic id must be stable so FunctionCallOutputItems reattach to
    // the same FunctionCallItem when Codex doesn't supply one.
    const hint =
        typeof event.command === "string"
            ? event.command.slice(0, 32)
            : typeof event.path === "string"
                ? event.path
                : typeof event.tool_name === "string"
                    ? event.tool_name
                    : "anon"
    return `codex:${event.type ?? "item"}:${hint}`
}

function inferToolName(itemType: string, event: Record<string, any>): string {
    if (typeof event.tool_name === "string") return event.tool_name
    switch (itemType) {
        case "command_execution":
            return "shell"
        case "file_change":
            return "edit"
        case "web_search":
            return "web_search"
        default:
            return itemType
    }
}

function inferToolArgs(event: Record<string, any>): string {
    if (event.arguments !== undefined) {
        return typeof event.arguments === "string"
            ? event.arguments
            : JSON.stringify(event.arguments)
    }
    const candidate: Record<string, unknown> = {}
    for (const key of ["command", "path", "diff", "query"]) {
        if (event[key] !== undefined) candidate[key] = event[key]
    }
    if (Object.keys(candidate).length > 0) return JSON.stringify(candidate)
    const { type: _t, ...rest } = event
    return JSON.stringify(rest)
}

function inferToolOutput(
    itemType: string,
    event: Record<string, any>,
): string | null {
    // Codex sometimes carries the result in the invocation envelope,
    // sometimes later — null means "rely on the next envelope".
    if (typeof event.output === "string") return event.output
    if (typeof event.aggregated_output === "string") {
        return event.aggregated_output
    }
    if (typeof event.result === "string") return event.result
    if (itemType === "command_execution" && typeof event.exit_code === "number") {
        // Codex can omit captured stdout (openai/codex#10141) yet carry an
        // exit code — surface it so Critic/Surgeon see "this command ran".
        return `exit_code=${event.exit_code}`
    }
    return null
}
