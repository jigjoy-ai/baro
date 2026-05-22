/**
 * Forwards token-usage stats from Claude (`AgentResult`) and Codex
 * (`CodexTurnEvent` phase=completed) onto the TUI wire as `token_usage`
 * BaroEvents. Codex's `input_tokens` already includes
 * `cached_input_tokens`, so we don't re-add it here. Reasoning tokens
 * are billed as output by OpenAI and folded into `output_tokens`.
 */

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
            this.handleClaudeResult(event.data)
            return
        }
        if (CodexTurnEvent.is(event)) {
            this.handleCodexTurnEvent(event.data)
            return
        }
    }

    private handleClaudeResult(item: AgentResultData): void {
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
        const raw = item.raw as Record<string, unknown>
        const usage = raw.usage as
            | {
                  input_tokens?: number
                  cached_input_tokens?: number
                  output_tokens?: number
                  reasoning_output_tokens?: number
              }
            | undefined
        if (!usage) return
        const inputTokens =
            typeof usage.input_tokens === "number" ? usage.input_tokens : 0
        const outputBase =
            typeof usage.output_tokens === "number" ? usage.output_tokens : 0
        const reasoning =
            typeof usage.reasoning_output_tokens === "number"
                ? usage.reasoning_output_tokens
                : 0
        const outputTokens = outputBase + reasoning
        emit({
            type: "token_usage",
            id: item.agentId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
        })
    }
}
