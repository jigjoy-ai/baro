import { BaseObserver, type Participant, type SemanticEvent } from "@mozaik-ai/core"

import {
    ConversationFailed,
    ConversationResponded,
} from "../../semantic-events.js"
import { emit, type BaroEvent } from "../../tui-protocol.js"

/** Source-bound projection of DialogueAgent replies into the existing TUI log. */
export class DialogueForwarder extends BaseObserver {
    constructor(
        private readonly authority: Participant,
        private readonly sink: (event: BaroEvent) => void = emit,
    ) {
        super()
    }

    override onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (source !== this.authority) return
        if (ConversationResponded.is(event)) {
            this.sink({
                type: "activity",
                id: "_dialogue",
                kind: "agent_msg",
                text: event.data.text,
            })
            this.sink({
                type: "story_log",
                id: "_dialogue",
                line: `[collective] ${event.data.text}`,
            })
            for (const action of event.data.actions) {
                this.sink({
                    type: "activity",
                    id: "_dialogue",
                    kind: "agent_msg",
                    text: `→ ${action.recipientId}: ${action.text}`,
                })
                this.sink({
                    type: "story_log",
                    id: "_dialogue",
                    line: `[collective → ${action.recipientId}] ${action.text}`,
                })
            }
            return
        }
        if (ConversationFailed.is(event)) {
            this.sink({
                type: "activity",
                id: "_dialogue",
                kind: "error",
                text: event.data.error,
                ok: false,
            })
            this.sink({
                type: "story_log",
                id: "_dialogue",
                line: `[collective/unavailable] ${event.data.error}`,
            })
        }
    }
}
