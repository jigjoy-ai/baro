import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { ConductorState, type ConductorStateData } from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/**
 * Mirrors Conductor lifecycle as a `progress` BaroEvent — the Rust TUI
 * doesn't (yet) understand `conductor_state` directly.
 *
 * Subscribes to: ConductorState
 * Emits: BaroEvent { type: "progress" }
 */
export class ProgressForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (!ConductorState.is(event)) return
        const item: ConductorStateData = event.data
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
    }
}
