import type { Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    StoryQualityCompleted,
    StoryResult,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../semantic-events.js"
import type { ActiveLeaseRegistry } from "./active-lease-registry.js"
import type { StoryOutcomeAuthority } from "./story-outcome-authority.js"

/**
 * Source policy shared by every Surgeon backend in collective mode.
 *
 * Lease correlation proves that an event names the current attempt; object
 * identity proves which live participant was allowed to publish it. Legacy
 * runs omit these authorities and preserve the historical open-bus behaviour.
 */
export class RecoverySourceAuthority {
    private leaseAuthority: Participant | null = null
    private qualityAuthority: Participant | null = null

    constructor(
        private readonly outcomeAuthority?: StoryOutcomeAuthority,
    ) {}

    setLeaseAuthority(authority: Participant): void {
        if (this.leaseAuthority && this.leaseAuthority !== authority) {
            throw new Error("recovery lease authority is already bound")
        }
        this.leaseAuthority = authority
    }

    setQualityAuthority(authority: Participant): void {
        if (this.qualityAuthority && this.qualityAuthority !== authority) {
            throw new Error("recovery quality authority is already bound")
        }
        this.qualityAuthority = authority
    }

    /** Consume every lease lifecycle event, applying it only from the Broker. */
    observeLease(
        source: Participant,
        event: SemanticEvent<unknown>,
        leases: ActiveLeaseRegistry,
        runId: string | undefined,
    ): boolean {
        if (!WorkLeaseGranted.is(event) && !WorkLeaseReleased.is(event)) {
            return false
        }
        if (!this.leaseAuthority || source === this.leaseAuthority) {
            leases.observe(event, runId)
        }
        return true
    }

    /** Validate the source of an event that may trigger recovery policy. */
    accepts(source: Participant, event: SemanticEvent<unknown>): boolean {
        if (StoryResult.is(event)) {
            return !this.outcomeAuthority ||
                this.outcomeAuthority.matchesResult(source, event.data)
        }
        if (StoryQualityCompleted.is(event)) {
            return !this.qualityAuthority || source === this.qualityAuthority
        }
        return true
    }
}
