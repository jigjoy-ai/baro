import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    ConductorState,
    Critique,
    Replan,
    type ConductorStateData,
    type CritiqueData,
    type ReplanData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/**
 * Mirrors Conductor lifecycle as a `progress` BaroEvent — the Rust TUI
 * doesn't understand `conductor_state` directly.
 */
export class ProgressForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (ConductorState.is(event)) {
            this.handleConductorState(event.data)
            return
        }
        if (Replan.is(event)) {
            this.handleReplan(event.data)
            return
        }
        if (Critique.is(event)) {
            this.handleCritique(event.data)
            return
        }
    }

    private handleConductorState(item: ConductorStateData): void {
        if (
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
        const added = item.addedStories.length
        const removed = item.removedStoryIds.length
        emit({
            type: "activity",
            id: "plan",
            kind: "warn",
            text: `Replanned (${item.source}): +${added}/-${removed} — ${item.reason}`,
        })
    }

    private handleCritique(item: CritiqueData): void {
        emit({
            type: "activity",
            id: item.agentId,
            kind: "verdict",
            ok: item.verdict === "pass",
            text:
                item.verdict === "pass"
                    ? `Critic accepted ${item.agentId}`
                    : `Critic rejected ${item.agentId}: ${item.reasoning}`,
        })
    }
}
