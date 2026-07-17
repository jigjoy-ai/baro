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
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Participant } from "@mozaik-ai/core"

import {
    AgentTargetedMessage,
    CollaborationNote,
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
    type RuntimeReplanMutation,
    type WorkBlockedData,
} from "../semantic-events.js"
import { snapshotRuntimeReplanMutation } from "../runtime-replan.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"

export interface CollaborationBridgeOptions {
    runId: string
    sessionDir: string
    pollMs?: number
    /** Explicit test-only bypass for object-identity authority binding. */
    unsafeAllowUnboundAuthorities?: boolean
}

interface OutboxRecord {
    leaseId?: string
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
}

interface ActiveLeaseCorrelation {
    storyId: string
    leaseId: string
    generation: number
    launchGraphVersion: number | null
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

export class CollaborationBridge extends SerializedObserver {
    private readonly outboxDir: string
    private readonly inboxDir: string
    private readonly decisionsDir: string
    /** Retained after release so a final note written just before exit keeps attribution. */
    private readonly agentsByLease = new Map<string, string>()
    /** Exact live execution capability; never retained after release/replacement. */
    private readonly activeLeases = new Map<string, ActiveLeaseCorrelation>()
    private readonly activeLeaseByStory = new Map<string, string>()
    private readonly activeAgents = new Set<string>()
    private readonly pendingInbox = new Map<string, unknown[]>()
    private readonly pendingReplans = new Map<string, PendingReplanCorrelation>()
    private readonly pendingBlocks = new Map<string, PendingBlockCorrelation>()
    private readonly resolvedDecisionWrites = new Map<
        string,
        Readonly<Record<string, unknown>>
    >()
    private runCompleted = false
    private timer: ReturnType<typeof setInterval> | null = null
    private polling = false
    private leaseAuthority: Participant | null = null
    private decisionAuthority: Participant | null = null

    constructor(private readonly opts: CollaborationBridgeOptions) {
        super()
        this.outboxDir = join(opts.sessionDir, "outbox")
        this.inboxDir = join(opts.sessionDir, "inbox")
        this.decisionsDir = join(opts.sessionDir, "decisions")
        mkdirSync(this.outboxDir, { recursive: true })
        mkdirSync(this.inboxDir, { recursive: true })
        mkdirSync(this.decisionsDir, { recursive: true })
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

    override onJoined(): void {
        if (this.timer) return
        this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 150)
        this.timer.unref()
    }

    override onLeft(): void {
        this.stop()
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
                previous &&
                (event.data.generation < previous.generation ||
                    (event.data.generation === previous.generation &&
                        event.data.leaseId !== previous.leaseId))
            ) return
            if (previousLeaseId && previousLeaseId !== event.data.leaseId) {
                this.activeLeases.delete(previousLeaseId)
            }
            this.agentsByLease.set(event.data.leaseId, agentId)
            this.activeLeases.set(event.data.leaseId, {
                storyId: agentId,
                leaseId: event.data.leaseId,
                generation: event.data.generation,
                launchGraphVersion: positiveIntegerOrNull(
                    event.data.request.graphVersion,
                ),
            })
            this.activeLeaseByStory.set(agentId, event.data.leaseId)
            this.activeAgents.add(agentId)
            this.flushPendingInbox(agentId)
            return
        }
        if (WorkLeaseReleased.is(event) && event.data.runId === this.opts.runId) {
            if (
                context.source !== this.leaseAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            // Keep the validated lease attribution until the run ends. The
            // worker writes collaboration records to disk and the bridge
            // polls them asynchronously, so deleting the mapping here can
            // race a final note/message written immediately before exit.
            // `activeAgents` still reflects live peers; this retained mapping
            // is used only to attribute already-authorized outbox records.
            const active = this.activeLeases.get(event.data.leaseId)
            if (active?.storyId === event.data.storyId) {
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
        if (AgentTargetedMessage.is(event)) {
            this.deliverOrQueueInbox(event.data.recipientId, {
                type: event.type,
                data: event.data,
            })
            return
        }
        if (PeerHelpRequested.is(event) && event.data.runId === this.opts.runId) {
            for (const agentId of this.activeAgents) {
                if (agentId === event.data.sourceAgentId) continue
                context.publish(
                    AgentTargetedMessage.create({
                        recipientId: agentId,
                        text: `${event.data.sourceAgentId} asks for help: ${event.data.text}`,
                        metadata: {
                            kind: "peer_help",
                            sourceAgentId: event.data.sourceAgentId,
                        },
                    }),
                )
            }
            return
        }
        if (RunCompleted.is(event) && event.data.runId === this.opts.runId) {
            if (
                context.source !== this.decisionAuthority &&
                this.opts.unsafeAllowUnboundAuthorities !== true
            ) return
            this.agentsByLease.clear()
            this.activeLeases.clear()
            this.activeLeaseByStory.clear()
            this.activeAgents.clear()
            this.pendingInbox.clear()
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
            if (this.resolvedDecisionWrites.size === 0) this.stop()
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
                    if (this.resolvedDecisionWrites.size === 0) this.stop()
                    return
                }
                if (!existsSync(this.outboxDir)) {
                    this.stop()
                    return
                }
                const files = readdirSync(this.outboxDir)
                    .filter((name) => name.endsWith(".json"))
                    .sort()
                for (const name of files) this.consume(join(this.outboxDir, name))
            } finally {
                this.polling = false
            }
        })
    }

    private consume(path: string): void {
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
            const text = typeof record.text === "string" ? record.text.trim() : ""

            if (record.kind === "message" && text && record.to) {
                this.publish(
                    AgentTargetedMessage.create({
                        recipientId: record.to,
                        text,
                        metadata: { kind: "peer_message", sourceAgentId: agentId },
                    }),
                )
            } else if (record.kind === "help" && text) {
                this.publish(
                    PeerHelpRequested.create({
                        runId: this.opts.runId,
                        sourceAgentId: agentId,
                        text,
                    }),
                )
            } else if (record.kind === "note" && text) {
                this.publish(
                    CollaborationNote.create({
                        runId: this.opts.runId,
                        sourceAgentId: agentId,
                        text,
                    }),
                )
            } else if (record.kind === "discover" && validStory(record.story)) {
                const activeLease = record.leaseId
                    ? this.activeLeases.get(record.leaseId)
                    : undefined
                if (activeLease?.storyId === agentId) {
                    this.publish(
                        WorkDiscovered.create({
                            runId: this.opts.runId,
                            sourceAgentId: agentId,
                            leaseId: activeLease.leaseId,
                            generation: activeLease.generation,
                            reason: record.reason?.trim() || "worker discovered required follow-up work",
                            story: record.story,
                        }),
                    )
                }
            } else if (record.kind === "replan") {
                this.publishRuntimeReplan(record, agentId)
            } else if (record.kind === "block") {
                this.publishWorkBlocked(record, agentId)
            }
        } catch (error) {
            process.stderr.write(
                `[collaboration-bridge] ignored invalid outbox record: ${(error as Error)?.message ?? String(error)}\n`,
            )
        } finally {
            try {
                unlinkSync(path)
            } catch {}
        }
    }

    private deliverOrQueueInbox(agentId: string, value: unknown): void {
        if (this.activeAgents.has(agentId)) {
            this.writeInbox(agentId, value)
            return
        }
        const pending = this.pendingInbox.get(agentId) ?? []
        pending.push(value)
        if (pending.length > MAX_PENDING_MESSAGES_PER_AGENT) {
            pending.splice(0, pending.length - MAX_PENDING_MESSAGES_PER_AGENT)
        }
        this.pendingInbox.set(agentId, pending)
    }

    private flushPendingInbox(agentId: string): void {
        const pending = this.pendingInbox.get(agentId)
        if (!pending) return
        this.pendingInbox.delete(agentId)
        for (const value of pending) this.writeInbox(agentId, value)
    }

    private writeInbox(agentId: string, value: unknown): void {
        appendFileSync(
            join(this.inboxDir, `${safeName(agentId)}.jsonl`),
            JSON.stringify({ ts: new Date().toISOString(), ...asRecord(value) }) + "\n",
        )
    }

    private stop(): void {
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
        this.resolvedDecisionWrites.delete(proposalId)
        this.pendingReplans.delete(proposalId)
        this.pendingBlocks.delete(proposalId)
        if (this.runCompleted && this.resolvedDecisionWrites.size === 0) {
            this.stop()
        }
    }

    private writeDecision(
        proposalId: string,
        decision: Readonly<Record<string, unknown>>,
    ): void {
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
        (story.model === undefined || typeof story.model === "string")
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

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? value as Record<string, unknown>
        : { value }
}
