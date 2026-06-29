import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    AgentResult,
    type AgentResultData,
    ClaudeStreamChunk,
    type ClaudeStreamChunkData,
    CodexTurnEvent,
    type CodexTurnEventData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

// Don't flood the event stream with sub-turn progress: at most one
// token_progress per agent per this interval (the dashboard polls ~2s anyway).
const PROGRESS_THROTTLE_MS = 1500

/**
 * Mirrors agent usage accounting as `token_usage` BaroEvents for the Rust TUI.
 *
 * Subscribes to: AgentResult, CodexTurnEvent (authoritative per-turn totals),
 * and ClaudeStreamChunk (live, sub-turn estimates so the UI can show tokens
 * climbing while a Claude story runs — codex/openai already update per-turn).
 *
 * Emits: token_usage (authoritative, summed downstream) and token_progress
 * (latest cumulative snapshot per agent; consumers take the max, not a sum).
 */
export class TokenUsageForwarder extends BaseObserver {
    // Per-agent live accumulator for Claude streaming. Claude reports
    // output_tokens cumulatively *within a message*, restarting each turn — so
    // we carry committed output across turns and add the current message's count.
    // We track OUTPUT only: per-message input_tokens includes the whole replayed
    // context, so summing it across turns would wildly over-count. Input comes
    // from the authoritative token_usage total at the end instead.
    private readonly live = new Map<
        string,
        { committedOut: number; curOut: number; lastEmit: number }
    >()

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
        if (ClaudeStreamChunk.is(event)) {
            this.handleStreamChunk(event.data)
            return
        }
    }

    private handleStreamChunk(item: ClaudeStreamChunkData): void {
        // raw is the stream-json `stream_event` envelope; the nested `event` is
        // the Anthropic SSE frame (message_start / message_delta / …).
        const inner = (item.raw.event ?? item.raw) as Record<string, unknown>
        const type = typeof inner.type === "string" ? inner.type : ""
        const num = (v: unknown) => (typeof v === "number" ? v : 0)
        const st =
            this.live.get(item.agentId) ?? { committedOut: 0, curOut: 0, lastEmit: 0 }
        if (type === "message_start") {
            // New message: bank the finished message's output, then seed from this one.
            st.committedOut += st.curOut
            const msg = (inner.message ?? {}) as { usage?: Record<string, unknown> }
            st.curOut = num((msg.usage ?? {}).output_tokens)
        } else if (type === "message_delta") {
            const usage = (inner.usage ?? {}) as Record<string, unknown>
            st.curOut = num(usage.output_tokens) || st.curOut
        } else {
            this.live.set(item.agentId, st)
            return
        }
        this.live.set(item.agentId, st)
        const now = Date.now()
        if (type !== "message_start" && now - st.lastEmit < PROGRESS_THROTTLE_MS) return
        st.lastEmit = now
        emit({
            type: "token_progress",
            id: item.agentId,
            input_tokens: 0, // input comes from the authoritative total; see above
            output_tokens: st.committedOut + st.curOut,
        })
    }

    private handleClaudeResult(item: AgentResultData): void {
        const usage = item.usage as
            | { input_tokens?: number; output_tokens?: number }
            | null
        const inputTokens =
            typeof usage?.input_tokens === "number" ? usage.input_tokens : 0
        const outputTokens =
            typeof usage?.output_tokens === "number"
                ? usage.output_tokens
                : 0
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
