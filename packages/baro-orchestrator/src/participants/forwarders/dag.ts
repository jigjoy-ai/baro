import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

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
export class DagForwarder extends BaseObserver {
    private runtimeReplanAuthority: Participant | null = null
    private readonly seenRuntimeProposals = new Set<string>()
    private latestRuntimeGraphVersion = 0

    setRuntimeReplanAuthority(authority: Participant): void {
        if (
            this.runtimeReplanAuthority &&
            this.runtimeReplanAuthority !== authority
        ) {
            throw new Error("DAG forwarder runtime replan authority is already bound")
        }
        this.runtimeReplanAuthority = authority
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (Replan.is(event)) {
            // In collective mode a raw Surgeon Replan is only a proposal; the
            // Board later emits its persisted RuntimeReplanApplied decision.
            if (this.runtimeReplanAuthority) return
            this.handleReplan(event.data)
            return
        }
        if (RuntimeReplanApplied.is(event)) {
            if (
                source !== this.runtimeReplanAuthority ||
                this.seenRuntimeProposals.has(event.data.proposalId) ||
                (event.data.currentGraphVersion !== undefined &&
                    event.data.graphVersion < event.data.currentGraphVersion) ||
                event.data.graphVersion <= this.latestRuntimeGraphVersion
            ) return
            this.seenRuntimeProposals.add(event.data.proposalId)
            this.latestRuntimeGraphVersion =
                event.data.currentGraphVersion ?? event.data.graphVersion
            this.handleRuntimeReplan(event.data)
            return
        }
        if (LevelStarted.is(event)) {
            this.handleLevelStarted(event.data)
            return
        }
        if (LevelCompleted.is(event)) {
            this.handleLevelCompleted(event.data)
            return
        }
        if (RecoveryStarted.is(event)) {
            this.handleRecoveryStarted(event.data)
            return
        }
    }

    private handleReplan(item: ReplanData): void {
        this.emitReplan(
            item.source,
            item.reason,
            item.addedStories,
            item.removedStoryIds,
            item.modifiedDeps,
        )
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
