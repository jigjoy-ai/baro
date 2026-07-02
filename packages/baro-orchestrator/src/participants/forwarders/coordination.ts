import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    Coordination,
    Critique,
    StoryIntervention,
    type CoordinationData,
    type CritiqueData,
    type StoryInterventionData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/** Mirrors coordination, critique and intervention notices as `story_log` BaroEvents. */
export class CoordinationForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (Coordination.is(event)) {
            this.handleCoordination(event.data)
            return
        }
        if (Critique.is(event)) {
            this.handleCritique(event.data)
            return
        }
        if (StoryIntervention.is(event)) {
            this.handleIntervention(event.data)
            return
        }
    }

    private handleIntervention(item: StoryInterventionData): void {
        emit({
            type: "story_log",
            id: item.storyId,
            line: `⚠ [${item.source}/${item.action}] ${item.reason} — aborting so it can be split/escalated`,
        })
        emit({
            type: "activity",
            id: item.storyId,
            kind: "warn",
            text: `Supervisor paused ${item.storyId}: ${item.reason}. It will be retried or replanned.`,
        })
    }

    private handleCoordination(item: CoordinationData): void {
        emit({
            type: "story_log",
            id: item.recipientId,
            line: `[sentry/${item.kind}] ${item.reason}`,
        })
    }

    private handleCritique(item: CritiqueData): void {
        emit({
            type: "story_log",
            id: item.agentId,
            line: `[critic/${item.verdict}] ${item.reasoning}`,
        })
    }
}
