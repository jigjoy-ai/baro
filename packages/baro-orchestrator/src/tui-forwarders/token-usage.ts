import { BaseObserver, type Participant, type SemanticEvent } from "@mozaik-ai/core"

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
        }
    }

    private handleAgentResult(item: AgentResultData): void {
        const usage = item.usage as
            | { input_tokens?: number; output_tokens?: number }
            | null
        const inputTokens =
            typeof usage?.input_tokens === "number" ? usage.input_tokens : 0
        const outputTokens =
            typeof usage?.output_tokens === "number" ? usage.output_tokens : 0

        emit({
            type: "token_usage",
            id: item.agentId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
        })
    }

    private handleCodexTurnEvent(item: CodexTurnEventData): void {
        if (item.phase !== "completed") return

        const usage = item.raw.usage as
            | {
                  input_tokens?: number
                  output_tokens?: number
                  reasoning_output_tokens?: number
              }
            | undefined
        const inputTokens =
            typeof usage?.input_tokens === "number" ? usage.input_tokens : 0
        const outputBase =
            typeof usage?.output_tokens === "number" ? usage.output_tokens : 0
        const reasoning =
            typeof usage?.reasoning_output_tokens === "number"
                ? usage.reasoning_output_tokens
                : 0

        emit({
            type: "token_usage",
            id: item.agentId,
            input_tokens: inputTokens,
            output_tokens: outputBase + reasoning,
        })
    }
}
