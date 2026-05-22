import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    type Participant,
} from "@mozaik-ai/core"

import { emit } from "../tui-protocol.js"

export class AgentLogForwarder extends BaseObserver {
    override async onExternalModelMessage(
        source: Participant,
        item: ModelMessageItem,
    ): Promise<void> {
        this.handleModelMessage(source, item)
    }

    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        this.handleToolCall(source, item)
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        this.handleToolResult(source, item)
    }

    private handleModelMessage(source: Participant, item: ModelMessageItem): void {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return

        const json = item.toJSON() as { content?: Array<{ text?: string }> }
        const text = json.content?.[0]?.text ?? ""
        if (!text.trim()) return

        emitMultiline(agentId, text)
    }

    private handleToolCall(source: Participant, item: FunctionCallItem): void {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return

        emitMultiline(agentId, `[tool_call] ${item.name} ${item.args}`)
    }

    private handleToolResult(
        source: Participant,
        item: FunctionCallOutputItem,
    ): void {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return

        const json = item.toJSON() as {
            call_id: string
            output?: Array<{ text?: string }>
        }
        const text = json.output?.[0]?.text ?? ""

        emitMultiline(agentId, `[tool_result ${json.call_id}] ${text}`)
    }
}

function emitMultiline(agentId: string, text: string): void {
    if (!text) return

    const lines = text.split("\n")
    for (const line of lines) {
        if (line.length === 0 && lines.length === 1) continue
        emit({ type: "story_log", id: agentId, line })
    }
}
