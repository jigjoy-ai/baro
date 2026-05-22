import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { FinalizeStarted, PrCreated } from "../semantic-events.js"
import { emit } from "../tui-protocol.js"

export class FinalizationForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (FinalizeStarted.is(event)) {
            emit({ type: "finalize_start" })
            return
        }
        if (PrCreated.is(event)) {
            emit({ type: "finalize_complete", pr_url: event.data.url })
            return
        }
    }
}
