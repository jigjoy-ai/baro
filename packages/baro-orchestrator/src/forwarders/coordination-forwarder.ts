import {
    BaseObserver,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    Coordination,
    Critique,
    type CoordinationData,
    type CritiqueData,
} from "../semantic-events.js"
import { emit } from "../tui-protocol.js"

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
