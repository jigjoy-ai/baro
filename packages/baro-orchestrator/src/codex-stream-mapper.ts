/**
 * Map OpenAI Codex CLI `codex exec --json` stream events to typed items
 * for bus delivery. Sibling of `stream-json-mapper.ts` (the Claude
 * mapper).
 *
 * Codex stream shape (per OpenAI's docs at developers.openai.com/codex):
 *
 *   {"type":"thread.started", "thread_id":"…", …}
 *   {"type":"turn.started",   "turn_id":"…", …}
 *   {"type":"item.agent_message",     "text":"…", …}
 *   {"type":"item.reasoning",         "text":"…", …}
 *   {"type":"item.command_execution", "command":"…", "exit_code":0, …}
 *   {"type":"item.file_change",       "path":"…", "diff":"…", …}
 *   {"type":"item.mcp_tool_call",     "tool_name":"…", "arguments":{…}, …}
 *   {"type":"item.web_search",        "query":"…", "results":[…], …}
 *   {"type":"item.plan_update",       "plan":[…], …}
 *   {"type":"turn.completed",         …}
 *   {"type":"turn.failed",            "error":"…", …}
 *   {"type":"thread.completed",       …}
 *   {"type":"error",                  "message":"…", …}
 *
 * Mapping strategy (intentionally conservative for first pass — refined
 * as real Codex output is captured during M1–M3 probes):
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
    if (type.startsWith("item.")) {
        const itemType = type.slice("item.".length)

        // Assistant message → ModelMessageItem.
        if (itemType === "agent_message" || itemType === "message") {
            const text = typeof event.text === "string" ? event.text : ""
            if (text) {
                items.push(ModelMessageItem.rehydrate({ text }))
            }
            // Always emit the raw event too so observers see the full
            // envelope (metadata, role, etc.) — Mozaik's typed message
            // channel intentionally narrows the payload.
            items.push(
                CodexItemEvent.create({
                    agentId,
                    itemType,
                    raw: event,
                }),
            )
            return { items, threadId }
        }

        // Reasoning chunks. Could map to ModelMessageItem with a
        // distinguishing flag, but Mozaik doesn't yet have a "reasoning"
        // semantic channel. For first pass: emit as a typed item event
        // and let observers decide. Future: introduce a ReasoningItem
        // upstream.
        if (itemType === "reasoning") {
            items.push(
                CodexItemEvent.create({
                    agentId,
                    itemType,
                    raw: event,
                }),
            )
            return { items, threadId }
        }

        // Tool-shaped items. Codex represents shell exec, file edits,
        // MCP calls, and web searches as item.* envelopes. We model each
        // as a FunctionCallItem (invocation) optionally followed by a
        // FunctionCallOutputItem (result). Whether one envelope carries
        // both, or they arrive as two separate envelopes, is something
        // M1–M3 probes will pin down — for now we treat each as a self-
        // contained invocation+result and hand the raw event along.
        if (
            itemType === "command_execution" ||
            itemType === "file_change" ||
            itemType === "mcp_tool_call" ||
            itemType === "web_search"
        ) {
            const callId = stringifyId(event)
            const name = inferToolName(itemType, event)
            const args = inferToolArgs(event)
            items.push(FunctionCallItem.rehydrate({ callId, name, args }))

            const output = inferToolOutput(itemType, event)
            if (output !== null) {
                items.push(FunctionCallOutputItem.create(callId, output))
            }

            items.push(
                CodexItemEvent.create({
                    agentId,
                    itemType,
                    raw: event,
                }),
            )
            return { items, threadId }
        }

        // plan_update and any other item.* subtype → generic
        // CodexItemEvent so observers can react without us claiming we
        // understand the structure yet.
        items.push(
            CodexItemEvent.create({
                agentId,
                itemType,
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
