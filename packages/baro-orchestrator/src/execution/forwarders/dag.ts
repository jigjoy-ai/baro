import { SemanticEvent } from "../../runtime/mozaik.js"
import { BusMember } from "../../runtime/coordination.js"

import {
    LevelCompleted,
    LevelStarted,
    RecoveryStarted,
    Replan,
    RuntimeReplanApplied,
    type LevelCompletedData,
    type LevelStartedData,
    type RecoveryStartedData,
    type ReplanData,
    type RuntimeReplanAppliedData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/**
 * Forwards DAG/coordination-shape events as structured protocol-v2
 * BaroEvents: replan, level_started, level_completed, recovery_started.
 * (Their `activity`/`progress` mirrors live in ProgressForwarder.)
 */
export class DagForwarder extends BusMember {
    private runtimeReplanAuthority: BusMember | null = null
    private coordinationAuthority: BusMember | null = null
    private readonly seenRuntimeProposals = new Set<string>()
    private latestRuntimeGraphVersion = 0

    setRuntimeReplanAuthority(authority: BusMember): void {
        if (
            this.runtimeReplanAuthority &&
            this.runtimeReplanAuthority !== authority
        ) {
            throw new Error("DAG forwarder runtime replan authority is already bound")
        }
        this.runtimeReplanAuthority = authority
        this.bindCoordinationAuthority(authority)
    }

    override async onExternalEvent(
        source: BusMember,
        event: SemanticEvent<string, unknown>,
    ): Promise<void> {
        if (Replan.is(event)) {
            // Raw replans are proposals, not graph state.
            return
        }
        if (RuntimeReplanApplied.is(event)) {
            if (
                source !== this.runtimeReplanAuthority ||
                this.seenRuntimeProposals.has(event.payload.proposalId) ||
                (event.payload.currentGraphVersion !== undefined &&
                    event.payload.graphVersion < event.payload.currentGraphVersion) ||
                event.payload.graphVersion <= this.latestRuntimeGraphVersion
            ) return
            this.seenRuntimeProposals.add(event.payload.proposalId)
            this.latestRuntimeGraphVersion =
                event.payload.currentGraphVersion ?? event.payload.graphVersion
            this.handleRuntimeReplan(event.payload)
            return
        }
        if (LevelStarted.is(event)) {
            if (source !== this.coordinationAuthority) return
            this.handleLevelStarted(event.payload)
            return
        }
        if (LevelCompleted.is(event)) {
            if (source !== this.coordinationAuthority) return
            this.handleLevelCompleted(event.payload)
            return
        }
        if (RecoveryStarted.is(event)) {
            if (source !== this.coordinationAuthority) return
            this.handleRecoveryStarted(event.payload)
            return
        }
    }

    private bindCoordinationAuthority(authority: BusMember): void {
        if (
            this.coordinationAuthority &&
            this.coordinationAuthority !== authority
        ) {
            throw new Error("DAG forwarder coordination authority is already bound")
        }
        this.coordinationAuthority = authority
    }

    private handleRuntimeReplan(item: RuntimeReplanAppliedData): void {
        this.emitReplan(
            `agent:${item.sourceStoryId}@graph-v${item.graphVersion}`,
            item.reason,
            item.mutation.addedStories,
            item.mutation.removedStoryIds,
            item.mutation.modifiedDeps,
        )
    }

    private emitReplan(
        source: string,
        reason: string,
        addedStories: ReplanData["addedStories"],
        removedStoryIds: ReplanData["removedStoryIds"],
        modifiedDeps: ReplanData["modifiedDeps"],
    ): void {
        emit({
            type: "replan",
            source,
            reason,
            added: addedStories.map((s) => ({
                id: s.id,
                title: s.title,
                depends_on: [...s.dependsOn],
            })),
            removed: [...removedStoryIds],
            rewired: Object.entries(modifiedDeps).map(([id, deps]) => ({
                id,
                depends_on: [...deps],
            })),
        })
    }

    private handleLevelStarted(item: LevelStartedData): void {
        emit({
            type: "level_started",
            ordinal: item.ordinal,
            story_ids: [...item.storyIds],
        })
    }

    private handleLevelCompleted(item: LevelCompletedData): void {
        emit({
            type: "level_completed",
            ordinal: item.ordinal,
            passed: [...item.passed],
            failed: [...item.failed],
            ...(item.blocked ? { blocked: [...item.blocked] } : {}),
        })
    }

    private handleRecoveryStarted(item: RecoveryStartedData): void {
        emit({
            type: "recovery_started",
            attempt: item.attempt,
            story_ids: [...item.storyIds],
        })
    }
}
