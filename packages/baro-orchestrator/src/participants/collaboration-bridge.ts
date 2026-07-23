import {
    appendFileSync,
    existsSync,
    mkdirSync,
    lstatSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { randomBytes, randomUUID } from "node:crypto"
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http"
import { basename, join } from "node:path"
import type { Participant } from "../runtime/mozaik.js"

import { inboxFilenameForAgentId } from "../../scripts/collaboration-inbox-path.mjs"

import {
    AgentTargetedMessage,
    CollaborationNote,
    GoalInvariantChallengeRaised,
    GoalLedgerProjectionPersisted,
    PeerHelpRequested,
    RunCompleted,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RuntimeReplanRejected,
    WorkBlockAccepted,
    WorkBlocked,
    WorkBlockRejected,
    WorkDiscovered,
    WorkLeaseGranted,
    WorkLeaseReleased,
    type DiscoveredWork,
    type AgentTargetedMessageData,
    type GoalInvariantChallengeRaisedData,
    type GoalLedgerProjectionPersistedData,
    type RuntimeReplanMutation,
    type WorkBlockedData,
} from "../semantic-events.js"
import { snapshotRuntimeReplanMutation } from "../runtime-replan.js"
import { correlatedTargetedMessage } from "../runtime/targeted-message-authority.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"

export interface CollaborationBridgeOptions {
    runId: string
    /** Manager-private state. This path is never disclosed to a worker. */
    sessionDir: string
    /** Stable, bridge-owned replay directory shared across session epochs. */
    challengeInflightDir?: string
    /** Exact invariant ids from the run's derived GoalContract. */
    goalInvariantIds?: readonly string[]
    pollMs?: number
    /** Explicit test-only bypass for object-identity authority binding. */
    unsafeAllowUnboundAuthorities?: boolean
    /**
     * Explicit compatibility lane for tests of the retired filesystem
     * transport. Production must leave this false/absent.
     */
    unsafeAllowFilesystemTransport?: boolean
}

export type CollaborationDeliveryMode = "live" | "poll"

/** Short-lived bearer capability issued for one exact Broker lease. */
export interface CollaborationLeaseCapability {
    endpoint: string
    token: string
    /** Messages that arrived before this exact worker capability was issued. */
    initialMessages: readonly string[]
}

export interface CollaborationLeaseCapabilityRequest {
    runId: string
    storyId: string
    leaseId: string
    generation: number
    deliveryMode: CollaborationDeliveryMode
}

interface OutboxRecord {
    leaseId?: string
    eventId?: string
    kind?: string
    text?: string
    to?: string
    reason?: string
    story?: DiscoveredWork
    proposalId?: string
    baseGraphVersion?: number
    mutation?: RuntimeReplanMutation
    blockId?: string
    requiredStoryIds?: string[]
    challengeId?: string
    invariantId?: string
}

interface RetainedChallengeRecord {
    version: 1
    kind: "challenge"
    raisedBy: string
    challengeId: string
    invariantId: string
    reason: string
}

interface ActiveLeaseCorrelation {
    storyId: string
    leaseId: string
    generation: number
    launchGraphVersion: number | null
    deliveryMode: CollaborationDeliveryMode | null
}

interface BrokerCapability extends ActiveLeaseCorrelation {
    token: string
}

interface BrokerInboxMessage {
    deliveryId: string
    ts: string
    type: string
    data: AgentTargetedMessageData
}

interface BrokerInboxGap {
    deliveryId: string
    ts: string
    type: "collaboration_delivery_gap"
    data: {
        runId: string
        storyId: string
        leaseId: string
        generation: number
        rejectedCount: number
        reason: string
    }
}

interface ProcessedBrokerEvent {
    fingerprint: string
    status: number
    receipt: Readonly<Record<string, unknown>>
}

interface ProcessRecordResult {
    deliveryGaps: readonly string[]
}

interface DecisionWaiter {
    leaseId: string
    resolve: (
        result:
            | Readonly<Record<string, unknown>>
            | "revoked"
            | null,
    ) => void
}

interface PendingReplanCorrelation {
    runId: string
    proposalId: string
    sourceStoryId: string
    leaseId: string
    generation: number
    baseGraphVersion: number
}

type PendingBlockCorrelation = WorkBlockedData

const MAX_PENDING_MESSAGES_PER_AGENT = 32
const MAX_PENDING_INBOX_BYTES = 48 * 1024
const MAX_BROKER_INBOX_MESSAGES = 32
const MAX_BROKER_INBOX_BYTES = 48 * 1024
const MAX_PROCESSED_EVENTS_PER_LEASE = 512
const MAX_HTTP_BODY_BYTES = 16 * 1024
const CHALLENGE_REPLAY_MS = 1_000

export class CollaborationBridge extends SerializedObserver {
    private readonly outboxDir: string
    /** Bridge-owned durable handoff; story tools can write only to outbox. */
    private readonly challengeInflightDir: string
    private readonly inboxDir: string
    private readonly decisionsDir: string
    /** Lease attribution is live only until the Broker's release boundary. */
    private readonly agentsByLease = new Map<string, string>()
    /** Exact live execution capability; never retained after release/replacement. */
    private readonly activeLeases = new Map<string, ActiveLeaseCorrelation>()
    private readonly activeLeaseByStory = new Map<string, string>()
    private readonly activeAgents = new Set<string>()
    private readonly capabilitiesByToken = new Map<string, BrokerCapability>()
    private readonly capabilityTokenByLease = new Map<string, string>()
    private readonly brokerInboxes = new Map<string, BrokerInboxMessage[]>()
    private readonly brokerInboxGaps = new Map<string, BrokerInboxGap>()
    private readonly pendingInboxGaps = new Map<string, number>()
    private readonly processedEventsByLease = new Map<
        string,
        Map<string, ProcessedBrokerEvent>
    >()
    private readonly brokerDecisions = new Map<
        string,
        Readonly<Record<string, unknown>>
    >()
    private readonly decisionOwners = new Map<string, string>()
    private readonly decisionWaiters = new Map<string, Set<DecisionWaiter>>()
    private readonly pendingInbox = new Map<string, AgentTargetedMessageData[]>()
    private readonly pendingReplans = new Map<string, PendingReplanCorrelation>()
    private readonly pendingBlocks = new Map<string, PendingBlockCorrelation>()
    private readonly resolvedDecisionWrites = new Map<
        string,
        Readonly<Record<string, unknown>>
    >()
    private readonly challengeLastPublishedAt = new Map<string, number>()
    private readonly persistedChallengesById = new Map<
        string,
        GoalInvariantChallengeRaisedData
    >()
    private readonly allowedGoalInvariantIds: ReadonlySet<string> | null
    private runCompleted = false
    private timer: ReturnType<typeof setInterval> | null = null
    private polling = false
    private brokerServer: Server | null = null
    private brokerStart: Promise<void> | null = null
    private brokerEndpoint: string | null = null
    private leaseAuthority: Participant | null = null
    private decisionAuthority: Participant | null = null
    private messageIntentAuthorities: ReadonlySet<Participant> | null = null

    constructor(private readonly opts: CollaborationBridgeOptions) {
        super()
        this.outboxDir = join(opts.sessionDir, "outbox")
        this.challengeInflightDir =
            opts.challengeInflightDir ??
            join(opts.sessionDir, "challenge-inflight")
        if (
            opts.goalInvariantIds &&
            (opts.goalInvariantIds.some((id) => !validGoalInvariantId(id)) ||
                new Set(opts.goalInvariantIds).size !== opts.goalInvariantIds.length)
        ) {
            throw new Error("collaboration bridge goal invariant ids are invalid")
        }
        this.allowedGoalInvariantIds = opts.goalInvariantIds
            ? new Set(opts.goalInvariantIds)
            : null
        this.inboxDir = join(opts.sessionDir, "inbox")
        this.decisionsDir = join(opts.sessionDir, "decisions")
        mkdirSync(this.challengeInflightDir, { recursive: true })
        if (opts.unsafeAllowFilesystemTransport === true) {
            mkdirSync(this.outboxDir, { recursive: true })
            mkdirSync(this.inboxDir, { recursive: true })
            mkdirSync(this.decisionsDir, { recursive: true })
        }
    }

    setLeaseAuthority(authority: Participant): void {
        if (this.leaseAuthority && this.leaseAuthority !== authority) {
            throw new Error("collaboration bridge lease authority is already bound")
        }
        this.leaseAuthority = authority
    }

    setDecisionAuthority(authority: Participant): void {
        if (this.decisionAuthority && this.decisionAuthority !== authority) {
            throw new Error("collaboration bridge decision authority is already bound")
        }
        this.decisionAuthority = authority
    }

    /** Seal the exact participants allowed to submit message intents. Worker
     * outbox messages enter through this Bridge's lease capability instead. */
    setMessageIntentAuthorities(authorities: readonly Participant[]): void {
        if (this.messageIntentAuthorities) {
            throw new Error(
                "collaboration bridge message intent authorities are already sealed",
            )
        }
        this.messageIntentAuthorities = new Set(authorities)
    }

    override onJoined(): void {
        void this.ready().catch((error) => {
            process.stderr.write(
                `[collaboration-bridge] broker start failed: ${(error as Error)?.message ?? String(error)}\n`,
            )
        })
        if (this.timer) return
        this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 150)
        this.timer.unref()
    }

    override onLeft(): void {
        void this.shutdown()
    }

    /** Start and await the loopback broker before any collective RunStart. */
    ready(): Promise<void> {
        if (this.brokerStart) return this.brokerStart
        this.brokerStart = new Promise<void>((resolve, reject) => {
            const server = createServer((request, response) => {
                void this.handleBrokerRequest(request, response).catch((error) => {
                    if (!response.headersSent) {
                        this.writeJson(response, 500, {
                            error: "collaboration broker request failed",
                        })
                    } else {
                        response.destroy()
                    }
                    process.stderr.write(
                        `[collaboration-bridge] broker request failed: ${(error as Error)?.message ?? String(error)}\n`,
                    )
                })
            })
            this.brokerServer = server
            server.headersTimeout = 10_000
            server.requestTimeout = 10_000
            server.keepAliveTimeout = 1_000
            server.once("error", reject)
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject)
                const address = server.address()
                if (!address || typeof address === "string") {
                    reject(new Error("collaboration broker has no TCP address"))
                    return
                }
                this.brokerEndpoint = `http://127.0.0.1:${address.port}`
                server.on("error", (error) => {
                    process.stderr.write(
                        `[collaboration-bridge] broker server error: ${error.message}\n`,
                    )
                })
                server.unref()
                resolve()
            })
        })
        return this.brokerStart
    }

    /**
     * Issue exactly one opaque capability for the current run/story/lease/
     * generation. The caller is manager code; the resulting endpoint/token is
     * the only collaboration state disclosed to the worker.
     */
    capabilityForLease(
        request: CollaborationLeaseCapabilityRequest,
    ): CollaborationLeaseCapability {
        if (!this.brokerEndpoint || this.runCompleted) {
            throw new Error("collaboration broker is not ready")
        }
        const active = this.activeLeases.get(request.leaseId)
        if (
            request.runId !== this.opts.runId ||
            !active ||
            active.storyId !== request.storyId ||
            active.generation !== request.generation ||
            this.activeLeaseByStory.get(request.storyId) !== request.leaseId
        ) {
            throw new Error("collaboration capability requires the exact active lease")
        }
        if (
            active.deliveryMode !== null &&
            active.deliveryMode !== request.deliveryMode
        ) {
            throw new Error("collaboration delivery mode is already bound")
        }
        active.deliveryMode = request.deliveryMode

        let token = this.capabilityTokenByLease.get(active.leaseId)
        if (!token) {
            token = randomBytes(32).toString("base64url")
            const capability: BrokerCapability = { ...active, token }
            this.capabilityTokenByLease.set(active.leaseId, token)
            this.capabilitiesByToken.set(token, capability)
            this.brokerInboxes.set(active.leaseId, [])
            this.processedEventsByLease.set(active.leaseId, new Map())
        }

        const initialMessages: string[] = []
        const pending = this.pendingInbox.get(active.storyId) ?? []
        const pendingGapCount = this.pendingInboxGaps.get(active.storyId) ?? 0
        this.pendingInbox.delete(active.storyId)
        this.pendingInboxGaps.delete(active.storyId)
        // Pre-launch messages enter the initial prompt for every backend.
        // One-shot poll workers must not depend on voluntarily discovering
        // already-known context via a later inbox command.
        for (const intent of pending) {
            initialMessages.push(intent.text)
            this.publishCorrelatedMessage(intent, active, false)
        }
        if (pendingGapCount > 0) {
            const text = deliveryGapText(pendingGapCount)
            initialMessages.push(text)
            this.publishCorrelatedMessage(
                {
                    recipientId: active.storyId,
                    text,
                    metadata: { kind: "delivery_gap" },
                },
                active,
                false,
            )
        }
        return Object.freeze({
            endpoint: this.brokerEndpoint,
            token,
            initialMessages: Object.freeze(initialMessages),
        })
    }

    async shutdown(): Promise<void> {
        this.stopPolling()
        this.revokeAllCapabilities()
        if (this.brokerStart) {
            await this.brokerStart.catch(() => undefined)
        }
        await this.closeBrokerServer()
    }

    protected override handleEvent(context: SerializedEventContext): void {
        const { event } = context
        if (WorkLeaseGranted.is(event) && event.data.runId === this.opts.runId) {
            if (
                context.source !== this.leaseAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            const agentId = event.data.request.storyId
            const previousLeaseId = this.activeLeaseByStory.get(agentId)
            const previous = previousLeaseId
                ? this.activeLeases.get(previousLeaseId)
                : undefined
            if (
                previous?.leaseId === event.data.leaseId &&
                previous.generation === event.data.generation
            ) return
            if (
                previous &&
                (event.data.generation < previous.generation ||
                    (event.data.generation === previous.generation &&
                        event.data.leaseId !== previous.leaseId))
            ) return
            if (
                previousLeaseId &&
                (previousLeaseId !== event.data.leaseId ||
                    previous?.generation !== event.data.generation)
            ) {
                this.revokeCapability(previousLeaseId)
                this.activeLeases.delete(previousLeaseId)
                this.agentsByLease.delete(previousLeaseId)
            }
            this.agentsByLease.set(event.data.leaseId, agentId)
            this.activeLeases.set(event.data.leaseId, {
                storyId: agentId,
                leaseId: event.data.leaseId,
                generation: event.data.generation,
                launchGraphVersion: positiveIntegerOrNull(
                    event.data.request.graphVersion,
                ),
                deliveryMode:
                    this.opts.unsafeAllowFilesystemTransport === true
                        ? "poll"
                        : null,
            })
            this.activeLeaseByStory.set(agentId, event.data.leaseId)
            this.activeAgents.add(agentId)
            // A stable story id may be leased repeatedly. Never expose a
            // previous execution's inbox to the new capability.
            this.resetInbox(agentId)
            if (this.opts.unsafeAllowFilesystemTransport === true) {
                const active = this.activeLeases.get(event.data.leaseId)!
                const pending = this.pendingInbox.get(agentId) ?? []
                this.pendingInbox.delete(agentId)
                for (const intent of pending) this.deliverMessage(intent, active)
            }
            return
        }
        if (WorkLeaseReleased.is(event) && event.data.runId === this.opts.runId) {
            if (
                context.source !== this.leaseAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            // The worker writes atomically before reporting its terminal
            // result, while the bridge normally polls later. Drain every
            // already-committed record while the exact lease capability is
            // still live, then revoke it. A final challenge can therefore not
            // disappear in the poll/release race; records created after this
            // boundary remain correctly stale.
            if (this.opts.unsafeAllowFilesystemTransport === true) {
                this.consumeAvailableOutbox()
            }
            const active = this.activeLeases.get(event.data.leaseId)
            if (active?.storyId === event.data.storyId) {
                // `consumeAvailableOutbox` above is the revocation barrier:
                // records atomically committed before it retain attribution;
                // anything committed after it is stale, including notes. A
                // stale note could otherwise influence Dialogue indirectly.
                this.agentsByLease.delete(event.data.leaseId)
                this.revokeCapability(event.data.leaseId)
                this.activeLeases.delete(event.data.leaseId)
                if (
                    this.activeLeaseByStory.get(event.data.storyId) ===
                    event.data.leaseId
                ) {
                    this.activeLeaseByStory.delete(event.data.storyId)
                    this.activeAgents.delete(event.data.storyId)
                }
            }
            return
        }
        if (
            (RuntimeReplanApplied.is(event) || RuntimeReplanRejected.is(event)) &&
            event.data.runId === this.opts.runId
        ) {
            if (
                context.source !== this.decisionAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            this.onRuntimeReplanDecision(event)
            return
        }
        if (
            (WorkBlockAccepted.is(event) || WorkBlockRejected.is(event)) &&
            event.data.runId === this.opts.runId
        ) {
            if (
                context.source !== this.decisionAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            this.onWorkBlockDecision(event)
            return
        }
        if (
            GoalLedgerProjectionPersisted.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (
                context.source !== this.decisionAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            this.onGoalLedgerProjectionPersisted(event.data)
            return
        }
        if (AgentTargetedMessage.is(event)) {
            // A Bridge-sourced event is already the single authenticated
            // delivery emitted by routeMessageIntent. It must never recurse
            // back through the intent path.
            if (context.source === this) return
            if (this.runCompleted) return
            if (
                this.messageIntentAuthorities?.has(context.source) !== true &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            this.routeMessageIntent(event.data)
            return
        }
        if (PeerHelpRequested.is(event) && event.data.runId === this.opts.runId) {
            // Worker help is routed synchronously when its active outbox
            // record is consumed. This event is its audit projection only.
            if (context.source !== this) return
            return
        }
        if (RunCompleted.is(event) && event.data.runId === this.opts.runId) {
            if (
                context.source !== this.decisionAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            if (this.opts.unsafeAllowFilesystemTransport === true) {
                this.consumeAvailableOutbox()
            }
            this.agentsByLease.clear()
            this.activeLeases.clear()
            this.activeLeaseByStory.clear()
            this.activeAgents.clear()
            this.pendingInbox.clear()
            this.pendingInboxGaps.clear()
            this.runCompleted = true
            for (const pending of this.pendingReplans.values()) {
                if (this.resolvedDecisionWrites.has(pending.proposalId)) continue
                this.resolvedDecisionWrites.set(pending.proposalId, {
                    status: "rejected",
                    code: "run_completed",
                    proposalId: pending.proposalId,
                    reason: "the collective run completed before the proposal was decided",
                })
            }
            for (const pending of this.pendingBlocks.values()) {
                if (this.resolvedDecisionWrites.has(pending.blockId)) continue
                this.resolvedDecisionWrites.set(pending.blockId, {
                    status: "rejected",
                    code: "run_completed",
                    blockId: pending.blockId,
                    reason: "the collective run completed before the dependency block was decided",
                })
            }
            for (const proposalId of [
                ...this.resolvedDecisionWrites.keys(),
            ]) {
                try {
                    this.flushResolvedDecision(proposalId)
                } catch (error) {
                    process.stderr.write(
                        `[collaboration-bridge] final decision write failed: ${(error as Error)?.message ?? String(error)}\n`,
                    )
                }
            }
            // Resolve already-authenticated long polls with the deterministic
            // terminal decision before revoking every capability. New requests
            // after this boundary are rejected.
            this.revokeAllCapabilities()
            if (this.resolvedDecisionWrites.size === 0) this.stopPolling()
            void this.closeBrokerServer()
        }
    }

    protected override onManagedFailure(failure: SerializedObserverFailure): void {
        process.stderr.write(`[collaboration-bridge] ${failure.error.message}\n`)
    }

    private poll(): void {
        if (this.polling) return
        this.polling = true
        this.spawnTask({ label: "poll collaboration outbox", key: "outbox" }, async () => {
            try {
                for (const proposalId of [
                    ...this.resolvedDecisionWrites.keys(),
                ]) {
                    try {
                        this.flushResolvedDecision(proposalId)
                    } catch (error) {
                        process.stderr.write(
                            `[collaboration-bridge] decision retry failed: ${(error as Error)?.message ?? String(error)}\n`,
                        )
                    }
                }
                if (this.runCompleted) {
                    if (this.resolvedDecisionWrites.size === 0) this.stopPolling()
                    return
                }
                this.publishAvailableInflightChallenges()
                if (this.opts.unsafeAllowFilesystemTransport === true) {
                    if (!existsSync(this.outboxDir)) {
                        this.stopPolling()
                        return
                    }
                    this.consumeAvailableOutbox()
                }
            } finally {
                this.polling = false
            }
        })
    }

    private consumeAvailableOutbox(): void {
        if (!existsSync(this.outboxDir)) return
        const files = readdirSync(this.outboxDir)
            .filter((name) => name.endsWith(".json"))
            .sort()
        for (const name of files) this.consume(join(this.outboxDir, name))
    }

    private consume(path: string): void {
        let removeOutboxRecord = true
        try {
            const stat = lstatSync(path)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
                return
            }
            const record = JSON.parse(readFileSync(path, "utf8")) as OutboxRecord
            const agentId = record.leaseId
                ? this.agentsByLease.get(record.leaseId)
                : undefined
            if (!agentId) {
                if (record.kind === "replan" && validProposalId(record.proposalId)) {
                    this.queueDecision(record.proposalId, {
                        status: "rejected",
                        code: "stale_lease",
                        proposalId: record.proposalId,
                        reason: "runtime replan lease is unknown or no longer attributable",
                    })
                } else if (
                    record.kind === "block" &&
                    validProposalId(record.blockId)
                ) {
                    this.queueDecision(record.blockId, {
                        status: "rejected",
                        code: "stale_lease",
                        blockId: record.blockId,
                        reason: "dependency block lease is unknown or no longer attributable",
                    })
                }
                return
            }
            const activeLease = record.leaseId
                ? this.activeLeases.get(record.leaseId)
                : undefined
            this.processRecord(record, agentId, activeLease)
        } catch (error) {
            process.stderr.write(
                `[collaboration-bridge] ignored invalid outbox record: ${(error as Error)?.message ?? String(error)}\n`,
            )
        } finally {
            if (removeOutboxRecord) {
                try {
                    unlinkSync(path)
                } catch {}
            }
        }
    }

    /**
     * Process one already-authenticated record. Challenge input is normalized
     * into private durable storage before its source is acknowledged.
     */
    private processRecord(
        record: OutboxRecord,
        agentId: string,
        activeLease: ActiveLeaseCorrelation | undefined,
    ): ProcessRecordResult {
        const deliveryGaps: string[] = []
        const text = typeof record.text === "string" ? record.text.trim() : ""
        const liveSource =
            activeLease?.storyId === agentId &&
            this.activeLeaseByStory.get(agentId) === activeLease.leaseId

        if (record.kind === "message" && text && record.to && liveSource) {
            const outcome = this.routeMessageIntent({
                recipientId: record.to,
                text,
                metadata: { kind: "peer_message", sourceAgentId: agentId },
            })
            if (outcome === "overflow") deliveryGaps.push(record.to)
        } else if (record.kind === "help" && text && liveSource) {
            deliveryGaps.push(...this.broadcastPeerHelp(agentId, text))
            this.publish(
                PeerHelpRequested.create({
                    runId: this.opts.runId,
                    sourceAgentId: agentId,
                    text,
                }),
            )
        } else if (record.kind === "note" && text && liveSource) {
            this.publish(
                CollaborationNote.create({
                    runId: this.opts.runId,
                    sourceAgentId: agentId,
                    text,
                }),
            )
        } else if (record.kind === "discover" && validStory(record.story)) {
            if (liveSource && activeLease) {
                this.publish(
                    WorkDiscovered.create({
                        runId: this.opts.runId,
                        sourceAgentId: agentId,
                        leaseId: activeLease.leaseId,
                        generation: activeLease.generation,
                        reason:
                            record.reason?.trim() ||
                            "worker discovered required follow-up work",
                        story: record.story,
                    }),
                )
            }
        } else if (
            record.kind === "challenge" &&
            validProposalId(record.challengeId) &&
            validGoalInvariantId(record.invariantId) &&
            validReason(record.reason)
        ) {
            if (liveSource && activeLease) {
                const disposition = this.challengeDisposition(record, agentId)
                if (disposition === "duplicate") return { deliveryGaps }
                if (disposition !== "new") {
                    process.stderr.write(
                        `[collaboration-bridge] rejected challenge: ${disposition}\n`,
                    )
                    return { deliveryGaps }
                }
                const inflightPath = join(
                    this.challengeInflightDir,
                    `${randomUUID()}.json`,
                )
                // Always normalize into a manager-owned envelope. Agent ids
                // never enter filenames, avoiding Unicode codec collisions,
                // path separators, and ENAMETOOLONG for legitimate long ids.
                this.persistInflightChallenge(inflightPath, record, agentId)
                this.publishInflightChallenge(inflightPath, true)
                return { deliveryGaps }
            }
        } else if (record.kind === "replan") {
            this.publishRuntimeReplan(record, agentId)
        } else if (record.kind === "block") {
            this.publishWorkBlocked(record, agentId)
        }
        return { deliveryGaps }
    }

    private challengeDisposition(
        record: OutboxRecord,
        raisedBy: string,
    ): "new" | "duplicate" | string {
        if (
            this.allowedGoalInvariantIds &&
            !this.allowedGoalInvariantIds.has(record.invariantId!)
        ) {
            return `invariant ${record.invariantId} is not in the active GoalContract`
        }
        const candidate: GoalInvariantChallengeRaisedData = {
            runId: this.opts.runId,
            challengeId: record.challengeId!,
            invariantId: record.invariantId!,
            raisedBy,
            reason: record.reason!.trim(),
            storyId: raisedBy,
        }
        const persisted = this.persistedChallengesById.get(
            candidate.challengeId,
        )
        if (persisted) {
            return sameChallenge(candidate, persisted)
                ? "duplicate"
                : `challenge id ${candidate.challengeId} conflicts with persisted evidence`
        }
        if (existsSync(this.challengeInflightDir)) {
            for (const name of readdirSync(this.challengeInflightDir)) {
                if (!name.endsWith(".json")) continue
                try {
                    const retained = this.readInflightChallenge(
                        join(this.challengeInflightDir, name),
                    )
                    if (retained.challengeId !== candidate.challengeId) continue
                    return sameChallenge(candidate, retained)
                        ? "duplicate"
                        : `challenge id ${candidate.challengeId} conflicts with retained evidence`
                } catch {
                    // Damaged unrelated records remain fail-closed for replay;
                    // they cannot authorize or suppress this challenge.
                }
            }
        }
        return "new"
    }

    private persistInflightChallenge(
        path: string,
        record: OutboxRecord,
        raisedBy: string,
    ): void {
        const pending = `${path}.${randomUUID()}.tmp`
        try {
            const retained: RetainedChallengeRecord = {
                version: 1,
                kind: "challenge",
                raisedBy,
                challengeId: record.challengeId!,
                invariantId: record.invariantId!,
                reason: record.reason!,
            }
            writeFileSync(pending, JSON.stringify(retained), {
                flag: "wx",
                mode: 0o600,
            })
            renameSync(pending, path)
        } catch (error) {
            try {
                unlinkSync(pending)
            } catch {}
            throw error
        }
    }

    private publishAvailableInflightChallenges(): void {
        if (!existsSync(this.challengeInflightDir)) return
        const files = readdirSync(this.challengeInflightDir)
            .filter((name) => name.endsWith(".json"))
            .sort()
        for (const name of files) {
            try {
                this.publishInflightChallenge(
                    join(this.challengeInflightDir, name),
                    false,
                )
            } catch (error) {
                // A damaged retained record fails closed in place, but must
                // not prevent later valid challenges from being replayed.
                process.stderr.write(
                    `[collaboration-bridge] retained challenge replay failed: ${(error as Error)?.message ?? String(error)}\n`,
                )
            }
        }
    }

    private publishInflightChallenge(path: string, force: boolean): void {
        const now = Date.now()
        const lastPublishedAt = this.challengeLastPublishedAt.get(path)
        if (
            !force &&
            lastPublishedAt !== undefined &&
            now - lastPublishedAt < CHALLENGE_REPLAY_MS
        ) return
        const challenge = this.readInflightChallenge(path)
        this.challengeLastPublishedAt.set(path, now)
        this.publish(GoalInvariantChallengeRaised.create(challenge))
    }

    private readInflightChallenge(path: string): GoalInvariantChallengeRaisedData {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
            throw new Error("retained goal challenge is not a safe transport file")
        }
        const record = JSON.parse(readFileSync(path, "utf8")) as
            | RetainedChallengeRecord
            | OutboxRecord
        // Compatibility with inflight records created before the broker
        // envelope existed. Every newly persisted record carries attribution
        // in its manager-owned contents and uses a random filename.
        const raisedBy =
            "version" in record && record.version === 1
                ? record.raisedBy
                : decodeInflightAgentId(basename(path))
        if (
            !validRaisedBy(raisedBy) ||
            record.kind !== "challenge" ||
            !validProposalId(record.challengeId) ||
            !validGoalInvariantId(record.invariantId) ||
            !validReason(record.reason)
        ) {
            throw new Error("retained goal challenge is malformed")
        }
        return {
            runId: this.opts.runId,
            challengeId: record.challengeId,
            invariantId: record.invariantId,
            raisedBy,
            reason: record.reason.trim(),
            storyId: raisedBy,
        }
    }

    private onGoalLedgerProjectionPersisted(
        receipt: GoalLedgerProjectionPersistedData,
    ): void {
        if (
            receipt.projection.contractId !== receipt.contractId ||
            receipt.projection.revision !== receipt.revision ||
            !Array.isArray(receipt.projection.challenges)
        ) return
        this.persistedChallengesById.clear()
        for (const challenge of receipt.projection.challenges) {
            this.persistedChallengesById.set(challenge.challengeId, {
                runId: this.opts.runId,
                challengeId: challenge.challengeId,
                invariantId: challenge.invariantId,
                raisedBy: challenge.raisedBy,
                reason: challenge.reason,
                ...(challenge.storyId ? { storyId: challenge.storyId } : {}),
            })
        }
        if (!existsSync(this.challengeInflightDir)) return
        const files = readdirSync(this.challengeInflightDir)
            .filter((name) => name.endsWith(".json"))
            .sort()
        for (const name of files) {
            const path = join(this.challengeInflightDir, name)
            try {
                const retained = this.readInflightChallenge(path)
                const persisted = receipt.projection.challenges.some(
                    (challenge) =>
                        challenge.challengeId === retained.challengeId &&
                        challenge.invariantId === retained.invariantId &&
                        challenge.raisedBy === retained.raisedBy &&
                        challenge.reason === retained.reason &&
                        challenge.storyId === retained.storyId,
                )
                if (!persisted) continue
                unlinkSync(path)
                this.challengeLastPublishedAt.delete(path)
            } catch (error) {
                process.stderr.write(
                    `[collaboration-bridge] retained challenge ack failed: ${(error as Error)?.message ?? String(error)}\n`,
                )
            }
        }
    }

    private routeMessageIntent(
        data: AgentTargetedMessageData,
    ): "delivered" | "queued" | "overflow" {
        if (this.runCompleted || !data.recipientId || !data.text.trim()) {
            return "overflow"
        }
        const active = this.activeLeaseForStory(data.recipientId)
        if (active?.deliveryMode) {
            return this.deliverMessage(data, active)
                ? "delivered"
                : "overflow"
        }
        const pending = this.pendingInbox.get(data.recipientId) ?? []
        const candidate = {
            recipientId: data.recipientId,
            text: data.text,
            metadata: Object.freeze({ ...data.metadata }),
        }
        if (
            pending.length >= MAX_PENDING_MESSAGES_PER_AGENT ||
            Buffer.byteLength(
                JSON.stringify([...pending, candidate]),
                "utf8",
            ) > MAX_PENDING_INBOX_BYTES
        ) {
            this.pendingInboxGaps.set(
                data.recipientId,
                (this.pendingInboxGaps.get(data.recipientId) ?? 0) + 1,
            )
            return "overflow"
        }
        pending.push(candidate)
        this.pendingInbox.set(data.recipientId, pending)
        return "queued"
    }

    private deliverMessage(
        intent: AgentTargetedMessageData,
        active: ActiveLeaseCorrelation,
    ): boolean {
        return this.publishCorrelatedMessage(
            intent,
            active,
            active.deliveryMode === "poll",
        )
    }

    private publishCorrelatedMessage(
        intent: AgentTargetedMessageData,
        active: ActiveLeaseCorrelation,
        queueForPoll: boolean,
    ): boolean {
        const data = correlatedTargetedMessage(intent, {
            runId: this.opts.runId,
            recipientId: active.storyId,
            leaseId: active.leaseId,
            generation: active.generation,
        })
        const event = AgentTargetedMessage.create(data)
        if (queueForPoll) {
            const inbox = this.brokerInboxes.get(active.leaseId) ?? []
            const candidate: BrokerInboxMessage = {
                deliveryId: randomUUID(),
                ts: new Date().toISOString(),
                type: event.type,
                data: event.data,
            }
            // Reserve enough space for the fail-closed gap marker even before
            // the first rejection. The GET response therefore remains within
            // the same byte bound after overflow, including long correlations.
            const existingGap = this.brokerInboxGaps.get(active.leaseId)
            const gapForSizing: BrokerInboxGap = existingGap
                ? {
                      ...existingGap,
                      data: {
                          ...existingGap.data,
                          rejectedCount: Number.MAX_SAFE_INTEGER,
                      },
                  }
                : this.newBrokerInboxGap(
                      active,
                      Number.MAX_SAFE_INTEGER,
                      "00000000-0000-4000-8000-000000000000",
                      "0000-01-01T00:00:00.000Z",
                  )
            if (
                inbox.length >= MAX_BROKER_INBOX_MESSAGES ||
                Buffer.byteLength(
                    JSON.stringify([...inbox, candidate, gapForSizing]),
                    "utf8",
                ) > MAX_BROKER_INBOX_BYTES
            ) {
                this.recordBrokerInboxGap(active, 1)
                // A poll delivery is not a delivery until it is durably held
                // for the lease. Publishing the model-facing semantic event
                // here would falsely claim success after the bounded mailbox
                // rejected it.
                return false
            } else {
                inbox.push(candidate)
                this.brokerInboxes.set(active.leaseId, inbox)
            }
        }
        if (this.opts.unsafeAllowFilesystemTransport === true) {
            this.writeUnsafeInbox(active.storyId, {
                type: event.type,
                data: event.data,
            })
        }
        this.publish(event)
        return true
    }

    private recordBrokerInboxGap(
        active: ActiveLeaseCorrelation,
        rejectedCount: number,
    ): void {
        const existing = this.brokerInboxGaps.get(active.leaseId)
        if (existing) {
            existing.data.rejectedCount += rejectedCount
            return
        }
        this.brokerInboxGaps.set(
            active.leaseId,
            this.newBrokerInboxGap(active, rejectedCount),
        )
    }

    private newBrokerInboxGap(
        active: ActiveLeaseCorrelation,
        rejectedCount: number,
        deliveryId = randomUUID(),
        ts = new Date().toISOString(),
    ): BrokerInboxGap {
        return {
            deliveryId,
            ts,
            type: "collaboration_delivery_gap",
            data: {
                runId: this.opts.runId,
                storyId: active.storyId,
                leaseId: active.leaseId,
                generation: active.generation,
                rejectedCount,
                reason:
                    "The bounded collaboration mailbox rejected messages before delivery. Reconcile with peers before relying on complete context.",
            },
        }
    }

    private broadcastPeerHelp(sourceAgentId: string, text: string): string[] {
        const gaps: string[] = []
        for (const agentId of this.activeAgents) {
            if (agentId === sourceAgentId) continue
            const result = this.routeMessageIntent({
                recipientId: agentId,
                text: `${sourceAgentId} asks for help: ${text}`,
                metadata: { kind: "peer_help", sourceAgentId },
            })
            if (result === "overflow") gaps.push(agentId)
        }
        return gaps
    }

    private activeLeaseForStory(
        storyId: string,
    ): ActiveLeaseCorrelation | undefined {
        const leaseId = this.activeLeaseByStory.get(storyId)
        return leaseId ? this.activeLeases.get(leaseId) : undefined
    }

    private resetInbox(agentId: string): void {
        if (this.opts.unsafeAllowFilesystemTransport !== true) return
        try {
            unlinkSync(join(this.inboxDir, inboxFilenameForAgentId(agentId)))
        } catch {}
    }

    private writeUnsafeInbox(agentId: string, value: unknown): void {
        appendFileSync(
            join(this.inboxDir, inboxFilenameForAgentId(agentId)),
            JSON.stringify({ ts: new Date().toISOString(), ...asRecord(value) }) + "\n",
        )
    }

    private stopPolling(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    private publishRuntimeReplan(record: OutboxRecord, agentId: string): void {
        const proposalId = validProposalId(record.proposalId)
            ? record.proposalId
            : null
        if (!proposalId) return

        const active = record.leaseId
            ? this.activeLeases.get(record.leaseId)
            : undefined
        const currentLeaseId = this.activeLeaseByStory.get(agentId)
        if (
            !active ||
            active.storyId !== agentId ||
            currentLeaseId !== active.leaseId ||
            active.launchGraphVersion === null ||
            !isPositiveInteger(record.baseGraphVersion)
        ) {
            this.queueDecision(proposalId, {
                status: "rejected",
                code: "stale_lease",
                proposalId,
                reason: "runtime replan requires the source story's current versioned lease",
            })
            return
        }
        if (!validReplanMutation(record.mutation)) {
            this.queueDecision(proposalId, {
                status: "rejected",
                code: "invalid_proposal",
                proposalId,
                reason: "runtime replan mutation has an invalid transport shape",
            })
            return
        }

        const correlation: PendingReplanCorrelation = {
            runId: this.opts.runId,
            proposalId,
            sourceStoryId: active.storyId,
            leaseId: active.leaseId,
            generation: active.generation,
            baseGraphVersion: record.baseGraphVersion,
        }
        if (this.resolvedDecisionWrites.has(proposalId)) {
            this.flushResolvedDecision(proposalId)
            return
        }
        if (!this.pendingReplans.has(proposalId)) {
            this.pendingReplans.set(proposalId, correlation)
        }
        this.publish(
            RuntimeReplanProposed.create({
                ...correlation,
                reason:
                    typeof record.reason === "string" && record.reason.trim()
                        ? record.reason.trim()
                        : "worker proposed a runtime DAG adaptation",
                mutation: snapshotRuntimeReplanMutation(record.mutation),
            }),
        )
    }

    private publishWorkBlocked(record: OutboxRecord, agentId: string): void {
        const blockId = validProposalId(record.blockId) ? record.blockId : null
        if (!blockId) return

        const active = record.leaseId
            ? this.activeLeases.get(record.leaseId)
            : undefined
        const currentLeaseId = this.activeLeaseByStory.get(agentId)
        if (
            !active ||
            active.storyId !== agentId ||
            currentLeaseId !== active.leaseId
        ) {
            this.queueDecision(blockId, {
                status: "rejected",
                code: "stale_lease",
                blockId,
                reason: "dependency block requires the source story's current lease",
            })
            return
        }
        if (!validRequiredStoryIds(record.requiredStoryIds)) {
            this.queueDecision(blockId, {
                status: "rejected",
                code: "invalid_request",
                blockId,
                reason: "dependency block requires one or more unique story ids",
            })
            return
        }

        const correlation: PendingBlockCorrelation = {
            runId: this.opts.runId,
            blockId,
            storyId: active.storyId,
            leaseId: active.leaseId,
            generation: active.generation,
            requiredStoryIds: [...record.requiredStoryIds],
            reason:
                typeof record.reason === "string" && record.reason.trim()
                    ? record.reason.trim()
                    : "worker is blocked on prerequisite work",
        }
        if (this.resolvedDecisionWrites.has(blockId)) {
            this.flushResolvedDecision(blockId)
            return
        }
        if (!this.pendingBlocks.has(blockId)) {
            this.pendingBlocks.set(blockId, correlation)
        }
        this.publish(WorkBlocked.create(correlation))
    }

    private onRuntimeReplanDecision(
        event:
            | ReturnType<typeof RuntimeReplanApplied.create>
            | ReturnType<typeof RuntimeReplanRejected.create>,
    ): void {
        const pending = this.pendingReplans.get(event.data.proposalId)
        if (!pending || !sameCorrelation(pending, event.data)) return
        this.resolvedDecisionWrites.set(event.data.proposalId, {
            status: RuntimeReplanApplied.is(event) ? "applied" : "rejected",
            ...event.data,
        })
        this.flushResolvedDecision(event.data.proposalId)
    }

    private onWorkBlockDecision(
        event:
            | ReturnType<typeof WorkBlockAccepted.create>
            | ReturnType<typeof WorkBlockRejected.create>,
    ): void {
        const pending = this.pendingBlocks.get(event.data.blockId)
        if (!pending || !sameBlockCorrelation(pending, event.data)) return
        this.resolvedDecisionWrites.set(event.data.blockId, {
            status: WorkBlockAccepted.is(event) ? "accepted" : "rejected",
            ...event.data,
        })
        this.flushResolvedDecision(event.data.blockId)
    }

    private queueDecision(
        proposalId: string,
        decision: Readonly<Record<string, unknown>>,
    ): void {
        this.resolvedDecisionWrites.set(proposalId, decision)
        this.flushResolvedDecision(proposalId)
    }

    private flushResolvedDecision(proposalId: string): void {
        const decision = this.resolvedDecisionWrites.get(proposalId)
        if (!decision) return
        this.writeDecision(proposalId, decision)
        if (this.decisionOwners.has(proposalId)) {
            this.brokerDecisions.set(proposalId, decision)
            this.resolveDecisionWaiters(proposalId, decision)
        }
        this.resolvedDecisionWrites.delete(proposalId)
        this.pendingReplans.delete(proposalId)
        this.pendingBlocks.delete(proposalId)
        if (this.runCompleted && this.resolvedDecisionWrites.size === 0) {
            this.stopPolling()
        }
    }

    private writeDecision(
        proposalId: string,
        decision: Readonly<Record<string, unknown>>,
    ): void {
        if (this.opts.unsafeAllowFilesystemTransport !== true) return
        const name = safeName(proposalId)
        const path = join(this.decisionsDir, `${name}.json`)
        if (existsSync(path)) return
        const pending = join(
            this.decisionsDir,
            `.${name}.${randomUUID()}.tmp`,
        )
        try {
            writeFileSync(pending, JSON.stringify(decision), {
                flag: "wx",
                mode: 0o600,
            })
            renameSync(pending, path)
        } catch (error) {
            try {
                unlinkSync(pending)
            } catch {}
            throw error
        }
    }

    private async handleBrokerRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        response.setHeader("cache-control", "no-store")
        response.setHeader("x-content-type-options", "nosniff")
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
            this.writeJson(response, 403, { error: "loopback access required" })
            return
        }
        const capability = this.authenticateBrokerRequest(request)
        if (!capability) {
            this.writeJson(response, 401, { error: "invalid or revoked capability" })
            return
        }
        const target = new URL(request.url ?? "/", "http://127.0.0.1")

        if (request.method === "GET" && target.pathname === "/v1/inbox") {
            if (capability.deliveryMode !== "poll") {
                this.writeJson(response, 409, {
                    error: "this lease receives collaboration messages live",
                })
                return
            }
            const inbox = this.brokerInboxes.get(capability.leaseId) ?? []
            const gap = this.brokerInboxGaps.get(capability.leaseId)
            const messages: Array<BrokerInboxMessage | BrokerInboxGap> = [
                ...inbox,
                ...(gap ? [gap] : []),
            ]
            this.writeJson(response, 200, { messages })
            return
        }

        if (
            request.method === "POST" &&
            target.pathname === "/v1/inbox/ack"
        ) {
            request.setTimeout(10_000, () => request.destroy())
            let value: unknown
            try {
                value = await readBoundedJsonBody(request)
            } catch (error) {
                this.writeJson(response, 400, {
                    error: (error as Error)?.message ?? "invalid JSON body",
                })
                return
            } finally {
                request.setTimeout(0)
            }
            if (this.authenticateBrokerRequest(request) !== capability) {
                this.writeJson(response, 401, {
                    error: "collaboration capability was revoked",
                })
                return
            }
            const deliveryIds = parseDeliveryAcknowledgement(value)
            if (typeof deliveryIds === "string") {
                this.writeJson(response, 400, { error: deliveryIds })
                return
            }
            const acknowledged = new Set(deliveryIds)
            const current = this.brokerInboxes.get(capability.leaseId) ?? []
            const retained = current.filter(
                (message) => !acknowledged.has(message.deliveryId),
            )
            this.brokerInboxes.set(capability.leaseId, retained)
            let acknowledgedCount = current.length - retained.length
            const gap = this.brokerInboxGaps.get(capability.leaseId)
            if (gap && acknowledged.has(gap.deliveryId)) {
                this.brokerInboxGaps.delete(capability.leaseId)
                acknowledgedCount += 1
            }
            this.writeJson(response, 200, {
                acknowledged: acknowledgedCount,
            })
            return
        }

        const decisionPrefix = "/v1/decisions/"
        if (
            request.method === "GET" &&
            target.pathname.startsWith(decisionPrefix)
        ) {
            const rawId = decodeURIComponent(
                target.pathname.slice(decisionPrefix.length),
            )
            if (!validProposalId(rawId)) {
                this.writeJson(response, 400, { error: "invalid decision id" })
                return
            }
            if (this.decisionOwners.get(rawId) !== capability.leaseId) {
                this.writeJson(response, 404, { error: "decision not found" })
                return
            }
            const waitMs = boundedHttpWaitMs(target.searchParams.get("waitMs"))
            if (waitMs === null) {
                this.writeJson(response, 400, {
                    error: "waitMs must be an integer between 1 and 300000",
                })
                return
            }
            const decision = await this.waitForBrokerDecision(
                rawId,
                capability.leaseId,
                waitMs,
            )
            if (decision === "revoked") {
                this.writeJson(response, 401, {
                    error: "collaboration capability was revoked",
                })
            } else if (decision === null) {
                this.writeJson(response, 202, {
                    status: "outcome_unknown",
                    proposalId: rawId,
                    waitMs,
                })
            } else {
                this.writeJson(response, 200, { decision })
            }
            return
        }

        if (request.method === "POST" && target.pathname === "/v1/events") {
            request.setTimeout(10_000, () => request.destroy())
            let value: unknown
            try {
                value = await readBoundedJsonBody(request)
            } catch (error) {
                this.writeJson(response, 400, {
                    error: (error as Error)?.message ?? "invalid JSON body",
                })
                return
            } finally {
                request.setTimeout(0)
            }
            const parsed = parseBrokerRecord(value)
            if (typeof parsed === "string") {
                this.writeJson(response, 400, { error: parsed })
                return
            }
            // Reading a request body yields to the event loop. The Broker may
            // release or replace this lease during that gap, so authenticate
            // the exact capability again before mutating any Bridge state.
            if (this.authenticateBrokerRequest(request) !== capability) {
                this.writeJson(response, 401, {
                    error: "collaboration capability was revoked",
                })
                return
            }
            if (parsed.kind === "challenge") {
                const disposition = this.challengeDisposition(
                    parsed,
                    capability.storyId,
                )
                if (disposition === "duplicate") {
                    this.writeJson(response, 202, {
                        status: "queued",
                        kind: parsed.kind,
                        challengeId: parsed.challengeId,
                        invariantId: parsed.invariantId,
                        duplicate: true,
                    })
                    return
                }
                if (disposition !== "new") {
                    this.writeJson(
                        response,
                        disposition.startsWith("invariant ") ? 400 : 422,
                        { error: disposition },
                    )
                    return
                }
            }
            const eventId = parsed.eventId
            const fingerprint = eventId
                ? canonicalJson(parsed)
                : null
            const processedEvents = eventId
                ? this.processedEventsByLease.get(capability.leaseId) ?? new Map()
                : null
            if (eventId && processedEvents && fingerprint) {
                const existing = processedEvents.get(eventId)
                if (existing) {
                    if (existing.fingerprint !== fingerprint) {
                        this.writeJson(response, 422, {
                            error: `event id ${eventId} was already used with a different payload`,
                        })
                        return
                    }
                    // Replaying an idempotency key must replay the original
                    // outcome as well as the body. In particular, a lost 429
                    // delivery-gap receipt cannot become a misleading 202 on
                    // retry even though no second side effect is applied.
                    this.writeJson(response, existing.status, {
                        ...existing.receipt,
                        duplicate: true,
                        originalStatus: existing.status,
                    })
                    return
                }
                if (processedEvents.size >= MAX_PROCESSED_EVENTS_PER_LEASE) {
                    this.writeJson(response, 429, {
                        ok: false,
                        status: "rejected",
                        eventId,
                        error:
                            "the lease reached its bounded collaboration event-id capacity; no side effect was applied",
                    })
                    return
                }
            }
            const record: OutboxRecord = {
                ...parsed,
                leaseId: capability.leaseId,
            }
            const decisionId = record.kind === "replan"
                ? record.proposalId
                : record.kind === "block"
                  ? record.blockId
                  : undefined
            if (decisionId) {
                if (
                    this.decisionOwners.has(decisionId) ||
                    this.pendingReplans.has(decisionId) ||
                    this.pendingBlocks.has(decisionId) ||
                    this.resolvedDecisionWrites.has(decisionId)
                ) {
                    this.writeJson(response, 409, {
                        error: "decision id is already in use",
                    })
                    return
                }
                this.decisionOwners.set(decisionId, capability.leaseId)
            }
            const processed = this.processRecord(
                record,
                capability.storyId,
                capability,
            )
            const hasDeliveryGap = processed.deliveryGaps.length > 0
            const receipt = {
                ok: !hasDeliveryGap,
                status: hasDeliveryGap ? "delivery_gap" : "queued",
                kind: record.kind,
                ...(record.eventId ? { eventId: record.eventId } : {}),
                ...(record.proposalId
                    ? { proposalId: record.proposalId }
                    : {}),
                ...(record.blockId ? { blockId: record.blockId } : {}),
                ...(record.challengeId
                    ? { challengeId: record.challengeId }
                    : {}),
                ...(record.invariantId
                    ? { invariantId: record.invariantId }
                    : {}),
                ...(hasDeliveryGap
                    ? {
                          deliveryGaps: processed.deliveryGaps,
                          warning:
                              "one or more bounded recipient mailboxes rejected this event; recipients receive a structured gap marker",
                      }
                    : {}),
            }
            const status = hasDeliveryGap ? 429 : 202
            if (eventId && processedEvents && fingerprint) {
                processedEvents.set(eventId, {
                    fingerprint,
                    status,
                    receipt: Object.freeze({ ...receipt }),
                })
                this.processedEventsByLease.set(
                    capability.leaseId,
                    processedEvents,
                )
            }
            this.writeJson(response, status, receipt)
            return
        }

        this.writeJson(response, 404, { error: "unknown broker route" })
    }

    private authenticateBrokerRequest(
        request: IncomingMessage,
    ): BrokerCapability | null {
        const header = request.headers.authorization
        if (typeof header !== "string" || !header.startsWith("Bearer ")) {
            return null
        }
        const token = header.slice("Bearer ".length)
        const capability = this.capabilitiesByToken.get(token)
        if (!capability || this.runCompleted) return null
        const active = this.activeLeases.get(capability.leaseId)
        if (
            !active ||
            active.storyId !== capability.storyId ||
            active.generation !== capability.generation ||
            active.deliveryMode !== capability.deliveryMode ||
            this.activeLeaseByStory.get(capability.storyId) !== capability.leaseId ||
            this.capabilityTokenByLease.get(capability.leaseId) !== token
        ) return null
        return capability
    }

    private waitForBrokerDecision(
        proposalId: string,
        leaseId: string,
        waitMs: number,
    ): Promise<Readonly<Record<string, unknown>> | "revoked" | null> {
        const existing = this.brokerDecisions.get(proposalId)
        if (existing) return Promise.resolve(existing)
        return new Promise((resolve) => {
            const waiter: DecisionWaiter = { leaseId, resolve }
            const waiters = this.decisionWaiters.get(proposalId) ?? new Set()
            waiters.add(waiter)
            this.decisionWaiters.set(proposalId, waiters)
            const timer = setTimeout(() => {
                waiters.delete(waiter)
                if (waiters.size === 0) this.decisionWaiters.delete(proposalId)
                resolve(null)
            }, waitMs)
            const originalResolve = waiter.resolve
            waiter.resolve = (result) => {
                clearTimeout(timer)
                originalResolve(result)
            }
        })
    }

    private resolveDecisionWaiters(
        proposalId: string,
        result: Readonly<Record<string, unknown>> | "revoked",
    ): void {
        const waiters = this.decisionWaiters.get(proposalId)
        if (!waiters) return
        this.decisionWaiters.delete(proposalId)
        for (const waiter of waiters) waiter.resolve(result)
    }

    private revokeCapability(leaseId: string): void {
        const token = this.capabilityTokenByLease.get(leaseId)
        if (token) this.capabilitiesByToken.delete(token)
        this.capabilityTokenByLease.delete(leaseId)
        this.brokerInboxes.delete(leaseId)
        this.brokerInboxGaps.delete(leaseId)
        this.processedEventsByLease.delete(leaseId)
        for (const [proposalId, ownerLeaseId] of this.decisionOwners) {
            if (ownerLeaseId !== leaseId) continue
            this.resolveDecisionWaiters(proposalId, "revoked")
            this.decisionOwners.delete(proposalId)
            this.brokerDecisions.delete(proposalId)
        }
    }

    private revokeAllCapabilities(): void {
        for (const leaseId of [...this.capabilityTokenByLease.keys()]) {
            this.revokeCapability(leaseId)
        }
        for (const [proposalId, waiters] of this.decisionWaiters) {
            this.decisionWaiters.delete(proposalId)
            for (const waiter of waiters) waiter.resolve("revoked")
        }
    }

    private async closeBrokerServer(): Promise<void> {
        const server = this.brokerServer
        this.brokerServer = null
        this.brokerEndpoint = null
        if (!server || !server.listening) return
        await new Promise<void>((resolve) => {
            let settled = false
            let backstop: ReturnType<typeof setTimeout> | null = null
            const finish = () => {
                if (settled) return
                settled = true
                if (backstop) clearTimeout(backstop)
                resolve()
            }
            server.close(finish)
            server.closeIdleConnections?.()
            backstop = setTimeout(() => {
                server.closeAllConnections?.()
                finish()
            }, 2_000)
            backstop.unref()
        })
    }

    private writeJson(
        response: ServerResponse,
        status: number,
        value: unknown,
    ): void {
        if (response.destroyed || response.writableEnded) return
        const body = JSON.stringify(value)
        response.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(body),
        })
        response.end(body)
    }
}

function isLoopbackAddress(value: string | undefined): boolean {
    return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
}

function deliveryGapText(rejectedCount: number): string {
    return (
        `[COLLABORATION DELIVERY GAP] ${rejectedCount} message(s) were ` +
        "rejected by the bounded pre-launch mailbox. Reconcile with peers " +
        "before relying on complete collaboration context."
    )
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
}

function boundedHttpWaitMs(raw: string | null): number | null {
    if (raw === null) return 30_000
    if (!/^\d+$/.test(raw)) return null
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= 1 && value <= 300_000
        ? value
        : null
}

async function readBoundedJsonBody(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers["content-type"]
    if (
        typeof contentType !== "string" ||
        !contentType.toLowerCase().startsWith("application/json")
    ) {
        throw new Error("content-type must be application/json")
    }
    const declaredLength = Number(request.headers["content-length"] ?? 0)
    if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_HTTP_BODY_BYTES
    ) {
        throw new Error(`event exceeds ${MAX_HTTP_BODY_BYTES} bytes`)
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > MAX_HTTP_BODY_BYTES) {
            throw new Error(`event exceeds ${MAX_HTTP_BODY_BYTES} bytes`)
        }
        chunks.push(buffer)
    }
    if (size === 0) throw new Error("request body is required")
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
        throw new Error("request body must be valid JSON")
    }
}

function parseBrokerRecord(value: unknown): OutboxRecord | string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return "event must be a JSON object"
    }
    const record = value as Record<string, unknown>
    const kind = record.kind
    if (typeof kind !== "string") return "event kind is required"
    const exactKeys = (...allowed: string[]) =>
        hasOnlyKeys(record, ["kind", ...allowed])
    const trimmedText = typeof record.text === "string" ? record.text.trim() : ""
    const eventId = validProposalId(record.eventId) ? record.eventId : null

    if (kind === "message") {
        if (!exactKeys("eventId", "text", "to")) return "message has unsupported fields"
        if (!eventId) return "message event id is invalid"
        if (!trimmedText || record.text!.toString().length > 8_000) {
            return "message text must contain 1-8000 characters"
        }
        if (
            typeof record.to !== "string" ||
            !record.to.trim() ||
            record.to !== record.to.trim() ||
            record.to.length > 128
        ) return "message recipient must be a trimmed story id"
        return { kind, eventId, text: record.text as string, to: record.to }
    }
    if (kind === "help" || kind === "note") {
        if (!exactKeys("eventId", "text")) return `${kind} has unsupported fields`
        if (!eventId) return `${kind} event id is invalid`
        if (!trimmedText || (record.text as string).length > 8_000) {
            return `${kind} text must contain 1-8000 characters`
        }
        return { kind, eventId, text: record.text as string }
    }
    if (kind === "discover") {
        if (!exactKeys("eventId", "story", "reason")) return "discover has unsupported fields"
        if (!eventId) return "discover event id is invalid"
        if (!validStory(record.story)) return "discover story is invalid"
        if (
            record.reason !== undefined &&
            (typeof record.reason !== "string" || record.reason.length > 8_000)
        ) return "discover reason is invalid"
        return {
            kind,
            eventId,
            story: record.story,
            ...(typeof record.reason === "string"
                ? { reason: record.reason }
                : {}),
        }
    }
    if (kind === "challenge") {
        if (!exactKeys("challengeId", "invariantId", "reason")) {
            return "challenge has unsupported fields"
        }
        if (!validProposalId(record.challengeId)) return "challenge id is invalid"
        if (!validGoalInvariantId(record.invariantId)) {
            return "challenge invariant id is invalid"
        }
        if (!validReason(record.reason)) return "challenge reason is invalid"
        return {
            kind,
            challengeId: record.challengeId,
            invariantId: record.invariantId,
            reason: record.reason,
        }
    }
    if (kind === "replan") {
        if (
            !exactKeys(
                "proposalId",
                "baseGraphVersion",
                "mutation",
                "reason",
            )
        ) return "replan has unsupported fields"
        if (!validProposalId(record.proposalId)) return "replan proposal id is invalid"
        if (!isPositiveInteger(record.baseGraphVersion)) {
            return "replan base graph version is invalid"
        }
        if (!validReplanMutation(record.mutation)) return "replan mutation is invalid"
        if (
            record.reason !== undefined &&
            (typeof record.reason !== "string" || record.reason.length > 8_000)
        ) return "replan reason is invalid"
        return {
            kind,
            proposalId: record.proposalId,
            baseGraphVersion: record.baseGraphVersion,
            mutation: record.mutation,
            ...(typeof record.reason === "string"
                ? { reason: record.reason }
                : {}),
        }
    }
    if (kind === "block") {
        if (!exactKeys("blockId", "requiredStoryIds", "reason")) {
            return "block has unsupported fields"
        }
        if (!validProposalId(record.blockId)) return "block id is invalid"
        if (!validRequiredStoryIds(record.requiredStoryIds)) {
            return "block prerequisites are invalid"
        }
        if (
            record.reason !== undefined &&
            (typeof record.reason !== "string" || record.reason.length > 8_000)
        ) return "block reason is invalid"
        return {
            kind,
            blockId: record.blockId,
            requiredStoryIds: record.requiredStoryIds,
            ...(typeof record.reason === "string"
                ? { reason: record.reason }
                : {}),
        }
    }
    return `unsupported kind '${kind}'`
}

function parseDeliveryAcknowledgement(value: unknown): string[] | string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return "inbox acknowledgement must be a JSON object"
    }
    const record = value as Record<string, unknown>
    if (!hasOnlyKeys(record, ["deliveryIds"])) {
        return "inbox acknowledgement has unsupported fields"
    }
    if (
        !Array.isArray(record.deliveryIds) ||
        record.deliveryIds.length === 0 ||
        record.deliveryIds.length > MAX_BROKER_INBOX_MESSAGES + 1 ||
        !record.deliveryIds.every(
            (value) =>
                typeof value === "string" &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                    value,
                ),
        ) ||
        new Set(record.deliveryIds).size !== record.deliveryIds.length
    ) {
        return "inbox acknowledgement deliveryIds are invalid"
    }
    return record.deliveryIds
}

function validStory(value: unknown): value is DiscoveredWork {
    if (!value || typeof value !== "object") return false
    const story = value as Partial<DiscoveredWork>
    return (
        typeof story.id === "string" &&
        typeof story.title === "string" &&
        typeof story.description === "string" &&
        stringArray(story.dependsOn) &&
        stringArray(story.acceptance) &&
        stringArray(story.tests) &&
        (story.model === undefined || typeof story.model === "string") &&
        (story.priority === undefined || typeof story.priority === "number") &&
        (story.retries === undefined || typeof story.retries === "number")
        &&
        (story.goalInvariantIds === undefined ||
            validGoalInvariantIds(story.goalInvariantIds))
    )
}

function validReplanMutation(value: unknown): value is RuntimeReplanMutation {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const mutation = value as Partial<RuntimeReplanMutation>
    return (
        hasOnlyKeys(mutation as Record<string, unknown>, [
            "addedStories",
            "removedStoryIds",
            "modifiedDeps",
        ]) &&
        Array.isArray(mutation.addedStories) &&
        mutation.addedStories.every(validReplanStory) &&
        stringArray(mutation.removedStoryIds) &&
        recordOfStringArrays(mutation.modifiedDeps)
    )
}

function validReplanStory(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const story = value as Record<string, unknown>
    return (
        hasOnlyKeys(story, [
            "id",
            "priority",
            "title",
            "description",
            "dependsOn",
            "retries",
            "acceptance",
            "tests",
            "model",
            "goalInvariantIds",
        ]) &&
        typeof story.id === "string" &&
        typeof story.priority === "number" &&
        Number.isFinite(story.priority) &&
        typeof story.title === "string" &&
        typeof story.description === "string" &&
        stringArray(story.dependsOn) &&
        (story.retries === undefined ||
            (typeof story.retries === "number" && Number.isFinite(story.retries))) &&
        (story.acceptance === undefined || stringArray(story.acceptance)) &&
        (story.tests === undefined || stringArray(story.tests)) &&
        (story.model === undefined || typeof story.model === "string") &&
        (story.goalInvariantIds === undefined ||
            validGoalInvariantIds(story.goalInvariantIds))
    )
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const keys = new Set(allowed)
    return Object.keys(value).every((key) => keys.has(key))
}

function recordOfStringArrays(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    return Object.values(value).every(stringArray)
}

function validProposalId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 200 &&
        /^[a-zA-Z0-9._-]+$/.test(value)
    )
}

function validGoalInvariantId(value: unknown): value is string {
    return typeof value === "string" && /^G-[AC][1-9]\d*$/.test(value)
}

function validGoalInvariantIds(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.every(validGoalInvariantId) &&
        new Set(value).size === value.length
    )
}

function validReason(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 8_000
    )
}

function validRaisedBy(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 8_000
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0
}

function positiveIntegerOrNull(value: unknown): number | null {
    return isPositiveInteger(value) ? value : null
}

function sameCorrelation(
    expected: PendingReplanCorrelation,
    actual: PendingReplanCorrelation,
): boolean {
    return (
        actual.runId === expected.runId &&
        actual.proposalId === expected.proposalId &&
        actual.sourceStoryId === expected.sourceStoryId &&
        actual.leaseId === expected.leaseId &&
        actual.generation === expected.generation &&
        actual.baseGraphVersion === expected.baseGraphVersion
    )
}

function sameChallenge(
    expected: GoalInvariantChallengeRaisedData,
    actual: GoalInvariantChallengeRaisedData,
): boolean {
    return (
        actual.runId === expected.runId &&
        actual.challengeId === expected.challengeId &&
        actual.invariantId === expected.invariantId &&
        actual.raisedBy === expected.raisedBy &&
        actual.reason === expected.reason &&
        actual.storyId === expected.storyId
    )
}

function sameBlockCorrelation(
    expected: PendingBlockCorrelation,
    actual: WorkBlockedData | {
        runId: string
        blockId: string
        storyId: string
        leaseId: string
        generation: number
        requiredStoryIds: readonly string[]
        requestReason: string
    },
): boolean {
    const actualReason = "requestReason" in actual
        ? actual.requestReason
        : actual.reason
    return (
        actual.runId === expected.runId &&
        actual.blockId === expected.blockId &&
        actual.storyId === expected.storyId &&
        actual.leaseId === expected.leaseId &&
        actual.generation === expected.generation &&
        actualReason === expected.reason &&
        actual.requiredStoryIds.length === expected.requiredStoryIds.length &&
        actual.requiredStoryIds.every(
            (storyId, index) => storyId === expected.requiredStoryIds[index],
        )
    )
}

function validRequiredStoryIds(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 32 &&
        value.every(
            (item) =>
                typeof item === "string" &&
                item.length > 0 &&
                item.length <= 128 &&
                item.trim() === item,
        ) &&
        new Set(value).size === value.length
    )
}

function stringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function encodeInflightAgentId(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url")
}

function decodeInflightAgentId(name: string): string | null {
    const separator = name.indexOf(".")
    if (separator <= 0) return null
    const encoded = name.slice(0, separator)
    try {
        const value = Buffer.from(encoded, "base64url").toString("utf8")
        if (!value || encodeInflightAgentId(value) !== encoded) return null
        return value
    } catch {
        return null
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? value as Record<string, unknown>
        : { value }
}
