import { BaseObserver, Participant, SemanticEvent } from "../../runtime/mozaik.js"

import {
    Coordination,
    CoordinationModeSelected,
    CollaborationNote,
    Critique,
    PeerHelpRequested,
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
    StoryIntervention,
    StoryQualityCompleted,
    WorkClaimed,
    WorkDiscovered,
    WorkLeaseExpired,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkOffered,
    type CoordinationData,
    type CritiqueData,
    type StoryInterventionData,
} from "../../semantic-events.js"
import { ActiveLeaseRegistry } from "../../runtime/active-lease-registry.js"
import { emit } from "../../tui-protocol.js"

/**
 * Forwards coordination, critique and intervention notices. Critique and
 * intervention get structured BaroEvents (protocol v2) plus their legacy
 * `story_log` mirrors for one release.
 */
export class CoordinationForwarder extends BaseObserver {
    private interventionAuthority: Participant | null = null
    private collectiveAuthorities: Readonly<CollectiveCoordinationAuthorities> | null = null
    private readonly leases = new ActiveLeaseRegistry()
    private readonly seenQualityEvaluations = new Set<string>()

    constructor(private readonly collectiveFailClosed = false) {
        super()
    }

    /**
     * Seal the presentation plane to the same concrete participants that own
     * the collective state transitions. An omitted optional authority means
     * that event family is disabled, not ambiently trusted.
     */
    sealCollectiveAuthorities(
        authorities: CollectiveCoordinationAuthorities,
    ): void {
        if (this.collectiveAuthorities) {
            throw new Error(
                "coordination forwarder collective authorities are already sealed",
            )
        }
        this.collectiveAuthorities = Object.freeze({ ...authorities })
    }

    setInterventionAuthority(authority: Participant): void {
        if (
            this.interventionAuthority &&
            this.interventionAuthority !== authority
        ) {
            throw new Error("coordination forwarder intervention authority is already bound")
        }
        this.interventionAuthority = authority
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (Coordination.is(event)) {
            if (!this.matchesCollective(source, "coordination")) return
            this.handleCoordination(event.data)
            return
        }
        if (Critique.is(event)) {
            // Raw Critique has no run/lease/generation correlation. It remains
            // a legacy presentation event, but collective presentation waits
            // for AcceptanceGate's correlated projection below.
            if (this.collectiveAuthorities || this.collectiveFailClosed) return
            this.handleCritique(event.data)
            return
        }
        if (StoryQualityCompleted.is(event)) {
            const authorities = this.collectiveAuthorities
            if (
                !authorities?.quality ||
                source !== authorities.quality ||
                event.data.runId !== authorities.runId ||
                !this.leases.matchesLeaseGeneration(
                    event.data.storyId,
                    authorities.runId,
                    event.data.leaseId,
                    event.data.generation,
                ) ||
                this.seenQualityEvaluations.has(event.data.evaluationId)
            ) return
            this.seenQualityEvaluations.add(event.data.evaluationId)
            if (event.data.critique) {
                this.handleCritique({
                    agentId: event.data.storyId,
                    ...event.data.critique,
                })
            } else {
                emit({
                    type: "story_log",
                    id: event.data.storyId,
                    line: `[critic/${event.data.status}] ${event.data.reason}`,
                })
            }
            return
        }
        if (StoryIntervention.is(event)) {
            if (this.collectiveAuthorities || this.collectiveFailClosed) {
                if (!this.matchesCollective(source, "intervention")) return
            } else if (
                this.interventionAuthority &&
                source !== this.interventionAuthority
            ) return
            this.handleIntervention(event.data)
            return
        }
        if (CoordinationModeSelected.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "story_log",
                id: "_run",
                line: `[coordination] ${event.data.mode}`,
            })
            return
        }
        if (RunVerificationRequested.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: "Verifying the fully integrated run",
            })
            emit({
                type: "story_log",
                id: "_verify",
                line: `[verify] started (${event.data.verificationId})`,
            })
            return
        }
        if (RunVerificationCompleted.is(event)) {
            if (!this.matchesCollective(source, "verifier")) return
            const commands = event.data.commands
                .map((command) => `${command.command}: ${command.status}`)
                .join(", ")
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: `Run verification ${event.data.status}${commands ? ` — ${commands}` : ""}`,
                ...(event.data.status === "skipped"
                    ? {}
                    : { ok: event.data.status === "passed" }),
            })
            emit({
                type: "story_log",
                id: "_verify",
                line: `[verify/${event.data.status}] ${commands || "no build/test command detected"}`,
            })
            return
        }
        if (RunVerificationTimedOut.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: `Run verification timed out after ${Math.ceil(event.data.timeoutMs / 1_000)}s`,
                ok: false,
            })
            return
        }
        if (WorkOffered.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "story_log",
                id: event.data.request.storyId,
                line: `[collective] work offered (${event.data.offerId})`,
            })
            return
        }
        if (WorkClaimed.is(event)) {
            // A claim is a worker-authored proposal, not an accepted routing
            // fact. In collective mode the exact Broker's correlated lease
            // below is the first presentation-safe projection.
            if (this.collectiveAuthorities || this.collectiveFailClosed) return
            emit({
                type: "story_log",
                id: event.data.storyId,
                line: `[collective] claimed by ${event.data.workerId} → ${event.data.backend}:${event.data.model}`,
            })
            return
        }
        if (WorkLeaseGranted.is(event)) {
            if (!this.matchesCollective(source, "broker")) return
            if (
                this.collectiveAuthorities &&
                event.data.runId !== this.collectiveAuthorities.runId
            ) return
            this.leases.observe(event, this.collectiveAuthorities?.runId)
            const route = event.data.route
            emit({
                type: "story_log",
                id: event.data.request.storyId,
                line:
                    `[collective] lease granted to ${event.data.workerId}` +
                    (route ? ` → ${route.backend}:${route.model}` : ""),
            })
            return
        }
        if (WorkLeaseReleased.is(event)) {
            const authorities = this.collectiveAuthorities
            if (
                !authorities ||
                source !== authorities.broker ||
                event.data.runId !== authorities.runId ||
                !this.leases.matchesLease(
                    event.data.storyId,
                    authorities.runId,
                    event.data.leaseId,
                )
            ) return
            this.leases.observe(event, authorities.runId)
            return
        }
        if (WorkLeaseExpired.is(event)) {
            if (!this.matchesCollective(source, "broker")) return
            emit({
                type: "story_log",
                id: event.data.storyId,
                line: `[collective] lease expired: ${event.data.reason}`,
            })
            return
        }
        if (PeerHelpRequested.is(event)) {
            if (!this.matchesCollective(source, "bridge")) return
            emit({
                type: "story_log",
                id: event.data.sourceAgentId,
                line: `[peer/help] ${event.data.text}`,
            })
            return
        }
        if (CollaborationNote.is(event)) {
            if (!this.matchesCollective(source, "bridge")) return
            emit({
                type: "story_log",
                id: event.data.sourceAgentId,
                line: `[peer/note] ${event.data.text}`,
            })
            return
        }
        if (WorkDiscovered.is(event)) {
            if (!this.matchesCollective(source, "bridge")) return
            emit({
                type: "story_log",
                id: event.data.sourceAgentId,
                line: `[peer/discovered] ${event.data.story.id}: ${event.data.reason}`,
            })
            return
        }
    }

    private matchesCollective(
        source: Participant,
        family: keyof CollectiveCoordinationAuthorities,
    ): boolean {
        if (!this.collectiveAuthorities) return !this.collectiveFailClosed
        return this.collectiveAuthorities[family] === source
    }

    private handleIntervention(item: StoryInterventionData): void {
        emit({
            type: "intervention",
            id: item.storyId,
            source: item.source,
            action: item.action,
            reason: item.reason,
        })
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
            type: "critique",
            id: item.agentId,
            verdict: item.verdict,
            reasoning: item.reasoning,
            violated: [...item.violatedCriteria],
        })
        emit({
            type: "story_log",
            id: item.agentId,
            line: `[critic/${item.status === "inconclusive" ? "inconclusive" : item.verdict}] ${item.reasoning}`,
        })
    }
}

export interface CollectiveCoordinationAuthorities {
    runId: string
    /** Board owns run phase, offers, and verification request/deadline. */
    board: Participant
    /** Broker owns accepted claims and lease lifecycle. */
    broker: Participant
    verifier: Participant
    bridge: Participant
    coordination?: Participant
    /** AcceptanceGate owns the lease-correlated final critique projection. */
    quality?: Participant
    intervention?: Participant
}
