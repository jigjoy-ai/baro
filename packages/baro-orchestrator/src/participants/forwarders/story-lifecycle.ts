import {
    BaseObserver,
    FunctionCallItem,
    Participant,
    SemanticEvent,
} from "../../runtime/mozaik.js"

import {
    AgentState,
    type AgentStateData,
    StoryMergeFailed,
    StoryMerged,
    StoryResult,
    type StoryResultData,
    StoryRouted,
    StorySpawnRequest,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"
import { ActiveLeaseRegistry } from "../../runtime/active-lease-registry.js"
import type { StoryOutcomeAuthority } from "../../runtime/story-outcome-authority.js"

// Write-ish tools across all backends. "create" = a whole-file write
// (Claude `Write`, story-tools `write_file`); "edit" = an in-place edit
// (which implies the file pre-existed).
const CREATE_TOOLS = new Set(["Write", "write_file"])
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "edit_file"])

/**
 * Mirrors story lifecycle transitions as BaroEvents consumed by the Rust TUI.
 *
 * Subscribes to: AgentState, StoryResult, StoryRouted, StoryMerged,
 * StoryMergeFailed, and per-agent function calls.
 * Emits: story_start, story_suspended, story_complete, story_error,
 * story_retry, routed, story_merged, merge_failed.
 */
export class StoryLifecycleForwarder extends BaseObserver {
    private startedStories = new Set<string>()
    private retryCounts = new Map<string, number>()
    /** storyId → retry budget from its spawn request, so story_error reports the real max. */
    private retryBudget = new Map<string, number>()
    // storyId → (path → first-touch kind). Distinct paths per story, so a
    // file touched many times counts once, classified by its first write.
    // Reset on each retry so story_complete reflects only the winning
    // attempt's touches, not files a failed attempt wrote and abandoned.
    private filesByStory = new Map<string, Map<string, "created" | "modified">>()
    private pendingIntegration = new Map<string, StoryResultData>()
    private readonly leases = new ActiveLeaseRegistry()
    private collectiveAuthorities: Readonly<CollectiveStoryLifecycleAuthorities> | null = null

    constructor(private readonly collectiveFailClosed = false) {
        super()
    }

    sealCollectiveAuthorities(
        authorities: CollectiveStoryLifecycleAuthorities,
    ): void {
        if (this.collectiveAuthorities) {
            throw new Error(
                "story lifecycle forwarder collective authorities are already sealed",
            )
        }
        this.collectiveAuthorities = Object.freeze({ ...authorities })
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (WorkLeaseReleased.is(event)) {
            if (!this.acceptsLeaseSource(source, event.data.runId)) return
            if (
                this.isCollective() &&
                !this.leases.matchesLease(
                    event.data.storyId,
                    event.data.runId,
                    event.data.leaseId,
                )
            ) return
            const key = integrationKey(event.data.runId, event.data.leaseId)
            if (key) this.pendingIntegration.delete(key)
            if (event.data.reason !== "integrated") {
                this.filesByStory.delete(event.data.storyId)
                this.startedStories.delete(event.data.storyId)
            }
            this.leases.observe(
                event,
                this.collectiveAuthorities?.runId,
            )
            return
        }
        if (WorkLeaseGranted.is(event)) {
            if (!this.acceptsLeaseSource(source, event.data.runId)) return
            this.leases.observe(
                event,
                this.collectiveAuthorities?.runId,
            )
            return
        }
        if (AgentState.is(event)) {
            if (!this.acceptsActiveTerminalSource(source, event.data.agentId)) {
                return
            }
            this.handleAgentState(event.data)
            return
        }
        if (StorySpawnRequest.is(event)) {
            if (!this.acceptsSpawnSource(source, event.data)) return
            this.retryBudget.set(event.data.storyId, event.data.retries)
            return
        }
        if (StoryResult.is(event)) {
            if (!this.acceptsStoryResult(source, event.data)) return
            this.handleStoryResult(event.data)
            return
        }
        if (StoryRouted.is(event)) {
            if (!this.acceptsSpawnSource(source, event.data)) return
            emit({
                type: "routed",
                id: event.data.storyId,
                backend: event.data.backend,
                model: event.data.model,
            })
            return
        }
        if (StoryMerged.is(event)) {
            if (!this.acceptsRepositoryEvent(source, event.data)) return
            const key = integrationKey(event.data.runId, event.data.leaseId)
            const pending = key ? this.pendingIntegration.get(key) : undefined
            if (pending) {
                this.pendingIntegration.delete(key!)
                this.emitStoryComplete(pending)
            }
            emit({
                type: "story_merged",
                id: event.data.storyId,
                mode: event.data.mode,
            })
            return
        }
        if (StoryMergeFailed.is(event)) {
            if (!this.acceptsRepositoryEvent(source, event.data)) return
            const key = integrationKey(event.data.runId, event.data.leaseId)
            const pending = key ? this.pendingIntegration.get(key) : undefined
            if (pending) {
                this.pendingIntegration.delete(key!)
                this.filesByStory.delete(event.data.storyId)
                emit({
                    type: "story_error",
                    id: event.data.storyId,
                    error: event.data.error,
                    attempt: pending.attempts,
                    max_retries: this.retryBudget.get(event.data.storyId) ?? pending.attempts,
                })
            }
            emit({
                type: "merge_failed",
                id: event.data.storyId,
                error: event.data.error,
            })
            return
        }
    }

    // Same signal the Sentry uses: a write/edit tool call from a story
    // agent. We attribute the touched path to that agent's story and
    // remember its first-touch kind so story_complete can report real
    // per-story file counts instead of a hardcoded 0.
    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        const isCreate = CREATE_TOOLS.has(item.name)
        const isEdit = EDIT_TOOLS.has(item.name)
        if (!isCreate && !isEdit) return
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        if (!this.acceptsActiveTerminalSource(source, agentId)) return
        const path = extractPath(item)
        if (!path) return

        let paths = this.filesByStory.get(agentId)
        if (!paths) {
            paths = new Map()
            this.filesByStory.set(agentId, paths)
        }
        // Keep the FIRST touch's classification; a later edit of a file we
        // saw created stays "created".
        if (!paths.has(path)) {
            paths.set(path, isCreate ? "created" : "modified")
        }
    }

    private handleAgentState(item: AgentStateData): void {
        if (item.phase === "running" && !this.startedStories.has(item.agentId)) {
            this.startedStories.add(item.agentId)
            emit({ type: "story_start", id: item.agentId, title: item.agentId })
        }
        if (item.phase === "waiting" && item.detail?.includes("retrying")) {
            const count = (this.retryCounts.get(item.agentId) ?? 0) + 1
            this.retryCounts.set(item.agentId, count)
            // Drop the failed attempt's file touches so the eventual
            // story_complete counts only the attempt that actually lands.
            this.filesByStory.delete(item.agentId)
            emit({ type: "story_retry", id: item.agentId, attempt: count })
        }
    }

    private handleStoryResult(item: StoryResultData): void {
        if (item.suspension) {
            const key = integrationKey(item.runId, item.leaseId)
            if (key) this.pendingIntegration.delete(key)
            // The next lease is a real new execution interval and must be
            // visible as another story_start rather than remaining "running".
            this.startedStories.delete(item.storyId)
            this.filesByStory.delete(item.storyId)
            emit({
                type: "story_suspended",
                id: item.storyId,
                block_id: item.suspension.blockId,
            })
            return
        }
        if (item.success) {
            if (item.runId && item.leaseId && item.generation != null) {
                this.pendingIntegration.set(
                    integrationKey(item.runId, item.leaseId)!,
                    item,
                )
                return
            }
            this.emitStoryComplete(item)
        } else {
            this.filesByStory.delete(item.storyId)
            emit({
                type: "story_error",
                id: item.storyId,
                error: item.error ?? "unknown error",
                attempt: item.attempts,
                max_retries: this.retryBudget.get(item.storyId) ?? item.attempts,
            })
        }
    }

    private emitStoryComplete(item: StoryResultData): void {
        const paths = this.filesByStory.get(item.storyId)
        let created = 0
        let modified = 0
        if (paths) {
            for (const kind of paths.values()) {
                if (kind === "created") created++
                else modified++
            }
        }
        this.filesByStory.delete(item.storyId)
        emit({
            type: "story_complete",
            id: item.storyId,
            duration_secs: item.durationSecs,
            files_created: created,
            files_modified: modified,
        })
    }

    private isCollective(): boolean {
        return this.collectiveFailClosed || this.collectiveAuthorities !== null
    }

    private acceptsLeaseSource(source: Participant, runId: string): boolean {
        if (!this.isCollective()) return true
        const authorities = this.collectiveAuthorities
        return (
            authorities !== null &&
            source === authorities.broker &&
            runId === authorities.runId
        )
    }

    private acceptsStoryResult(
        source: Participant,
        data: StoryResultData,
    ): boolean {
        if (!this.isCollective()) {
            return !data.runId || this.leases.matches(data, data.runId)
        }
        const authorities = this.collectiveAuthorities
        return (
            authorities !== null &&
            authorities.outcomeAuthority.matchesResult(source, data) &&
            this.leases.matches(data, authorities.runId)
        )
    }

    private acceptsSpawnSource(
        source: Participant,
        data: {
            storyId: string
            runId?: string
            leaseId?: string
            generation?: number
        },
    ): boolean {
        if (!this.isCollective()) return true
        const authorities = this.collectiveAuthorities
        if (
            !authorities ||
            data.runId !== authorities.runId ||
            !data.leaseId ||
            data.generation == null ||
            !authorities.outcomeAuthority.matchesSpawnAuthority(source, {
                runId: data.runId,
                storyId: data.storyId,
                leaseId: data.leaseId,
            })
        ) return false
        return this.matchesActiveCorrelation({
            runId: data.runId,
            storyId: data.storyId,
            leaseId: data.leaseId,
            generation: data.generation,
        })
    }

    private acceptsRepositoryEvent(
        source: Participant,
        data: { storyId: string; runId?: string; leaseId?: string },
    ): boolean {
        if (!this.isCollective()) {
            return (
                !data.runId ||
                this.leases.matchesLease(
                    data.storyId,
                    data.runId,
                    data.leaseId,
                )
            )
        }
        const authorities = this.collectiveAuthorities
        return (
            authorities !== null &&
            source === authorities.repository &&
            data.runId === authorities.runId &&
            !!data.leaseId &&
            this.leases.matchesLease(
                data.storyId,
                authorities.runId,
                data.leaseId,
            )
        )
    }

    private acceptsActiveTerminalSource(
        source: Participant,
        storyId: string,
    ): boolean {
        if (!this.isCollective()) return true
        const authorities = this.collectiveAuthorities
        if (!authorities) return false
        const correlation =
            authorities.outcomeAuthority.terminalCorrelationForSource(
                source,
                storyId,
            )
        return correlation !== null && this.matchesActiveCorrelation(correlation)
    }

    private matchesActiveCorrelation(correlation: {
        runId: string
        storyId: string
        leaseId: string
        generation: number
    }): boolean {
        return this.leases.matches(
            {
                storyId: correlation.storyId,
                success: false,
                attempts: 0,
                durationSecs: 0,
                error: null,
                runId: correlation.runId,
                leaseId: correlation.leaseId,
                generation: correlation.generation,
            },
            this.collectiveAuthorities?.runId,
        )
    }
}

export interface CollectiveStoryLifecycleAuthorities {
    runId: string
    broker: Participant
    repository: Participant
    outcomeAuthority: StoryOutcomeAuthority
}

function integrationKey(
    runId: string | undefined,
    leaseId: string | undefined,
): string | null {
    return runId && leaseId ? `${runId}:${leaseId}` : null
}

/** Pull the file path out of a write/edit tool call's JSON args. */
function extractPath(item: FunctionCallItem): string | null {
    let args: Record<string, unknown>
    try {
        args = JSON.parse(item.args) as Record<string, unknown>
    } catch {
        return null
    }
    for (const key of ["file_path", "path", "notebook_path"]) {
        const v = args[key]
        if (typeof v === "string") return v
    }
    return null
}
