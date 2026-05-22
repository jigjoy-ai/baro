import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
} from "@mozaik-ai/core"

import { emit } from "../tui-protocol.js"

export class AgentLogForwarder extends BaseObserver {
    override async onExternalModelMessage(
        source: Participant,
        item: ModelMessageItem,
    ): Promise<void> {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        const json = item.toJSON() as { content: Array<{ text: string }> }
        const text = json.content?.[0]?.text ?? ""
        if (!text.trim()) return
        emitMultiline(agentId, text)
    }

    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        // Tool args can themselves contain newlines (multi-line file
        // contents in a Write call, embedded code blocks, etc). Split.
        emitMultiline(agentId, `[tool_call] ${item.name} ${item.args}`)
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        const json = item.toJSON() as {
            call_id: string
            output: Array<{ text: string }>
        }
        const text = json.output?.[0]?.text ?? ""
        emitMultiline(agentId, `[tool_result ${json.call_id}] ${text}`)
    }
}

/**
 * Emit a story_log per source line. Keeps the TUI clean (no embedded
 * `\n` rendered as ⏎ literals) and lets the log scrollbar work as
 * intended on long tool outputs.
 */
function emitMultiline(agentId: string, text: string): void {
    if (!text) return
    const lines = text.split("\n")
    for (const line of lines) {
        // Skip purely empty trailing lines but keep blank rows mid-block
        // so structure (e.g. paragraph breaks) survives.
        if (line.length === 0 && lines.length === 1) continue
        emit({ type: "story_log", id: agentId, line })
    }
}
