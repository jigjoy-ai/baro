import {
    BaseObserver,
    type ModelMessageItem,
    type Participant,
    type SemanticEvent,
} from "../runtime/mozaik.js"

import {
    AgentResult,
    AgentTurnCompleted,
    CodexTurnEvent,
    OneShotAttemptFinalized,
    OpenCodeSystem,
    PiTurnEvent,
    StoryQualityReverificationRequested,
    StoryRouted,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../semantic-events.js"
import type {
    StoryOutcomeAuthority,
    StoryResultAuthorityCorrelation,
} from "../runtime/story-outcome-authority.js"
import { criticInput, criticReplayKey } from "./critic-input.js"

export interface AgentTurnProjectorOptions {
    /** Collective-only exact authority for native CLI event producers. */
    outcomeAuthority?: StoryOutcomeAuthority
    /** Hold one-shot terminals until their story owner proves process settlement. */
    requireQuiescenceBarrier?: boolean
}

interface LeaseCorrelation {
    runId: string
    leaseId: string
    generation: number
    /** True only when the grant came from the exact bound lease authority. */
    authoritative: boolean
}

interface CachedCandidate {
    turn: number
    terminalId: string | null
    backend: string
    resultText: string
    lease: LeaseCorrelation | null
}

interface PendingProjectedTerminal {
    backend: string
    isError: boolean
    resultText: string
    /** Exact nested CLI which emitted this candidate. */
    source: Participant | null
    correlation: StoryResultAuthorityCorrelation | null
    attempt: number | null
}

/** Projects one-shot CLI message streams into the Critic's neutral terminal contract. */
export class AgentTurnProjector extends BaseObserver {
    private readonly text = new Map<string, string[]>()
    private readonly backends = new Map<string, string>()
    private readonly completed = new Set<string>()
    private readonly terminalSequences = new Map<string, number>()
    /** Critic/Gate turn count: unlike provider terminal ids, errors and empty
     * outputs do not advance it. */
    private readonly candidateTurns = new Map<string, number>()
    private readonly candidates = new Map<string, Map<number, CachedCandidate>>()
    private readonly activeLeases = new Map<string, LeaseCorrelation>()
    private readonly seenNativeTerminalIds = new Set<string>()
    private readonly handledReverifications = new Set<string>()
    private readonly nativeSources = new Map<string, Participant>()
    private readonly pendingProjectedTerminals = new Map<
        string,
        PendingProjectedTerminal
    >()
    private readonly lastFinalizedAttempts = new Map<string, number>()
    private leaseAuthority: Participant | null = null
    private reverificationAuthority: Participant | null = null

    constructor(private readonly opts: AgentTurnProjectorOptions = {}) {
        super()
        if (opts.requireQuiescenceBarrier && !opts.outcomeAuthority) {
            throw new Error(
                "terminal projector quiescence barrier requires outcome authority",
            )
        }
    }

    setLeaseAuthority(authority: Participant): void {
        if (this.leaseAuthority && this.leaseAuthority !== authority) {
            throw new Error("terminal projector lease authority is already bound")
        }
        this.leaseAuthority = authority
    }

    /** Bind the exact AcceptanceGate allowed to request a same-candidate replay. */
    setReverificationAuthority(authority: Participant): void {
        if (
            this.reverificationAuthority &&
            this.reverificationAuthority !== authority
        ) {
            throw new Error(
                "terminal projector reverification authority is already bound",
            )
        }
        this.reverificationAuthority = authority
    }

    /**
     * Resolve billing correlation for one terminal emitted by this projector.
     *
     * The terminal id is only a lookup key into the projector's retained
     * candidate ledger.  Lease fields are never copied from the replay event;
     * they originate in an exact-identity WorkLeaseGranted authority and are
     * snapshotted with the candidate before the terminal is emitted.
     */
    terminalCorrelationFor(
        agentId: string,
        terminalId: string | null,
    ): StoryResultAuthorityCorrelation | null {
        if (!agentId || !terminalId) return null
        const candidates = this.candidates.get(agentId)
        if (!candidates) return null
        for (const candidate of candidates.values()) {
            if (candidate.terminalId !== terminalId) continue
            const lease = candidate.lease
            if (!lease?.authoritative) return null
            return {
                runId: lease.runId,
                storyId: agentId,
                leaseId: lease.leaseId,
                generation: lease.generation,
            }
        }
        return null
    }

    override async onExternalModelMessage(
        source: Participant,
        item: ModelMessageItem,
    ): Promise<void> {
        const agentId = agentIdOf(source)
        if (!agentId) return
        if (!this.acceptsNativeSource(source, agentId)) return
        this.selectNativeSource(source, agentId)
        // A new assistant message is positive evidence that a new turn/attempt
        // started after any previously projected terminal event.
        this.completed.delete(agentId)
        const json = item.toJSON() as { content?: Array<{ text?: string }> }
        const parts = (json.content ?? [])
            .map((part) => part.text ?? "")
            .filter((part) => part.length > 0)
        if (parts.length === 0) return
        const existing = this.text.get(agentId) ?? []
        existing.push(...parts)
        // Bound audit/prompt memory while retaining the latest assistant output.
        const joined = existing.join("\n")
        this.text.set(agentId, [joined.slice(-100_000)])
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (WorkLeaseGranted.is(event)) {
            if (!this.acceptsLeaseSource(source)) return
            if (
                this.opts.outcomeAuthority &&
                event.data.runId !== this.opts.outcomeAuthority.runId
            ) return
            this.activeLeases.set(event.data.request.storyId, {
                runId: event.data.runId,
                leaseId: event.data.leaseId,
                generation: event.data.generation,
                authoritative:
                    this.leaseAuthority !== null &&
                    source === this.leaseAuthority,
            })
            this.pendingProjectedTerminals.delete(event.data.request.storyId)
            return
        }
        if (WorkLeaseReleased.is(event)) {
            if (!this.acceptsLeaseSource(source)) return
            const active = this.activeLeases.get(event.data.storyId)
            if (
                active?.runId === event.data.runId &&
                active.leaseId === event.data.leaseId
            ) {
                this.activeLeases.delete(event.data.storyId)
                this.pendingProjectedTerminals.delete(event.data.storyId)
            }
            return
        }
        if (StoryQualityReverificationRequested.is(event)) {
            this.reverify(source, event.data)
            return
        }
        if (OneShotAttemptFinalized.is(event)) {
            this.finalizeOneShotAttempt(source, event.data)
            return
        }
        if (StoryRouted.is(event)) {
            if (this.opts.outcomeAuthority) {
                const active = this.activeLeases.get(event.data.storyId)
                if (
                    !active ||
                    event.data.runId !== active.runId ||
                    event.data.leaseId !== active.leaseId ||
                    event.data.generation !== active.generation ||
                    !this.opts.outcomeAuthority.matchesSpawnAuthority(source, {
                        runId: active.runId,
                        storyId: event.data.storyId,
                        leaseId: active.leaseId,
                    })
                ) return
            }
            this.backends.set(event.data.storyId, event.data.backend)
            return
        }
        if (AgentResult.is(event)) {
            this.rememberNativeCandidate(source, event)
            return
        }
        if (CodexTurnEvent.is(event)) {
            if (!this.acceptsNativeSource(source, event.data.agentId)) return
            this.selectNativeSource(source, event.data.agentId)
            if (event.data.phase === "started") this.completed.delete(event.data.agentId)
            else if (event.data.phase === "completed") this.complete(event.data.agentId, "codex", false)
            else if (event.data.phase === "failed") this.complete(event.data.agentId, "codex", true)
            return
        }
        if (OpenCodeSystem.is(event)) {
            if (!this.acceptsNativeSource(source, event.data.agentId)) return
            this.selectNativeSource(source, event.data.agentId)
            if (event.data.subtype === "step_start") this.completed.delete(event.data.agentId)
            else if (event.data.subtype === "step_finish") {
                this.complete(event.data.agentId, "opencode", false)
            }
            return
        }
        if (PiTurnEvent.is(event)) {
            if (!this.acceptsNativeSource(source, event.data.agentId)) return
            this.selectNativeSource(source, event.data.agentId)
            if (event.data.turnType === "message_start") {
                this.completed.delete(event.data.agentId)
            } else if (event.data.turnType === "message_end") {
                const raw = event.data.raw as Record<string, unknown>
                const message = raw.message as Record<string, unknown> | undefined
                if (message?.role === "assistant") this.complete(event.data.agentId, "pi", false)
            }
        }
    }

    private acceptsNativeSource(source: Participant, agentId: string): boolean {
        return this.opts.outcomeAuthority === undefined ||
            this.opts.outcomeAuthority.matchesTerminalTurnSource(source, agentId)
    }

    private acceptsLeaseSource(source: Participant): boolean {
        return this.opts.outcomeAuthority
            ? this.leaseAuthority !== null && source === this.leaseAuthority
            : this.leaseAuthority === null || source === this.leaseAuthority
    }

    private rememberNativeCandidate(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        const input = criticInput(event)
        if (!input || input.isError || !input.resultText) return
        if (!this.acceptsNativeSource(source, input.agentId)) return
        const key = criticReplayKey(input.agentId, input.terminalId)
        if (key) {
            if (this.seenNativeTerminalIds.has(key)) return
            this.seenNativeTerminalIds.add(key)
        }
        this.retainCandidate({
            agentId: input.agentId,
            terminalId: input.terminalId,
            backend: this.backends.get(input.agentId) ?? "native",
            resultText: input.resultText,
        })
    }

    private selectNativeSource(source: Participant, agentId: string): void {
        // Legacy adapters historically reconstruct lightweight source objects
        // around the same agentId. Exact identity is meaningful only when the
        // collective registry is present.
        if (!this.opts.outcomeAuthority) return
        const current = this.nativeSources.get(agentId)
        if (current && current !== source) {
            this.text.delete(agentId)
            this.completed.delete(agentId)
            this.pendingProjectedTerminals.delete(agentId)
        }
        this.nativeSources.set(agentId, source)
    }

    private complete(agentId: string, fallbackBackend: string, isError: boolean): void {
        if (this.completed.has(agentId)) return
        this.completed.add(agentId)
        const resultText = (this.text.get(agentId) ?? []).join("\n").trim()
        this.text.delete(agentId)
        const backend = this.backends.get(agentId) ?? fallbackBackend
        if (this.opts.requireQuiescenceBarrier) {
            const nativeSource = this.nativeSources.get(agentId)
            const correlation =
                nativeSource && this.opts.outcomeAuthority
                    ? this.opts.outcomeAuthority.terminalCorrelationForSource(
                          nativeSource,
                          agentId,
                      )
                    : null
            this.pendingProjectedTerminals.set(agentId, {
                backend,
                isError,
                resultText,
                source: nativeSource ?? null,
                correlation,
                attempt:
                    correlation === null
                        ? null
                        : (this.lastFinalizedAttempts.get(
                              correlationKey(correlation),
                          ) ?? 0) + 1,
            })
            return
        }
        this.publishProjectedTerminal(agentId, backend, isError, resultText)
    }

    private finalizeOneShotAttempt(
        source: Participant,
        finalized: {
            runId: string
            storyId: string
            leaseId: string
            generation: number
            attempt: number
            disposition: "publish" | "discard"
            ownedProcessGroup: boolean
            quiescenceAssurance: "cooperative-observed" | "none"
        },
    ): void {
        if (!this.opts.requireQuiescenceBarrier || !this.opts.outcomeAuthority) {
            return
        }
        const correlation = {
            runId: finalized.runId,
            storyId: finalized.storyId,
            leaseId: finalized.leaseId,
            generation: finalized.generation,
        }
        const active = this.activeLeases.get(finalized.storyId)
        if (
            !active?.authoritative ||
            active.runId !== finalized.runId ||
            active.leaseId !== finalized.leaseId ||
            active.generation !== finalized.generation ||
            !this.opts.outcomeAuthority.matchesResultAuthority(
                source,
                correlation,
            )
        ) return

        const finalizedKey = correlationKey(correlation)
        const expectedAttempt =
            (this.lastFinalizedAttempts.get(finalizedKey) ?? 0) + 1
        if (
            !Number.isInteger(finalized.attempt) ||
            finalized.attempt !== expectedAttempt
        ) return
        this.lastFinalizedAttempts.set(finalizedKey, finalized.attempt)

        const pending = this.pendingProjectedTerminals.get(finalized.storyId)
        this.pendingProjectedTerminals.delete(finalized.storyId)
        if (
            finalized.disposition !== "publish" ||
            finalized.quiescenceAssurance !== "cooperative-observed" ||
            !pending ||
            !sameCorrelation(pending.correlation, correlation) ||
            pending.attempt !== finalized.attempt ||
            pending.source === null ||
            !this.opts.outcomeAuthority.matchesNestedTerminalTurnSource(
                pending.source,
                correlation,
            )
        ) return
        const terminalId = [
            "quiesced",
            finalized.runId,
            finalized.storyId,
            finalized.leaseId,
            finalized.generation,
            finalized.attempt,
        ]
            .map(String)
            .map(encodeURIComponent)
            .join(":")
        this.publishProjectedTerminal(
            finalized.storyId,
            pending.backend,
            pending.isError,
            pending.resultText,
            terminalId,
        )
    }

    private publishProjectedTerminal(
        agentId: string,
        backend: string,
        isError: boolean,
        resultText: string,
        terminalIdOverride?: string,
    ): void {
        const sequence = (this.terminalSequences.get(agentId) ?? 0) + 1
        this.terminalSequences.set(agentId, sequence)
        const terminalId = terminalIdOverride ??
            ["projected", agentId, sequence]
                .map(String)
                .map(encodeURIComponent)
                .join(":")
        if (!isError && resultText) {
            this.retainCandidate({
                agentId,
                terminalId,
                backend,
                resultText,
            })
        }
        const event = AgentTurnCompleted.create({
            agentId,
            terminalId,
            backend,
            isError,
            resultText: resultText || null,
            canContinue: false,
        })
        this.emit(event)
    }

    private retainCandidate(candidate: {
        agentId: string
        terminalId: string | null
        backend: string
        resultText: string
    }): CachedCandidate {
        const turn = (this.candidateTurns.get(candidate.agentId) ?? 0) + 1
        this.candidateTurns.set(candidate.agentId, turn)
        const retained: CachedCandidate = {
            turn,
            terminalId: candidate.terminalId,
            backend: candidate.backend,
            resultText: candidate.resultText,
            lease: this.activeLeases.get(candidate.agentId) ?? null,
        }
        let byTurn = this.candidates.get(candidate.agentId)
        if (!byTurn) {
            byTurn = new Map()
            this.candidates.set(candidate.agentId, byTurn)
        }
        byTurn.set(turn, retained)
        // Reverification is bounded; retaining a small tail also prevents a
        // long native continuation from becoming unbounded projector state.
        while (byTurn.size > 8) {
            const oldest = byTurn.keys().next().value as number | undefined
            if (oldest === undefined) break
            byTurn.delete(oldest)
        }
        return retained
    }

    private reverify(
        source: Participant,
        request: {
            runId: string
            requestId: string
            storyId: string
            leaseId: string
            generation: number
            targetTurn: number
            terminalId?: string
            attempt: number
        },
    ): void {
        if (
            !this.reverificationAuthority ||
            source !== this.reverificationAuthority ||
            this.handledReverifications.has(request.requestId) ||
            !Number.isInteger(request.attempt) ||
            request.attempt <= 0
        ) return
        const active = this.activeLeases.get(request.storyId)
        const candidate = this.candidates
            .get(request.storyId)
            ?.get(request.targetTurn)
        if (
            !active ||
            active.runId !== request.runId ||
            active.leaseId !== request.leaseId ||
            active.generation !== request.generation ||
            !candidate ||
            !candidate.lease ||
            candidate.lease.runId !== request.runId ||
            candidate.lease.leaseId !== request.leaseId ||
            candidate.lease.generation !== request.generation ||
            (request.terminalId !== undefined &&
                candidate.terminalId !== request.terminalId)
        ) return

        this.handledReverifications.add(request.requestId)
        const sequence = (this.terminalSequences.get(request.storyId) ?? 0) + 1
        this.terminalSequences.set(request.storyId, sequence)
        const terminalId = [
            "reverification",
            request.storyId,
            request.requestId,
        ]
            .map(String)
            .map(encodeURIComponent)
            .join(":")
        this.retainCandidate({
            agentId: request.storyId,
            terminalId,
            backend: candidate.backend,
            resultText: candidate.resultText,
        })
        this.emit(
            AgentTurnCompleted.create({
                agentId: request.storyId,
                terminalId,
                backend: candidate.backend,
                isError: false,
                resultText: candidate.resultText,
                // A re-evaluation may reject the candidate, but it must never
                // target prose at the already-finished implementation worker.
                canContinue: false,
            }),
        )
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, event)
        }
    }
}

function agentIdOf(source: Participant): string | null {
    const id = (source as { agentId?: unknown }).agentId
    return typeof id === "string" && id ? id : null
}

function sameCorrelation(
    left: StoryResultAuthorityCorrelation | null,
    right: StoryResultAuthorityCorrelation,
): boolean {
    return left !== null &&
        left.runId === right.runId &&
        left.storyId === right.storyId &&
        left.leaseId === right.leaseId &&
        left.generation === right.generation
}

function correlationKey(
    correlation: StoryResultAuthorityCorrelation,
): string {
    return JSON.stringify([
        correlation.runId,
        correlation.storyId,
        correlation.leaseId,
        correlation.generation,
    ])
}
