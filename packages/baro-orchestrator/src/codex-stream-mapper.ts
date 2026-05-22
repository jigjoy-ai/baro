/**
 * Map OpenAI Codex CLI `codex exec --json` stream events to typed items
 * for bus delivery. Sibling of `stream-json-mapper.ts` (the Claude
 * mapper).
 *
 * Codex stream shape — observed against real `codex exec --json` output
 * (M1 probe 2026-05-22, codex v0.133.0 on gpt-5.5). The docs use
 * `item.<type>` envelope names in prose, but the actual wire format is:
 *
 *   {"type":"thread.started", "thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started",   "item":{"id":"…","type":"<itemtype>", …}}
 *   {"type":"item.updated",   "item":{"id":"…", …}}        — for streaming
 *   {"type":"item.completed", "item":{"id":"…","type":"agent_message",
 *                                      "text":"…"}}
 *   {"type":"turn.completed", "usage":{
 *      "input_tokens":N,"cached_input_tokens":N,
 *      "output_tokens":N,"reasoning_output_tokens":N}}
 *   {"type":"thread.completed"}  — observed only on multi-turn sessions;
 *                                  one-shot exec ends at turn.completed
 *   {"type":"turn.failed",    "error":"…"}
 *   {"type":"error",          "message":"…"}
 *
 * The real `item.type` lives at `event.item.type`, not at envelope-level.
 * Inner item shape (per observed agent_message, plus inferred from docs
 * for the other subtypes — refined as we capture each kind):
 *
 *   agent_message:     {id, type, text}
 *   reasoning:         {id, type, text}                       (per docs)
 *   command_execution: {id, type, command, exit_code?, output?, aggregated_output?}
 *   file_change:       {id, type, path, diff?}
 *   mcp_tool_call:     {id, type, tool_name, arguments?, result?}
 *   web_search:        {id, type, query, results?}
 *   plan_update:       {id, type, plan: […]}
 *
 * Mapping strategy:
 *
 *   - Assistant-side messages map to Mozaik's `ModelMessageItem`.
 *   - Tool-shaped items (command_execution, file_change, mcp_tool_call,
 *     web_search) emit a `FunctionCallItem` for the invocation and, when
 *     the same envelope carries a result (exit code, output text), a
 *     paired `FunctionCallOutputItem`. Codex sometimes splits these into
 *     two events; the participant doesn't need them paired — both
 *     channels arrive on the bus and downstream observers (Critic,
 *     Librarian, kaleidoskop) reassemble.
 *   - thread.* and turn.* lifecycle events become typed `SemanticEvent`s
 *     (CodexSystem / CodexTurnEvent) carrying the raw envelope. The
 *     CodexCliParticipant uses these to drive AgentState transitions
 *     (idle → starting → running → done/failed).
 *   - Unknown / future event types fall through to CodexUnknownEvent so
 *     nothing is silently dropped — downstream tooling sees every
 *     envelope Codex produces.
 *
 * Every input event still maps to a non-empty array — we never silently
 * drop data. Once we capture a real Codex JSONL probe (M1–M3), this
 * mapper is updated to match exact field names from observed output.
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
    /** Codex `thread_id` observed on this event, if any. Used by the
     *  participant for session-id correlation (same role as Claude's
     *  `session_id`). */
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

    // ─── thread.* lifecycle ────────────────────────────────────────
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

    // ─── turn.* lifecycle ──────────────────────────────────────────
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

    // ─── error envelope ────────────────────────────────────────────
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

    // ─── item.* family ─────────────────────────────────────────────
    // Envelopes: item.started | item.updated | item.completed.
    // The inner item carries the real subtype + content.
    //
    // Mapping policy: emit Mozaik typed channels (ModelMessageItem,
    // FunctionCallItem, FunctionCallOutputItem) ONLY on item.completed.
    // item.started / item.updated are fired during streaming and either
    // carry partial state or just the envelope shell; we'd double-count
    // if we mapped them to typed channels too. They still go through
    // CodexItemEvent so observers see the streaming lifecycle.
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

        // Assistant message → ModelMessageItem.
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

        // Reasoning. No Mozaik ReasoningItem yet — surface as typed event.
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

        // Tool-shaped items.
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

        // plan_update and anything else → typed CodexItemEvent.
        items.push(
            CodexItemEvent.create({
                agentId,
                itemType: innerType,
                raw: event,
            }),
        )
        return { items, threadId }
    }

    // ─── unknown / future event type ───────────────────────────────
    items.push(
        CodexUnknownEvent.create({
            agentId,
            codexType: type || "unspecified",
            raw: event,
        }),
    )
    return { items, threadId }
}

/** Best-effort stable id for tool-call envelopes. */
function stringifyId(event: Record<string, any>): string {
    if (typeof event.id === "string") return event.id
    if (typeof event.call_id === "string") return event.call_id
    if (typeof event.item_id === "string") return event.item_id
    // Fall back to a synthetic id derived from type + a fragment of the
    // command/path so multiple FunctionCallOutputItem reattach to the
    // same FunctionCallItem when Codex doesn't supply one.
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
    // Construct the args object from likely fields, falling back to the
    // whole envelope minus the type tag.
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
    // Codex sometimes carries the result in the same envelope as the
    // invocation; sometimes it comes later. We emit a paired
    // FunctionCallOutputItem only when the result is present, otherwise
    // return null and rely on the next envelope.
    if (typeof event.output === "string") return event.output
    if (typeof event.aggregated_output === "string") {
        return event.aggregated_output
    }
    if (typeof event.result === "string") return event.result
    if (itemType === "command_execution" && typeof event.exit_code === "number") {
        // command_execution envelopes can lack the captured stdout
        // (per openai/codex#10141) but still carry an exit code. Surface
        // that as the output so the FunctionCallOutputItem is non-empty
        // and downstream Critic/Surgeon see "this command ran".
        return `exit_code=${event.exit_code}`
    }
    return null
}
