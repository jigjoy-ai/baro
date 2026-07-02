/**
 * SemanticEvent definitions for every baro orchestrator bus event.
 *
 * CONSTRAINT: each event's wire `type` string must stay identical to the
 * pre-migration BusEvent `toJSON().type` — audit-log readers (mozaik-replay
 * legacy adapter, baro's older replay tooling) match on those names.
 * Migration history and per-event wire-format deltas: docs/semantic-events.md.
 *
 * Type discriminators, not `instanceof`: class instances don't survive JSON
 * round-trips (audit log → reload, WebSocket → reload); a `type` check does.
 */

import { SemanticEvent } from "@mozaik-ai/core"

/**
 * One event "kind": wire type string + typed `create()` factory + `is()`
 * type guard — class-event ergonomics without a JS class identity.
 */
export function defineSemanticEvent<TData>(type: string) {
    return {
        type,
        create: (data: TData): SemanticEvent<TData> =>
            new SemanticEvent<TData>(type, data),
        is: (event: SemanticEvent<unknown>): event is SemanticEvent<TData> =>
            event.type === type,
    } as const
}

// Bus routing

export interface KnowledgeData {
    /** Source agent that produced the underlying tool call. */
    sourceAgentId: string
    /** Free-form tags for relevance matching (e.g. file path, pattern). */
    tags: readonly string[]
    /** Short headline (e.g. "package.json read", "grep 'authToken'"). */
    summary: string
    /** Full content (file body, command output, etc). */
    content: string
    /** Tool that produced it ("Read" | "Grep" | "Bash" | "Glob" …). */
    tool: string
}
export const Knowledge = defineSemanticEvent<KnowledgeData>("knowledge")

export interface ReplanStoryAdd {
    id: string
    priority: number
    title: string
    description: string
    dependsOn: readonly string[]
    retries?: number
    acceptance?: readonly string[]
    tests?: readonly string[]
    model?: string
}

export interface ReplanData {
    source: string
    reason: string
    addedStories: readonly ReplanStoryAdd[]
    removedStoryIds: readonly string[]
    /** `Record<storyId, dependsOn>` — flat object, not `Map`, for JSON. */
    modifiedDeps: Readonly<Record<string, readonly string[]>>
}
export const Replan = defineSemanticEvent<ReplanData>("replan")

export interface CoordinationData {
    fromAgentId: string
    recipientId: string
    kind: "wait" | "merge" | "abort" | "notice"
    reason: string
    payload: Readonly<Record<string, unknown>>
}
export const Coordination = defineSemanticEvent<CoordinationData>("coordination")

export interface AgentTargetedMessageData {
    recipientId: string
    text: string
    metadata: Readonly<Record<string, unknown>>
}
export const AgentTargetedMessage =
    defineSemanticEvent<AgentTargetedMessageData>("agent_targeted_message")

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

/**
 * Verdict from the Critic. Historic wire JSON used snake_case keys to
 * match the Rust TUI; the interface is camelCase — no in-process consumer
 * reads snake_case, so any mapping happens at the audit-log boundary.
 */
export interface CritiqueData {
    agentId: string
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: readonly string[]
    turn: number
    modelUsed: string
}
export const Critique = defineSemanticEvent<CritiqueData>("critique")

export interface ClaudeUnknownEventData {
    agentId: string
    claudeType: string
    raw: Readonly<Record<string, unknown>>
}
export const ClaudeUnknownEvent =
    defineSemanticEvent<ClaudeUnknownEventData>("claude_unknown_event")

// Orchestration control events

export interface RunStartRequestData {
    reason: string
}
export const RunStartRequest =
    defineSemanticEvent<RunStartRequestData>("run_start_request")

export interface RunStartedData {
    project: string
    storyCount: number
    /** Execution mode from the intake contract ("focused" | "sequential" | "parallel"), when one was decided. */
    mode?: string
}
export const RunStarted = defineSemanticEvent<RunStartedData>("run_started")

export interface LevelComputeRequestData {
    reason: string
}
export const LevelComputeRequest =
    defineSemanticEvent<LevelComputeRequestData>("level_compute_request")

export interface LevelStartedData {
    ordinal: number
    totalLevelsHint: number
    storyIds: readonly string[]
}
export const LevelStarted = defineSemanticEvent<LevelStartedData>("level_started")

export interface LevelCompletedData {
    ordinal: number
    passed: readonly string[]
    failed: readonly string[]
}
export const LevelCompleted =
    defineSemanticEvent<LevelCompletedData>("level_completed")

/**
 * Conductor actually started a recovery level (visibility only; the
 * recovery flow itself stays hook-driven). `attempt` counts recovery
 * levels started in this run, 1-based.
 */
export interface RecoveryStartedData {
    attempt: number
    storyIds: readonly string[]
}
export const RecoveryStarted =
    defineSemanticEvent<RecoveryStartedData>("recovery_started")

/**
 * Unlike the old toJSON() (which logged only `promptLen`), the wire format
 * carries the full prompt — StoryFactory needs it, and audit-log
 * round-tripping is worth the size for replay/debug.
 */
export interface StorySpawnRequestData {
    storyId: string
    prompt: string
    model: string
    retries: number
    timeoutSecs: number
}
export const StorySpawnRequest =
    defineSemanticEvent<StorySpawnRequestData>("story_spawn_request")

export interface StorySpawnedData {
    storyId: string
}
export const StorySpawned = defineSemanticEvent<StorySpawnedData>("story_spawned")

/**
 * Which backend + model a story was routed to (machine-readable twin of
 * StoryFactory's `[story-factory] S1 → backend:model` stderr line).
 */
export interface StoryRoutedData {
    storyId: string
    backend: string
    model: string
}
export const StoryRouted = defineSemanticEvent<StoryRoutedData>("story_routed")

export interface FinalizeStartedData {
    branch: string
}
export const FinalizeStarted =
    defineSemanticEvent<FinalizeStartedData>("finalize_started")

export interface PrCreatedData {
    url: string | null
    branch: string
    baseBranch: string
}
export const PrCreated = defineSemanticEvent<PrCreatedData>("pr_created")

export interface RunCompletedData {
    success: boolean
    completedStories: readonly string[]
    failedStories: readonly string[]
    totalDurationSecs: number
    totalAttempts: number
    abortReason: string | null
}
export const RunCompleted = defineSemanticEvent<RunCompletedData>("run_completed")

export interface ConductorStateData {
    phase: "loading" | "running_level" | "level_complete" | "done" | "failed"
    detail?: string
    currentLevel?: number
    totalLevels?: number
    storyIds?: readonly string[]
}
export const ConductorState =
    defineSemanticEvent<ConductorStateData>("conductor_state")

export interface StoryResultData {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    error: string | null
}
export const StoryResult = defineSemanticEvent<StoryResultData>("story_result")

/**
 * A participant (Supervisor today) requests intervention on a RUNNING story.
 * StoryFactory consumes "abort": the story settles as a failed StoryResult,
 * which the Surgeon can then split/escalate.
 */
export interface StoryInterventionData {
    storyId: string
    source: string
    action: "abort"
    reason: string
}
export const StoryIntervention =
    defineSemanticEvent<StoryInterventionData>("story_intervention")

/** A passed story's work landed on the run branch (worktree merge-back or shared-tree reconcile). */
export interface StoryMergedData {
    storyId: string
    mode: "worktree" | "shared-tree"
}
export const StoryMerged = defineSemanticEvent<StoryMergedData>("story_merged")

/** Merge-back failed; the story's worktree + branch are preserved for recovery. */
export interface StoryMergeFailedData {
    storyId: string
    error: string
}
export const StoryMergeFailed =
    defineSemanticEvent<StoryMergeFailedData>("story_merge_failed")

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
