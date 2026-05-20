/**
 * Mozaik 3.10 SemanticEvent definitions for every baro orchestrator bus
 * event. Drop-in replacement target for the BusEvent class hierarchy in
 * `types.ts` + the two BusEvent subclasses defined alongside their emitters
 * (`ConductorStateItem` in `participants/conductor.ts`, `StoryResultItem`
 * in `participants/story-agent.ts`).
 *
 * Migration policy (this is "Commit 2" of the Mozaik 3.10 upgrade — see
 * the `mozaik-3.10-upgrade` branch root commit and the migration plan in
 * memory `mozaik-3-10-blocker.md`):
 *
 *   - Pure addition. None of the old `BusEvent` classes are touched. Sites
 *     can mix old `BusEvent`/`instanceof` and new `SemanticEvent`/`*.is`
 *     during the migration without conflict.
 *   - Each event keeps its wire `type` string identical to the
 *     pre-migration `toJSON.type` so audit log readers (mozaik-replay
 *     legacy adapter, baro itself's older replay tooling) recognise the
 *     same event names across the cutover.
 *   - Each data interface matches what receivers actually use at runtime.
 *     Where the previous `toJSON()` deliberately dropped or renamed a
 *     field (e.g. `prompt` → `promptLen`, `raw` excluded entirely) those
 *     decisions are noted per-event. In the new world the wire format
 *     follows the data interface — slight verbosity change, all
 *     documented.
 *
 * Type-discriminator pattern, not `instanceof`. Class instances don't
 * survive JSON serialisation (audit log → reload, WebSocket → reload),
 * but a `event.type === "knowledge"` check does. Every event below comes
 * with both a `create()` factory (typed input → SemanticEvent) and an
 * `is()` user-defined type guard.
 */

import { SemanticEvent } from "@mozaik-ai/core"

/**
 * Defines one semantic-event "kind": its wire type string, a factory that
 * builds a properly-typed `SemanticEvent<TData>`, and a user-defined type
 * guard. Together these give call sites the ergonomics of class-based
 * events (typed payload access, exhaustive discrimination) without
 * coupling identity to a JS class.
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

// ─── Bus routing ──────────────────────────────────────────────────────

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
    /**
     * `Record<storyId, dependsOn>` — flat object, not `Map`, for JSON
     * compatibility (the previous BusEvent class used `Map` and serialised
     * via `Array.from(entries)`; the SemanticEvent payload skips that
     * dance).
     */
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

// ─── Agent lifecycle ──────────────────────────────────────────────────

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

// ─── Claude CLI passthrough types ─────────────────────────────────────

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
 * Claude `result` event (one per agent turn). Wire type is still
 * `claude_result` for audit-log compatibility; the in-memory `raw` field
 * from the previous `AgentResultItem` is deliberately not included here
 * because the previous `toJSON()` already excluded it.
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

/**
 * Verdict from the Critic participant. Wire JSON uses snake_case keys
 * (`agent_id`, `violated_criteria`, `model_used`) to match the Rust TUI
 * wire format. The data interface here uses camelCase to match TS
 * convention; the snake_case mapping happens at the audit-log boundary
 * if anything needs the historic shape (none of the in-process consumers
 * read snake_case keys).
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

// ─── Orchestration control events ─────────────────────────────────────

export interface RunStartRequestData {
    reason: string
}
export const RunStartRequest =
    defineSemanticEvent<RunStartRequestData>("run_start_request")

export interface RunStartedData {
    project: string
    storyCount: number
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
 * Note: previous `StorySpawnRequestItem.toJSON()` replaced the full
 * prompt with its length (`promptLen`) to keep audit logs small. The
 * new wire format carries the full prompt — receivers (StoryFactory)
 * need it to construct the StoryAgent, and round-tripping the prompt
 * through the audit log is worth the size for replay/debug.
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
