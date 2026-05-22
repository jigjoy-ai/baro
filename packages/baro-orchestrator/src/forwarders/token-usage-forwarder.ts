import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    AgentResult,
    CodexTurnEvent,
    type AgentResultData,
    type CodexTurnEventData,
} from "../semantic-events.js"
import { emit } from "../tui-protocol.js"

export class TokenUsageForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (AgentResult.is(event)) {
            this.handleAgentResult(event.data)
            return
        }
        if (CodexTurnEvent.is(event)) {
            this.handleCodexTurnEvent(event.data)
            return
        }
    }

    private handleAgentResult(item: AgentResultData): void {
        const usage = item.usage as
            | { input_tokens?: unknown; output_tokens?: unknown }
            | null
        const inputTokens = this.numberOrZero(usage?.input_tokens)
        const outputTokens = this.numberOrZero(usage?.output_tokens)

        emit({
            type: "token_usage",
            id: item.agentId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
        })
    }

    private handleCodexTurnEvent(item: CodexTurnEventData): void {
        if (item.phase !== "completed") return
        if (item.raw.usage == null) return

        const usage = item.raw.usage as {
            input_tokens?: unknown
            output_tokens?: unknown
            reasoning_output_tokens?: unknown
        }
        const inputTokens = this.numberOrZero(usage.input_tokens)
        const outputTokens =
            this.numberOrZero(usage.output_tokens) +
            this.numberOrZero(usage.reasoning_output_tokens)

        emit({
            type: "token_usage",
            id: item.agentId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
        })
    }

    private numberOrZero(value: unknown): number {
        return typeof value === "number" ? value : 0
    }
}
