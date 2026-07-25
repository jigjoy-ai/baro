import type { Participant, SemanticEvent } from "./mozaik.js"

import {
    Critique,
    RunCompleted,
    StoryQualityCompleted,
    StoryResult,
    WorkBlockAccepted,
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
    private blockAuthority: Participant | null = null
    private criticAuthority: Participant | null = null
    private readonly blockedLeases = new Map<string, string>()

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

    setBlockAuthority(authority: Participant): void {
        if (this.blockAuthority && this.blockAuthority !== authority) {
            throw new Error("recovery block authority is already bound")
        }
        this.blockAuthority = authority
    }

    setCriticAuthority(authority: Participant): void {
        if (this.criticAuthority && this.criticAuthority !== authority) {
            throw new Error("recovery critic authority is already bound")
        }
        this.criticAuthority = authority
    }

    /** Consume every lease lifecycle event, applying it only from the Broker. */
    observeLease(
        source: Participant,
        event: SemanticEvent<unknown>,
        leases: ActiveLeaseRegistry,
        runId: string | undefined,
    ): boolean {
        if (WorkBlockAccepted.is(event)) {
            if (
                this.blockAuthority &&
                source === this.blockAuthority &&
                (!runId || event.data.runId === runId)
            ) {
                this.blockedLeases.set(
                    blockKey(
                        event.data.runId,
                        event.data.storyId,
                        event.data.leaseId,
                        event.data.generation,
                    ),
                    event.data.blockId,
                )
            }
            return true
        }
        if (RunCompleted.is(event)) {
            if (
                this.blockAuthority &&
                source === this.blockAuthority &&
                (!runId || !event.data.runId || event.data.runId === runId)
            ) this.blockedLeases.clear()
            return true
        }
        if (!WorkLeaseGranted.is(event) && !WorkLeaseReleased.is(event)) {
            return false
        }
        if (
            this.outcomeAuthority
                ? this.leaseAuthority !== null && source === this.leaseAuthority
                : this.leaseAuthority === null || source === this.leaseAuthority
        ) {
            leases.observe(event, runId)
        }
        return true
    }

    /** Validate the source of an event that may trigger recovery policy. */
    accepts(source: Participant, event: SemanticEvent<unknown>): boolean {
        if (Critique.is(event)) {
            return this.outcomeAuthority
                ? this.criticAuthority !== null && source === this.criticAuthority
                : this.criticAuthority === null || source === this.criticAuthority
        }
        if (StoryResult.is(event)) {
            if (
                event.data.runId &&
                event.data.leaseId &&
                event.data.generation !== undefined &&
                event.data.suspension?.kind === "dependency" &&
                this.blockedLeases.get(
                    blockKey(
                        event.data.runId,
                        event.data.storyId,
                        event.data.leaseId,
                        event.data.generation,
                    ),
                ) === event.data.suspension.blockId
            ) return false
            return !this.outcomeAuthority ||
                this.outcomeAuthority.matchesResult(source, event.data)
        }
        if (StoryQualityCompleted.is(event)) {
            return this.outcomeAuthority
                ? this.qualityAuthority !== null && source === this.qualityAuthority
                : this.qualityAuthority === null || source === this.qualityAuthority
        }
        return true
    }
}

function blockKey(
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
): string {
    return `${runId}\u0000${leaseId}\u0000${storyId}\u0000${generation}`
}
