/**
 * Map ACP `session/update` payloads from `devin acp` to bus items. Message
 * chunks are buffered and delivered as one ModelMessageItem when the agent
 * moves on (a tool call) or the turn ends. Mapping table: docs/stream-protocols.md ("Devin").
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "../../runtime/mozaik.js"

import { DevinItemEvent } from "../../semantic-events.js"
import { record } from "./acp-turn.js"

export type MappedDevinItem =
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | SemanticEvent<unknown>

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed"])

export class DevinStreamMapper {
    private text = ""
    private readonly finishedCalls = new Set<string>()
    private readonly exitCodes = new Map<string, number>()
    /** Devin streams a command's output in in-progress updates; the final one carries none. */
    private readonly latestOutput = new Map<string, string>()
    private toolCalls = 0
    private toolSuccesses = 0

    constructor(private readonly agentId: string) {}

    get toolCallCount(): number {
        return this.toolCalls
    }

    /** Tool calls that ended `completed`, i.e. evidence the agent acted. */
    get toolSuccessCount(): number {
        return this.toolSuccesses
    }

    map(update: Record<string, unknown>): MappedDevinItem[] {
        const type = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "unknown"
        const items: MappedDevinItem[] = []
        if (type === "agent_message_chunk") {
            const content = record(update.content)
            if (content.type === "text" && typeof content.text === "string") {
                this.text += content.text
            }
        } else if (type === "tool_call") {
            items.push(...this.flush())
            const callId = toolCallId(update)
            if (callId) {
                this.toolCalls += 1
                const meta = record(update._meta)
                // Evidence collectors know shells by name; Devin calls its own `exec`.
                const name = update.kind === "execute"
                    ? "shell"
                    : stringOr(meta["cognition.ai/inferenceToolName"]) ??
                      stringOr(update.kind) ??
                      "tool"
                items.push(FunctionCallItem.rehydrate({
                    callId,
                    name,
                    args: JSON.stringify(update.rawInput ?? {}),
                }))
                // Devin may report the outcome on the call itself.
                items.push(...this.finishCall(callId, update))
            }
        } else if (type === "tool_call_update") {
            const callId = toolCallId(update)
            if (callId) {
                const exit = record(record(update._meta).terminal_exit).exit_code
                if (typeof exit === "number") this.exitCodes.set(callId, exit)
                const output = contentText(update.content)
                if (output) this.latestOutput.set(callId, output)
                items.push(...this.finishCall(callId, update))
            }
        }
        items.push(DevinItemEvent.create({ agentId: this.agentId, itemType: type, raw: update }))
        return items
    }

    /** Deliver buffered assistant text; called on tool calls and at turn end. */
    flush(): MappedDevinItem[] {
        const text = this.text
        this.text = ""
        return text.trim() ? [ModelMessageItem.rehydrate({ text })] : []
    }

    private finishCall(callId: string, update: Record<string, unknown>): MappedDevinItem[] {
        const status = stringOr(update.status)
        if (!status || !TERMINAL_TOOL_STATUSES.has(status) || this.finishedCalls.has(callId)) {
            return []
        }
        this.finishedCalls.add(callId)
        const exitCode = this.exitCodes.get(callId)
        const body = contentText(update.content) || this.latestOutput.get(callId) || ""
        this.latestOutput.delete(callId)
        if (exitCode !== undefined && exitCode !== 0) {
            return [FunctionCallOutputItem.create(callId, `[error] exit code ${exitCode}\n${body}`.trimEnd())]
        }
        const output = exitCode === 0 ? `${body}\n(exit code 0)`.trimStart() : body
        if (status === "completed") {
            this.toolSuccesses += 1
            return [FunctionCallOutputItem.create(callId, output)]
        }
        return [FunctionCallOutputItem.create(callId, `[error] ${output || "no output"}`)]
    }
}

function toolCallId(update: Record<string, unknown>): string | null {
    return stringOr(update.toolCallId)
}

function contentText(content: unknown): string {
    if (!Array.isArray(content)) return ""
    const parts: string[] = []
    for (const raw of content) {
        const block = record(raw)
        const inner = record(block.content)
        if (inner.type === "text" && typeof inner.text === "string") parts.push(inner.text)
        else if (typeof block.newText === "string") parts.push(block.newText)
    }
    return parts.join("\n")
}

function stringOr(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}
