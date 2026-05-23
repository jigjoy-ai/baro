import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    FinalizeStarted,
    type FinalizeStartedData,
    PrCreated,
    type PrCreatedData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/**
 * Mirrors finalization lifecycle events as BaroEvents for the Rust TUI.
 *
 * Subscribes to: FinalizeStarted, PrCreated.
 * Emits: finalize_start, finalize_complete.
 */
export class FinalizationForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (FinalizeStarted.is(event)) {
            const _item: FinalizeStartedData = event.data
            emit({ type: "finalize_start" })
            return
        }
        if (PrCreated.is(event)) {
            const item: PrCreatedData = event.data
            emit({ type: "finalize_complete", pr_url: item.url })
            return
        }
    }
}
