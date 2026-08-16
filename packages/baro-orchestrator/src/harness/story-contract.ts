/**
 * The story-execution contract every harness lane implements: the spec a
 * story agent is launched with, the settled outcome, and the lease
 * correlation stamped on emitted events. `finalSummary` keeps the Claude
 * run-summary shape — the native lanes adopted it as the common wire form.
 */

import type { Participant } from "../runtime/mozaik.js"

import type { ClaudeRunSummary } from "./claude/cli-participant.js"
import type {
    StoryFailureData,
    StoryResultData,
} from "../semantic-events.js"

export interface StorySpec {
    /**
     * Claude Code --settings file materialized per story (hook-bridge.ts):
     * write-surface refusals at the write and evidence-capture acknowledgments
     * at the command, from the same registry the gates enforce.
     */
    cliSettingsPath?: string
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    cwd: string
    runId?: string
    leaseId?: string
    generation?: number
    /** Runtime DAG version captured when this story lease was launched. */
    graphVersion?: number
    model?: string
    /** Passed as `claude --effort` (low|medium|high|xhigh|max). */
    effort?: string
    claudeBin?: string
    /** Number of *additional* attempts after the first. */
    retries?: number
    /** Per-attempt timeout in seconds. */
    timeoutSecs?: number
    retryDelayMs?: number
    /** Ms of silence (no AgentResult for this story) before stdin is closed. */
    quietTimeoutMs?: number
    /** Max AgentResult events (turns) before stdin is closed unconditionally. */
    maxTurns?: number
    /** Hard cap in seconds for the whole story across all attempts; <= 0 disables. */
    hardTimeoutSecs?: number
    /**
     * What this story may write, and who owns what it may not. The prompt
     * states it; the tools enforce it — a cheap model reads the sentence and
     * edits the file anyway.
     */
    surface?: {
        readonly writes: readonly string[]
        readonly ownedElsewhere: Readonly<Record<string, string>>
    }
    /** Await an exact Critic verdict before completing each candidate turn. */
    requiresQualityReview?: boolean
    /** Object-identity authority allowed to review this worker's turns. */
    turnReviewAuthority?: Participant
    /** Exact Bridge allowed to deliver a collective message for this lease. */
    targetedMessageAuthority?: Participant
    /** Bound for one terminal-turn review. Default: 240 seconds. */
    turnReviewTimeoutMs?: number
    /** Collective-only execution handoff. An inconclusive review closes the
     * worker, while AcceptanceGate keeps the candidate pending and rechecks it. */
    handoffInconclusiveToAcceptanceGate?: boolean
    /** Require a positive process-tree quiescence certificate before a
     * spawned CLI attempt may succeed, retry, or release its worktree. */
    requireProcessQuiescenceCertification?: boolean
}

export interface StoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: ClaudeRunSummary | null
    error: string | null
    failure?: StoryFailureData
    suspension?: StorySuspension
}

export type StorySuspension = NonNullable<StoryResultData["suspension"]>

export function correlationOf(
    spec: Pick<StorySpec, "runId" | "leaseId" | "generation">,
): { runId: string; leaseId: string; generation: number } | Record<string, never> {
    return spec.runId && spec.leaseId && spec.generation != null
        ? {
              runId: spec.runId,
              leaseId: spec.leaseId,
              generation: spec.generation,
          }
        : {}
}
