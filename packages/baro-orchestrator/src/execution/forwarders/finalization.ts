import { BaseObserver, Participant, SemanticEvent } from "../../runtime/mozaik.js"

import {
    FinalizeStarted,
    type FinalizeStartedData,
    PrCreated,
    type PrCreatedData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/** Mirrors finalization lifecycle events as BaroEvents for the Rust TUI. */
export class FinalizationForwarder extends BaseObserver {
    private collectiveAuthorities: Readonly<CollectiveFinalizationAuthorities> | null = null

    constructor(private readonly collectiveFailClosed = false) {
        super()
    }

    sealCollectiveAuthorities(
        authorities: CollectiveFinalizationAuthorities,
    ): void {
        if (this.collectiveAuthorities) {
            throw new Error(
                "finalization forwarder collective authorities are already sealed",
            )
        }
        this.collectiveAuthorities = Object.freeze({ ...authorities })
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (!this.accepts(source)) return
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

    private accepts(source: Participant): boolean {
        if (this.collectiveAuthorities) {
            return this.collectiveAuthorities.finalizer === source
        }
        return !this.collectiveFailClosed
    }
}

export interface CollectiveFinalizationAuthorities {
    /** Omitted means this run deliberately has no push/PR participant. */
    finalizer?: Participant
}
