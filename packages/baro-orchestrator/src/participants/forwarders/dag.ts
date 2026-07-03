import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    LevelCompleted,
    LevelStarted,
    RecoveryStarted,
    Replan,
    type LevelCompletedData,
    type LevelStartedData,
    type RecoveryStartedData,
    type ReplanData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/**
 * Forwards DAG/coordination-shape events as structured protocol-v2
 * BaroEvents: replan, level_started, level_completed, recovery_started.
 * (Their `activity`/`progress` mirrors live in ProgressForwarder.)
 */
export class DagForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (Replan.is(event)) {
            this.handleReplan(event.data)
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
        emit({
            type: "replan",
            source: item.source,
            reason: item.reason,
            added: item.addedStories.map((s) => ({
                id: s.id,
                title: s.title,
                depends_on: [...s.dependsOn],
            })),
            removed: [...item.removedStoryIds],
            rewired: Object.entries(item.modifiedDeps).map(([id, deps]) => ({
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
