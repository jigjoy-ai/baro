import { SemanticEvent } from "../../runtime/mozaik.js"
import { BusMember } from "../../runtime/coordination.js"

import {
    Coordination,
    CoordinationModeSelected,
    Critique,
    CollaborationNote,
    PeerHelpRequested,
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationRetryClassified,
    RunVerificationTimedOut,
    PathsClaimed,
    StoryCheckpointDecided,
    StoryCheckpointWithdrawn,
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
export class CoordinationForwarder extends BusMember {
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

    override async onExternalEvent(
        source: BusMember,
        event: SemanticEvent<string, unknown>,
    ): Promise<void> {
        if (Coordination.is(event)) {
            if (!this.matchesCollective(source, "coordination")) return
            this.handleCoordination(event.payload)
            return
        }
        if (Critique.is(event)) {
            const critic = this.collectiveAuthorities?.critique
            if (!critic || source !== critic) return
            // A verdict outside an active lease is a replay, not this run's turn.
            if (!this.leases.hasActive(event.payload.agentId, this.collectiveAuthorities?.runId)) return
            this.handleTurnReview(event.payload)
            return
        }
        if (StoryQualityCompleted.is(event)) {
            const authorities = this.collectiveAuthorities
            if (
                !authorities?.quality ||
                source !== authorities.quality ||
                event.payload.runId !== authorities.runId ||
                !this.leases.matchesLeaseGeneration(
                    event.payload.storyId,
                    authorities.runId,
                    event.payload.leaseId,
                    event.payload.generation,
                ) ||
                this.seenQualityEvaluations.has(event.payload.evaluationId)
            ) return
            this.seenQualityEvaluations.add(event.payload.evaluationId)
            if (event.payload.critique) {
                this.handleCritique({
                    agentId: event.payload.storyId,
                    ...event.payload.critique,
                })
            } else {
                emit({
                    type: "story_log",
                    id: event.payload.storyId,
                    line: `[critic/${event.payload.status}] ${event.payload.reason}`,
                })
            }
            return
        }
        if (StoryIntervention.is(event)) {
            if (!this.matchesCollective(source, "intervention")) return
            this.handleIntervention(event.payload)
            return
        }
        if (StoryCheckpointDecided.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            const decision = event.payload
            const runId = this.collectiveAuthorities?.runId
            if (runId && decision.runId !== runId) return
            if (decision.outcome === "published") {
                emit({
                    type: "checkpoint",
                    id: decision.storyId,
                    sha: decision.sha,
                    reason: decision.reason,
                    admitted: decision.admitted,
                })
            }
            emit({
                type: "story_log",
                id: decision.storyId,
                line: decision.outcome === "published"
                    ? `[checkpoint] ${decision.sha.slice(0, 12)} published${decision.admitted.length ? `; started on it: ${decision.admitted.join(", ")}` : ""}`
                    : `[checkpoint] refused: ${decision.reason}`,
            })
            return
        }
        if (StoryCheckpointWithdrawn.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "checkpoint_withdrawn",
                id: event.payload.storyId,
                sha: event.payload.sha,
                reason: event.payload.reason,
                affected: event.payload.affected,
            })
            return
        }
        if (PathsClaimed.is(event)) {
            if (!this.matchesCollective(source, "bridge")) return
            const granted = event.payload.decisions
                .filter((decision) => decision.outcome === "granted")
                .map((decision) => decision.path)
            const held = event.payload.decisions.flatMap((decision) =>
                decision.outcome === "held"
                    ? [{ path: decision.path, owner: decision.ownerStoryId }]
                    : [],
            )
            if (granted.length === 0 && held.length === 0) return
            emit({ type: "paths_claimed", id: event.payload.storyId, granted, held })
            return
        }
        if (CoordinationModeSelected.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "story_log",
                id: "_run",
                line: `[coordination] ${event.payload.mode}`,
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
                line: `[verify] started (${event.payload.verificationId})`,
            })
            return
        }
        if (RunVerificationCompleted.is(event)) {
            if (!this.matchesCollective(source, "verifier")) return
            const commands = event.payload.commands
                .map((command) => `${command.command}: ${command.status}`)
                .join(", ")
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: `Run verification ${event.payload.status}${commands ? ` — ${commands}` : ""}`,
                ...(event.payload.status === "skipped"
                    ? {}
                    : { ok: event.payload.status === "passed" }),
            })
            emit({
                type: "story_log",
                id: "_verify",
                line: `[verify/${event.payload.status}] ${commands || "no build/test command detected"}`,
            })
            return
        }
        if (RunVerificationRetryClassified.is(event)) {
            if (!this.matchesCollective(source, "verifier")) return
            // A refusal is already in the evidence; only an actual retry owes
            // the operator a line explaining why the gate ran twice.
            if (!event.payload.retried) return
            emit({
                type: "activity",
                id: "_verify",
                kind: "warn",
                text:
                    `verification retry: ${event.payload.command} ` +
                    `(${event.payload.bucket} \u2192 ${event.payload.remedy})`,
            })
            return
        }
        if (RunVerificationTimedOut.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: `Run verification timed out after ${Math.ceil(event.payload.timeoutMs / 1_000)}s`,
                ok: false,
            })
            return
        }
        if (WorkOffered.is(event)) {
            if (!this.matchesCollective(source, "board")) return
            emit({
                type: "story_log",
                id: event.payload.request.storyId,
                line: `[collective] work offered (${event.payload.offerId})`,
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
                id: event.payload.storyId,
                line: `[collective] claimed by ${event.payload.workerId} → ${event.payload.backend}:${event.payload.model}`,
            })
            return
        }
        if (WorkLeaseGranted.is(event)) {
            if (!this.matchesCollective(source, "broker")) return
            if (
                this.collectiveAuthorities &&
                event.payload.runId !== this.collectiveAuthorities.runId
            ) return
            this.leases.observe(event, this.collectiveAuthorities?.runId)
            const route = event.payload.route
            emit({
                type: "story_log",
                id: event.payload.request.storyId,
                line:
                    `[collective] lease granted to ${event.payload.workerId}` +
                    (route ? ` → ${route.backend}:${route.model}` : ""),
            })
            return
        }
        if (WorkLeaseReleased.is(event)) {
            const authorities = this.collectiveAuthorities
            if (
                !authorities ||
                source !== authorities.broker ||
                event.payload.runId !== authorities.runId ||
                !this.leases.matchesLease(
                    event.payload.storyId,
                    authorities.runId,
                    event.payload.leaseId,
                )
            ) return
            this.leases.observe(event, authorities.runId)
            return
        }
        if (WorkLeaseExpired.is(event)) {
            if (!this.matchesCollective(source, "broker")) return
            emit({
                type: "story_log",
                id: event.payload.storyId,
                line: `[collective] lease expired: ${event.payload.reason}`,
            })
            return
        }
        if (PeerHelpRequested.is(event)) {
            if (!this.matchesCollective(source, "bridge")) return
            emit({
                type: "story_log",
                id: event.payload.sourceAgentId,
                line: `[peer/help] ${event.payload.text}`,
            })
            return
        }
        if (CollaborationNote.is(event)) {
            if (!this.matchesCollective(source, "bridge")) return
            emit({
                type: "story_log",
                id: event.payload.sourceAgentId,
                line: `[peer/note] ${event.payload.text}`,
            })
            return
        }
        if (WorkDiscovered.is(event)) {
            if (!this.matchesCollective(source, "bridge")) return
            emit({
                type: "story_log",
                id: event.payload.sourceAgentId,
                line: `[peer/discovered] ${event.payload.story.id}: ${event.payload.reason}`,
            })
            return
        }
    }

    private matchesCollective(
        source: BusMember,
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

    private handleTurnReview(item: CritiqueData): void {
        emit({
            type: "turn_review",
            id: item.agentId,
            turn: item.turn,
            status: item.status ?? "evaluated",
            verdict: item.verdict,
            reasoning: item.reasoning,
            violated: [...item.violatedCriteria],
            ...(item.staleCommands?.length ? { stale_commands: [...item.staleCommands] } : {}),
            ...(item.contractConflicts?.length
                ? { contract_conflicts: item.contractConflicts.map((conflict) => ({ ...conflict })) }
                : {}),
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
    board: BusMember
    /** Broker owns accepted claims and lease lifecycle. */
    broker: BusMember
    verifier: BusMember
    bridge: BusMember
    coordination?: BusMember
    /** AcceptanceGate owns the lease-correlated final critique projection. */
    quality?: BusMember
    /** The Critic's per-turn verdicts, rejections included, become `turn_review`. */
    critique?: BusMember
    intervention?: BusMember
}
