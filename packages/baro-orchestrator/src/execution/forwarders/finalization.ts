import { SemanticEvent } from "../../runtime/mozaik.js"
import { BusMember } from "../../runtime/coordination.js"

import {
    FinalizeStarted,
    type FinalizeStartedData,
    PrCreated,
    type PrCreatedData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/** Mirrors finalization lifecycle events as BaroEvents for the Rust TUI. */
export class FinalizationForwarder extends BusMember {
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
        source: BusMember,
        event: SemanticEvent<string, unknown>,
    ): Promise<void> {
        if (!this.accepts(source)) return
        if (FinalizeStarted.is(event)) {
            const _item: FinalizeStartedData = event.payload
            emit({ type: "finalize_start" })
            return
        }
        if (PrCreated.is(event)) {
            const item: PrCreatedData = event.payload
            emit({ type: "finalize_complete", pr_url: item.url })
            return
        }
    }

    private accepts(source: BusMember): boolean {
        if (this.collectiveAuthorities) {
            return this.collectiveAuthorities.finalizer === source
        }
        return !this.collectiveFailClosed
    }
}

export interface CollectiveFinalizationAuthorities {
    /** Omitted means this run deliberately has no push/PR participant. */
    finalizer?: BusMember
}
