/** Worker/provider stream events: agent turns and per-harness passthrough. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

// Agent lifecycle

export type AgentPhase =
    | "idle"
    | "starting"
    | "running"
    | "waiting"
    | "done"
    | "failed"
    | "aborted"

export interface AgentStateData {
    agentId: string
    phase: AgentPhase
    detail?: string
}

export const AgentState = defineSemanticEvent<AgentStateData>("agent_state")

// Claude CLI passthrough types

export interface AgentUserMessageData {
    agentId: string
    text: string
}

export const AgentUserMessage =
    defineSemanticEvent<AgentUserMessageData>("agent_user_message")

export interface ClaudeSystemData {
    agentId: string
    subtype: string
    raw: Readonly<Record<string, unknown>>
}

export const ClaudeSystem = defineSemanticEvent<ClaudeSystemData>("claude_system")

/**
 * Claude `result` event (one per agent turn). Wire type stays
 * `claude_result` for audit-log compatibility; `raw` is deliberately
 * excluded (the old toJSON() already dropped it).
 */
export interface AgentResultData {
    agentId: string
    /** Producer-issued replay identity for this exact terminal turn. */
    terminalId?: string
    subtype: string
    sessionId: string | null
    isError: boolean
    resultText: string | null
    usage: Readonly<Record<string, unknown>> | null
    totalCostUsd: number | null
    numTurns: number | null
    durationMs: number | null
}

export const AgentResult = defineSemanticEvent<AgentResultData>("claude_result")

/** Terminal assistant text from a backend-neutral story turn. */
export interface AgentTurnCompletedData {
    agentId: string
    /** Producer-issued replay identity for this exact projected terminal turn. */
    terminalId?: string
    backend: string
    isError: boolean
    resultText: string | null
    /** False for one-shot CLIs that cannot consume Critic feedback in-process. */
    canContinue: boolean
}

export const AgentTurnCompleted =
    defineSemanticEvent<AgentTurnCompletedData>("agent_turn_completed")

/**
 * Authenticated boundary emitted by a one-shot story participant only after
 * its provider process has settled. The terminal projector uses it to keep
 * Critic evidence capture behind process-tree quiescence.
 */
export interface OneShotAttemptFinalizedData {
    runId: string
    storyId: string
    leaseId: string
    generation: number
    /** Monotonic invocation number within this lease generation. */
    attempt: number
    disposition: "publish" | "discard"
    ownedProcessGroup: boolean
    /** POSIX group + identity-table observation, not full OS containment. */
    quiescenceAssurance: "cooperative-observed" | "none"
}

export const OneShotAttemptFinalized =
    defineSemanticEvent<OneShotAttemptFinalizedData>(
        "one_shot_attempt_finalized",
    )

export interface ClaudeStreamChunkData {
    agentId: string
    raw: Readonly<Record<string, unknown>>
}

export const ClaudeStreamChunk =
    defineSemanticEvent<ClaudeStreamChunkData>("claude_stream_chunk")

export interface ClaudeRateLimitData {
    agentId: string
    raw: Readonly<Record<string, unknown>>
}

export const ClaudeRateLimit =
    defineSemanticEvent<ClaudeRateLimitData>("claude_rate_limit")

// Codex CLI passthrough types — see docs/stream-protocols.md ("Codex").

export interface CodexSystemData {
    agentId: string
    /** "thread.started" | "thread.completed" | "error" */
    subtype: string
    raw: Readonly<Record<string, unknown>>
}

export const CodexSystem = defineSemanticEvent<CodexSystemData>("codex_system")

export interface CodexTurnEventData {
    agentId: string
    /** "started" | "completed" | "failed" */
    phase: string
    raw: Readonly<Record<string, unknown>>
}

export const CodexTurnEvent =
    defineSemanticEvent<CodexTurnEventData>("codex_turn_event")

export interface CodexItemEventData {
    agentId: string
    /** e.g. "agent_message", "reasoning", "command_execution",
     *  "file_change", "mcp_tool_call", "web_search", "plan_update". */
    itemType: string
    raw: Readonly<Record<string, unknown>>
}

export const CodexItemEvent =
    defineSemanticEvent<CodexItemEventData>("codex_item_event")

export interface CodexUnknownEventData {
    agentId: string
    codexType: string
    raw: Readonly<Record<string, unknown>>
}

export const CodexUnknownEvent =
    defineSemanticEvent<CodexUnknownEventData>("codex_unknown_event")

export interface ClaudeUnknownEventData {
    agentId: string
    claudeType: string
    raw: Readonly<Record<string, unknown>>
}

export const ClaudeUnknownEvent =
    defineSemanticEvent<ClaudeUnknownEventData>("claude_unknown_event")

// OpenCode CLI passthrough types — see docs/stream-protocols.md ("OpenCode").

export interface OpenCodeSystemData {
    agentId: string
    /** "step_start" | "step_finish" */
    subtype: string
    raw: Readonly<Record<string, unknown>>
}

export const OpenCodeSystem = defineSemanticEvent<OpenCodeSystemData>("opencode_system")

export interface OpenCodeStepEventData {
    agentId: string
    /** "text" | "tool_call" | "tool_result" */
    stepType: string
    raw: Readonly<Record<string, unknown>>
}

export const OpenCodeStepEvent =
    defineSemanticEvent<OpenCodeStepEventData>("opencode_step_event")

export interface OpenCodeUnknownEventData {
    agentId: string
    openCodeType: string
    raw: Readonly<Record<string, unknown>>
}

export const OpenCodeUnknownEvent =
    defineSemanticEvent<OpenCodeUnknownEventData>("opencode_unknown_event")

// Pi CLI passthrough types — see docs/stream-protocols.md ("Pi").

export interface PiSystemData {
    agentId: string
    /** "session" | "agent_start" | "turn_start" | "agent_end" */
    subtype: string
    raw: Readonly<Record<string, unknown>>
}

export const PiSystem = defineSemanticEvent<PiSystemData>("pi_system")

export interface PiTurnEventData {
    agentId: string
    /** "message_start" | "message_end" | "turn_end" */
    turnType: string
    raw: Readonly<Record<string, unknown>>
}

export const PiTurnEvent = defineSemanticEvent<PiTurnEventData>("pi_turn_event")

export interface PiItemEventData {
    agentId: string
    /** "text" | "thinking" | "tool_call" | "tool_start" | "tool_update" | "tool_result" */
    itemType: string
    raw: Readonly<Record<string, unknown>>
}

export const PiItemEvent = defineSemanticEvent<PiItemEventData>("pi_item_event")

export interface PiUnknownEventData {
    agentId: string
    piType: string
    raw: Readonly<Record<string, unknown>>
}

export const PiUnknownEvent =
    defineSemanticEvent<PiUnknownEventData>("pi_unknown_event")
