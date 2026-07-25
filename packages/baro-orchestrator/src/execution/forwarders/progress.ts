import { BaseObserver, Participant, SemanticEvent } from "../../runtime/mozaik.js"

import {
    ConductorState,
    Critique,
    LevelCompleted,
    Replan,
    ReplanApplied,
    RunStarted,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    StoryMerged,
    StoryQualityCompleted,
    WorkLeaseGranted,
    WorkLeaseReleased,
    type ConductorStateData,
    type CritiqueData,
    type ReplanData,
    type RuntimeReplanAppliedData,
    type RuntimeReplanRejectedData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"
import { ActiveLeaseRegistry } from "../../runtime/active-lease-registry.js"

/**
 * Mirrors Conductor lifecycle as a `progress` BaroEvent — the Rust TUI
 * doesn't understand `conductor_state` directly.
 */
export class ProgressForwarder extends BaseObserver {
    private legacyReplanAuthority: Participant | null = null
    private runtimeReplanAuthority: Participant | null = null
    private repositoryAuthority: Participant | null = null
    private critiqueAuthority: Participant | null = null
    private collectiveAuthorities: Readonly<CollectiveProgressAuthorities> | null = null
    private readonly leases = new ActiveLeaseRegistry()
    private readonly seenRuntimeDecisions = new Set<string>()
    private readonly seenQualityEvaluations = new Set<string>()
    private latestRuntimeGraphVersion = 0
    private totalStories: number | null = null
    private knownStories: Set<string> | null = null
    private readonly completedStories = new Set<string>()
    private requireMergedCompletion = false

    constructor(private readonly collectiveFailClosed = false) {
        super()
    }

    sealCollectiveAuthorities(
        authorities: CollectiveProgressAuthorities,
    ): void {
        if (this.collectiveAuthorities) {
            throw new Error(
                "progress forwarder collective authorities are already sealed",
            )
        }
        if (
            this.runtimeReplanAuthority &&
            this.runtimeReplanAuthority !== authorities.board
        ) {
            throw new Error("progress forwarder Board authority mismatch")
        }
        if (
            this.repositoryAuthority &&
            this.repositoryAuthority !== authorities.repository
        ) {
            throw new Error("progress forwarder repository authority mismatch")
        }
        this.runtimeReplanAuthority = authorities.board
        this.repositoryAuthority = authorities.repository
        this.collectiveAuthorities = Object.freeze({ ...authorities })
    }

    setLegacyReplanAuthority(authority: Participant): void {
        if (
            this.legacyReplanAuthority &&
            this.legacyReplanAuthority !== authority
        ) {
            throw new Error(
                "Progress forwarder legacy replan authority is already bound",
            )
        }
        this.legacyReplanAuthority = authority
    }

    setRuntimeReplanAuthority(authority: Participant): void {
        if (
            this.runtimeReplanAuthority &&
            this.runtimeReplanAuthority !== authority
        ) {
            throw new Error(
                "Progress forwarder runtime replan authority is already bound",
            )
        }
        this.runtimeReplanAuthority = authority
    }

    setRepositoryAuthority(authority: Participant): void {
        if (this.repositoryAuthority && this.repositoryAuthority !== authority) {
            throw new Error(
                "Progress forwarder repository authority is already bound",
            )
        }
        this.repositoryAuthority = authority
    }

    setCritiqueAuthority(authority: Participant): void {
        if (this.critiqueAuthority && this.critiqueAuthority !== authority) {
            throw new Error(
                "Progress forwarder critique authority is already bound",
            )
        }
        this.critiqueAuthority = authority
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (this.collectiveFailClosed && !this.collectiveAuthorities) return
        if (WorkLeaseGranted.is(event) || WorkLeaseReleased.is(event)) {
            const authorities = this.collectiveAuthorities
            if (
                !authorities ||
                source !== authorities.broker ||
                event.data.runId !== authorities.runId
            ) return
            if (
                WorkLeaseReleased.is(event) &&
                !this.leases.matchesLease(
                    event.data.storyId,
                    event.data.runId,
                    event.data.leaseId,
                )
            ) return
            this.leases.observe(event, authorities.runId)
            return
        }
        if (RunStarted.is(event)) {
            const expectedAuthority = event.data.coordinationMode === "collective"
                ? this.runtimeReplanAuthority
                : this.legacyReplanAuthority
            if (!expectedAuthority || source !== expectedAuthority) return
            this.totalStories = event.data.storyCount
            this.knownStories = event.data.storyIds
                ? new Set(event.data.storyIds)
                : null
            this.completedStories.clear()
            for (const storyId of event.data.completedStoryIds ?? []) {
                this.completedStories.add(storyId)
            }
            this.requireMergedCompletion =
                event.data.coordinationMode === "collective"
            this.emitStoryProgress()
            return
        }
        if (StoryMerged.is(event)) {
            if (source !== this.repositoryAuthority) return
            if (
                this.isCollective() &&
                (!this.collectiveAuthorities ||
                    event.data.runId !== this.collectiveAuthorities.runId ||
                    !event.data.leaseId ||
                    !this.leases.matchesLease(
                        event.data.storyId,
                        this.collectiveAuthorities.runId,
                        event.data.leaseId,
                    ))
            ) return
            this.completeStory(event.data.storyId)
            return
        }
        if (LevelCompleted.is(event)) {
            const expectedAuthority = this.requireMergedCompletion
                ? this.runtimeReplanAuthority
                : this.legacyReplanAuthority
            if (!expectedAuthority || source !== expectedAuthority) return
            for (const storyId of event.data.passed) this.completeStory(storyId)
            return
        }
        if (ConductorState.is(event)) {
            if (
                source !== this.legacyReplanAuthority &&
                source !== this.runtimeReplanAuthority
            ) return
            this.handleConductorState(event.data)
            return
        }
        if (Replan.is(event)) {
            // Raw legacy and collective Replan events are proposals. Legacy
            // Conductor emits ReplanApplied after persistence; collective
            // Board emits RuntimeReplanApplied after its transaction.
            return
        }
        if (ReplanApplied.is(event)) {
            if (source !== this.legacyReplanAuthority) return
            this.handleReplan(event.data)
            return
        }
        if (RuntimeReplanApplied.is(event)) {
            if (
                source !== this.runtimeReplanAuthority ||
                this.seenRuntimeDecisions.has(event.data.proposalId) ||
                (event.data.currentGraphVersion !== undefined &&
                    event.data.graphVersion < event.data.currentGraphVersion) ||
                event.data.graphVersion <= this.latestRuntimeGraphVersion
            ) return
            this.seenRuntimeDecisions.add(event.data.proposalId)
            this.latestRuntimeGraphVersion =
                event.data.currentGraphVersion ?? event.data.graphVersion
            this.handleRuntimeReplanApplied(event.data)
            return
        }
        if (RuntimeReplanRejected.is(event)) {
            if (
                source !== this.runtimeReplanAuthority ||
                this.seenRuntimeDecisions.has(event.data.proposalId)
            ) return
            this.seenRuntimeDecisions.add(event.data.proposalId)
            this.handleRuntimeReplanRejected(event.data)
            return
        }
        if (Critique.is(event)) {
            if (this.isCollective()) {
                // Collective presentation uses AcceptanceGate's correlated
                // StoryQualityCompleted projection below. Raw Critique cannot
                // prove which run/lease/generation it describes.
                return
            } else if (
                this.critiqueAuthority &&
                source !== this.critiqueAuthority
            ) return
            this.handleCritique(event.data)
            return
        }
        if (StoryQualityCompleted.is(event)) {
            const authorities = this.collectiveAuthorities
            if (
                !authorities?.quality ||
                source !== authorities.quality ||
                event.data.runId !== authorities.runId ||
                !this.leases.matchesLeaseGeneration(
                    event.data.storyId,
                    authorities.runId,
                    event.data.leaseId,
                    event.data.generation,
                ) ||
                this.seenQualityEvaluations.has(event.data.evaluationId)
            ) return
            this.seenQualityEvaluations.add(event.data.evaluationId)
            if (event.data.critique) {
                this.handleCritique({
                    agentId: event.data.storyId,
                    ...event.data.critique,
                })
            } else {
                emit({
                    type: "activity",
                    id: event.data.storyId,
                    kind: "verdict",
                    ...(event.data.status === "inconclusive"
                        ? {}
                        : { ok: event.data.status === "passed" }),
                    text: event.data.reason,
                })
            }
            return
        }
    }

    private handleConductorState(item: ConductorStateData): void {
        if (
            this.totalStories === null &&
            item.phase === "running_level" &&
            item.currentLevel != null &&
            item.totalLevels != null
        ) {
            emit({
                type: "progress",
                completed: item.currentLevel - 1,
                total: item.totalLevels,
                percentage: Math.round(
                    ((item.currentLevel - 1) / Math.max(1, item.totalLevels)) * 100,
                ),
            })
        }
        if (item.detail) {
            emit({
                type: "activity",
                id: "plan",
                kind: item.phase === "failed" ? "error" : "warn",
                text: item.detail,
            })
        }
    }

    private handleReplan(item: ReplanData): void {
        this.updateKnownStories(item.addedStories, item.removedStoryIds)
        this.adjustStoryTotal(item.addedStories.length, item.removedStoryIds.length)
        const added = item.addedStories.length
        const removed = item.removedStoryIds.length
        emit({
            type: "activity",
            id: "plan",
            kind: "warn",
            text: `Replanned (${item.source}): +${added}/-${removed} — ${item.reason}`,
        })
    }

    private handleRuntimeReplanApplied(item: RuntimeReplanAppliedData): void {
        this.updateKnownStories(
            item.mutation.addedStories,
            item.mutation.removedStoryIds,
        )
        this.adjustStoryTotal(
            item.mutation.addedStories.length,
            item.mutation.removedStoryIds.length,
        )
        const added = item.mutation.addedStories.length
        const removed = item.mutation.removedStoryIds.length
        emit({
            type: "activity",
            id: "plan",
            kind: "warn",
            text: `Replanned (agent:${item.sourceStoryId}@graph-v${item.graphVersion}): +${added}/-${removed} — ${item.reason}`,
        })
    }

    private handleRuntimeReplanRejected(item: RuntimeReplanRejectedData): void {
        emit({
            type: "activity",
            id: "plan",
            kind: "warn",
            text: `Replan rejected (agent:${item.sourceStoryId}, ${item.code}): ${item.reason}`,
        })
    }

    private handleCritique(item: CritiqueData): void {
        emit({
            type: "activity",
            id: item.agentId,
            kind: "verdict",
            ok: item.verdict === "pass",
            text:
                item.status === "inconclusive"
                    ? `Critic could not evaluate ${item.agentId}: ${item.reasoning}`
                    : item.verdict === "pass"
                    ? `Critic accepted ${item.agentId}`
                    : `Critic rejected ${item.agentId}: ${item.reasoning}`,
        })
    }

    private completeStory(storyId: string): void {
        if (
            this.totalStories === null ||
            this.completedStories.has(storyId) ||
            (this.knownStories !== null && !this.knownStories.has(storyId))
        ) return
        this.completedStories.add(storyId)
        this.emitStoryProgress()
    }

    private updateKnownStories(
        added: readonly { id: string }[],
        removed: readonly string[],
    ): void {
        if (this.knownStories === null) return
        for (const storyId of removed) this.knownStories.delete(storyId)
        for (const story of added) this.knownStories.add(story.id)
    }

    private adjustStoryTotal(added: number, removed: number): void {
        if (this.totalStories === null) return
        this.totalStories = Math.max(
            this.completedStories.size,
            this.totalStories + added - removed,
        )
        this.emitStoryProgress()
    }

    private emitStoryProgress(): void {
        if (this.totalStories === null) return
        const completed = Math.min(this.completedStories.size, this.totalStories)
        emit({
            type: "progress",
            completed,
            total: this.totalStories,
            percentage:
                this.totalStories === 0
                    ? 100
                    : Math.round((completed / this.totalStories) * 100),
        })
    }

    private isCollective(): boolean {
        return this.collectiveFailClosed || this.collectiveAuthorities !== null
    }
}

export interface CollectiveProgressAuthorities {
    runId: string
    board: Participant
    broker: Participant
    repository: Participant
    quality?: Participant
}
