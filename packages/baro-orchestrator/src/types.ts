/**
 * Canonical custom ContextItem types used by the orchestrator and its
 * participants. Designed to be library-grade — none of them know about
 * baro PRD format or any product-specific concept. They describe agents
 * and Claude CLI events at the domain level, suitable for promotion to a
 * Mozaik library package later.
 */

import { BusEvent } from "./bus.js"

// ─── Bus routing ────────────────────────────────────────────────────

/**
 * A piece of derived knowledge — typically a digest of a file read,
 * a grep result, or a bash command output — that one or more
 * participants want to share across agents. Librarian emits these,
 * Conductor (or future participants) consume them when launching new
 * agents to avoid redundant exploration.
 *
 * Library-grade: payload + tags only, no agent-specific assumptions.
 */
export class KnowledgeItem extends BusEvent {
    readonly type = "knowledge"

    constructor(
        /** Source agent that produced the underlying tool call. */
        public readonly sourceAgentId: string,
        /** Free-form tags for relevance matching (e.g. file path, pattern). */
        public readonly tags: readonly string[],
        /** Short headline (e.g. "package.json read", "grep 'authToken'"). */
        public readonly summary: string,
        /** Full content (file body, command output, etc). */
        public readonly content: string,
        /** Tool that produced it ("Read" | "Grep" | "Bash" | "Glob" …). */
        public readonly tool: string,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            sourceAgentId: this.sourceAgentId,
            tags: this.tags,
            summary: this.summary,
            content: this.content,
            tool: this.tool,
        }
    }
}

/**
 * A request to mutate the running DAG: add new stories, remove
 * existing-but-not-yet-passing stories, and/or rewire dependencies.
 * Surgeon emits these when reality disagrees with the original plan
 * (repeated failures, scope creep, missing prerequisites, …).
 *
 * Conductor buffers ReplanItem-s during level execution and applies
 * them at the next level boundary. Library-grade: doesn't import PRD
 * types — added stories are described by a structural shape, the
 * consumer (Conductor) is the one that lifts them into PrdStory.
 */
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

export class ReplanItem extends BusEvent {
    readonly type = "replan"

    constructor(
        public readonly source: string,
        public readonly reason: string,
        public readonly addedStories: readonly ReplanStoryAdd[] = [],
        public readonly removedStoryIds: readonly string[] = [],
        public readonly modifiedDeps: ReadonlyMap<
            string,
            readonly string[]
        > = new Map(),
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            source: this.source,
            reason: this.reason,
            addedStories: this.addedStories,
            removedStoryIds: this.removedStoryIds,
            modifiedDeps: Array.from(this.modifiedDeps.entries()),
        }
    }
}

/**
 * Inter-agent coordination directive. Sentry emits these to ask one
 * agent to wait, abort, or merge before stepping on another agent's
 * pending work.
 */
export class CoordinationItem extends BusEvent {
    readonly type = "coordination"

    constructor(
        public readonly fromAgentId: string,
        public readonly recipientId: string,
        public readonly kind: "wait" | "merge" | "abort" | "notice",
        public readonly reason: string,
        public readonly payload: Readonly<Record<string, unknown>> = {},
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            fromAgentId: this.fromAgentId,
            recipientId: this.recipientId,
            kind: this.kind,
            reason: this.reason,
            payload: this.payload,
        }
    }
}

/**
 * A user-facing text message addressed to a specific agent in the
 * environment. Other agents see it on the bus but ignore it.
 *
 * This is the canonical "tell agent X to do something" message — emitted by
 * Operator (human input), Conductor (initial story prompt), Critic
 * (review feedback), Surgeon (replan directive), Librarian (knowledge
 * injection), etc.
 */
export class AgentTargetedMessageItem extends BusEvent {
    readonly type = "agent_targeted_message"

    constructor(
        public readonly recipientId: string,
        public readonly text: string,
        public readonly metadata: Readonly<Record<string, unknown>> = {},
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            recipientId: this.recipientId,
            text: this.text,
            metadata: this.metadata,
        }
    }
}

// ─── Agent lifecycle ────────────────────────────────────────────────

export type AgentPhase =
    | "idle"
    | "starting"
    | "running"
    | "waiting"
    | "done"
    | "failed"
    | "aborted"

/**
 * Heartbeat / state-change signal for an agent. Observers (Cartographer,
 * Auditor, Throttler) read these to track who's doing what.
 */
export class AgentStateItem extends BusEvent {
    readonly type = "agent_state"

    constructor(
        public readonly agentId: string,
        public readonly phase: AgentPhase,
        public readonly detail?: string,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agentId: this.agentId,
            phase: this.phase,
            detail: this.detail,
        }
    }
}

// ─── Claude CLI passthrough types ───────────────────────────────────
//
// These wrap Claude stream-json events that don't map cleanly onto Mozaik's
// built-in delivery channels. They're intentionally close to the wire
// format so observers can do detailed inspection, while the mapper still
// routes Mozaik-typed items (ModelMessageItem, FunctionCallItem,
// FunctionCallOutputItem) through their dedicated typed delivery channels.

/**
 * User-side message in Claude's stream-json conversation history.
 *
 * Mozaik 3.9 ships `UserMessageItem` as a ModelContext content carrier,
 * but its `AgenticEnvironment` does NOT expose a `deliverUserMessage`
 * channel — bus delivery is reserved for assistant-side items (model
 * messages, tool calls) and reasoning. baro emits this custom BusEvent
 * instead so observers (Cartographer, Auditor) see Claude-side user
 * turns the same way they see other agent activity.
 */
export class AgentUserMessageItem extends BusEvent {
    readonly type = "agent_user_message"

    constructor(
        public readonly agentId: string,
        public readonly text: string,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agentId: this.agentId,
            text: this.text,
        }
    }
}

/**
 * Claude `system:*` events — init, status, task_started, task_notification,
 * etc. These describe the Claude session lifecycle, not its content.
 */
export class ClaudeSystemItem extends BusEvent {
    readonly type = "claude_system"

    constructor(
        public readonly agentId: string,
        public readonly subtype: string,
        public readonly raw: Readonly<Record<string, unknown>>,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agentId: this.agentId,
            subtype: this.subtype,
            raw: this.raw,
        }
    }
}

/**
 * Claude `result` event — emitted once at the end of a turn. Carries
 * session_id (for `--resume`), usage, cost, num_turns, duration. This is
 * the single richest event in the stream and most observers care about it.
 */
export class AgentResultItem extends BusEvent {
    readonly type = "claude_result"

    constructor(
        public readonly agentId: string,
        public readonly subtype: string,
        public readonly sessionId: string | null,
        public readonly isError: boolean,
        public readonly resultText: string | null,
        public readonly usage: Readonly<Record<string, unknown>> | null,
        public readonly totalCostUsd: number | null,
        public readonly numTurns: number | null,
        public readonly durationMs: number | null,
        public readonly raw: Readonly<Record<string, unknown>>,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agentId: this.agentId,
            subtype: this.subtype,
            sessionId: this.sessionId,
            isError: this.isError,
            resultText: this.resultText,
            usage: this.usage,
            totalCostUsd: this.totalCostUsd,
            numTurns: this.numTurns,
            durationMs: this.durationMs,
        }
    }
}

/**
 * Claude `stream_event` — partial token chunks. High volume (~80% of
 * events when --include-partial-messages is on). Most observers should
 * filter these out unless they specifically render a streaming UI.
 */
export class ClaudeStreamChunkItem extends BusEvent {
    readonly type = "claude_stream_chunk"

    constructor(
        public readonly agentId: string,
        public readonly raw: Readonly<Record<string, unknown>>,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agentId: this.agentId,
            raw: this.raw,
        }
    }
}

/**
 * Claude `rate_limit_event` — informational throttling notice from the
 * Claude API. Throttler participant uses this to back off.
 */
export class ClaudeRateLimitItem extends BusEvent {
    readonly type = "claude_rate_limit"

    constructor(
        public readonly agentId: string,
        public readonly raw: Readonly<Record<string, unknown>>,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agentId: this.agentId,
            raw: this.raw,
        }
    }
}

/**
 * Verdict emitted by the Critic participant after evaluating a story
 * agent's output. Snake_case keys in toJSON() match the Rust BaroEnum
 * wire format.
 */
export class CritiqueItem extends BusEvent {
    readonly type = "critique"

    constructor(
        /** ID of the story agent whose output was evaluated. */
        public readonly agentId: string,
        public readonly verdict: "pass" | "fail",
        /** Full reasoning text returned by the Critic LLM. */
        public readonly reasoning: string,
        /** Acceptance criteria strings that were violated (empty on pass). */
        public readonly violatedCriteria: readonly string[],
        /** Which Claude turn the Critic evaluated. */
        public readonly turn: number,
        /** Model ID used by the Critic LLM call. */
        public readonly modelUsed: string,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agent_id: this.agentId,
            verdict: this.verdict,
            reasoning: this.reasoning,
            violated_criteria: this.violatedCriteria,
            turn: this.turn,
            model_used: this.modelUsed,
        }
    }
}

/**
 * Fallback for any Claude stream-json event whose `type` we don't yet
 * recognize. Lets us forward-compatibly carry events without dropping
 * them; observers can still inspect them.
 */
export class ClaudeUnknownEventItem extends BusEvent {
    readonly type = "claude_unknown_event"

    constructor(
        public readonly agentId: string,
        public readonly claudeType: string,
        public readonly raw: Readonly<Record<string, unknown>>,
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            agentId: this.agentId,
            claudeType: this.claudeType,
            raw: this.raw,
        }
    }
}

// ─── Orchestration control events (Mozaik-native Conductor) ─────────
//
// These items model orchestration control flow as bus events. The
// Conductor is a pure event-driven state machine — `onContextItem`
// is the only entry point, no `run()` method, no `await Promise.all`,
// no `envRef`. Other participants can observe or even drive the run
// by emitting these items.

/** Emitted to start a run. Anyone can fire this; Conductor reacts. */
export class RunStartRequestItem extends BusEvent {
    readonly type = "run_start_request"
    constructor(public readonly reason: string = "user request") {
        super()
    }
    toJSON(): unknown {
        return { type: this.type, reason: this.reason }
    }
}

/** Conductor emits this once the PRD is loaded and ready. */
export class RunStartedItem extends BusEvent {
    readonly type = "run_started"
    constructor(
        public readonly project: string,
        public readonly storyCount: number,
    ) {
        super()
    }
    toJSON(): unknown {
        return { type: this.type, project: this.project, storyCount: this.storyCount }
    }
}

/**
 * Emitted by Conductor to request the next level be computed and
 * launched. Internally a self-tick — keeps run() out of the picture.
 */
export class LevelComputeRequestItem extends BusEvent {
    readonly type = "level_compute_request"
    constructor(public readonly reason: string) {
        super()
    }
    toJSON(): unknown {
        return { type: this.type, reason: this.reason }
    }
}

/** Emitted when a new level is starting. Story factories react to this. */
export class LevelStartedItem extends BusEvent {
    readonly type = "level_started"
    constructor(
        public readonly ordinal: number,
        public readonly totalLevelsHint: number,
        public readonly storyIds: readonly string[],
    ) {
        super()
    }
    toJSON(): unknown {
        return {
            type: this.type,
            ordinal: this.ordinal,
            totalLevelsHint: this.totalLevelsHint,
            storyIds: this.storyIds,
        }
    }
}

/** Emitted when all stories in a level have completed (passed or failed). */
export class LevelCompletedItem extends BusEvent {
    readonly type = "level_completed"
    constructor(
        public readonly ordinal: number,
        public readonly passed: readonly string[],
        public readonly failed: readonly string[],
    ) {
        super()
    }
    toJSON(): unknown {
        return {
            type: this.type,
            ordinal: this.ordinal,
            passed: this.passed,
            failed: this.failed,
        }
    }
}

/**
 * Conductor emits this to ask a story factory participant to spawn a
 * StoryAgent for `storyId`. The factory builds the agent and joins it
 * to the bus. Conductor never imports StoryAgent directly.
 */
export class StorySpawnRequestItem extends BusEvent {
    readonly type = "story_spawn_request"
    constructor(
        public readonly storyId: string,
        public readonly prompt: string,
        public readonly model: string,
        public readonly retries: number,
        public readonly timeoutSecs: number,
    ) {
        super()
    }
    toJSON(): unknown {
        return {
            type: this.type,
            storyId: this.storyId,
            promptLen: this.prompt.length,
            model: this.model,
            retries: this.retries,
            timeoutSecs: this.timeoutSecs,
        }
    }
}

/** Factory emits this once a StoryAgent has joined the bus and started. */
export class StorySpawnedItem extends BusEvent {
    readonly type = "story_spawned"
    constructor(public readonly storyId: string) {
        super()
    }
    toJSON(): unknown {
        return { type: this.type, storyId: this.storyId }
    }
}

/**
 * Emitted by Finalizer the moment it starts composing + sending a PR
 * (after RunCompletedItem, before `gh pr create`). Lets observers
 * surface "finalizing…" UI without inspecting Finalizer's internals.
 */
export class FinalizeStartedItem extends BusEvent {
    readonly type = "finalize_started"
    constructor(public readonly branch: string) {
        super()
    }
    toJSON(): unknown {
        return { type: this.type, branch: this.branch }
    }
}

/**
 * Emitted by Finalizer once a pull request has been opened for the
 * run's branch (or once an existing PR for that branch has been
 * discovered). Observers can react — e.g. the Operator forwarding the
 * URL to a TUI / Slack participant — without importing Finalizer.
 *
 * `url` is null when Finalizer ran but couldn't open a PR (no `gh`
 * binary, no remote, all stories failed, etc.). Observers should treat
 * a null url as "the run is over, no PR exists" rather than "still
 * working."
 */
export class PrCreatedItem extends BusEvent {
    readonly type = "pr_created"
    constructor(
        public readonly url: string | null,
        public readonly branch: string,
        public readonly baseBranch: string,
    ) {
        super()
    }
    toJSON(): unknown {
        return {
            type: this.type,
            url: this.url,
            branch: this.branch,
            baseBranch: this.baseBranch,
        }
    }
}

/**
 * Final terminal event for a run. Conductor emits this when the loop
 * exits — either all DAG levels drained or a level aborted.
 */
export class RunCompletedItem extends BusEvent {
    readonly type = "run_completed"
    constructor(
        public readonly success: boolean,
        public readonly completedStories: readonly string[],
        public readonly failedStories: readonly string[],
        public readonly totalDurationSecs: number,
        public readonly totalAttempts: number,
        public readonly abortReason: string | null = null,
    ) {
        super()
    }
    toJSON(): unknown {
        return {
            type: this.type,
            success: this.success,
            completedStories: this.completedStories,
            failedStories: this.failedStories,
            totalDurationSecs: this.totalDurationSecs,
            totalAttempts: this.totalAttempts,
            abortReason: this.abortReason,
        }
    }
}
