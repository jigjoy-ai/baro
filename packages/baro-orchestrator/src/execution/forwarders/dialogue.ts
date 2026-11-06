import { type SemanticEvent } from "../../runtime/mozaik.js"
import { BusMember } from "../../runtime/coordination.js"

import {
    ConversationFailed,
    ConversationResponded,
} from "../../semantic-events.js"
import { emit, type BaroEvent } from "../../tui-protocol.js"

/** Source-bound projection of DialogueAgent replies into the existing TUI log. */
export class DialogueForwarder extends BusMember {
    constructor(
        private readonly authority: BusMember,
        private readonly sink: (event: BaroEvent) => void = emit,
    ) {
        super()
    }

    override onExternalEvent(
        source: BusMember,
        event: SemanticEvent<string, unknown>,
    ): void {
        if (source !== this.authority) return
        if (ConversationResponded.is(event)) {
            this.sink({
                type: "conversation_response",
                message_id: event.payload.messageId,
                text: event.payload.text,
                actions: event.payload.actions.map((action) => ({
                    recipient_id: action.recipientId,
                    text: action.text,
                })),
            })
            this.sink({
                type: "activity",
                id: "_dialogue",
                kind: "agent_msg",
                text: event.payload.text,
            })
            this.sink({
                type: "story_log",
                id: "_dialogue",
                line: `[collective] ${event.payload.text}`,
            })
            for (const action of event.payload.actions) {
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
                type: "conversation_failed",
                message_id: event.payload.messageId,
                error: event.payload.error,
            })
            this.sink({
                type: "activity",
                id: "_dialogue",
                kind: "error",
                text: event.payload.error,
                ok: false,
            })
            this.sink({
                type: "story_log",
                id: "_dialogue",
                line: `[collective/unavailable] ${event.payload.error}`,
            })
        }
    }
}
