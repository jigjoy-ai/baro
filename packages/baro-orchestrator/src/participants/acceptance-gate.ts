import type { Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    Critique,
    RunCompleted,
    StoryQualityCompleted,
    StoryQualityTimedOut,
    StoryResult,
    WorkLeaseGranted,
    type CritiqueData,
    type StoryQualityCompletedData,
} from "../semantic-events.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"
import { criticInput, type CriticInput } from "./critic-input.js"
import {
    isAuthorizedTerminalTurn,
    type TerminalTurnAuthorityOptions,
} from "./terminal-turn-authority.js"

/** Outlives the slowest bounded Critic default (180s) plus delivery grace. */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 240_000

export interface AcceptanceGateOptions extends TerminalTurnAuthorityOptions {
    runId: string
    /** Same target map used by Critic; empty/missing criteria need no verdict. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Bound for a missing terminal turn or matching Critique. Default: 240s. */
    timeoutMs?: number
    /** Optional object-identity authority for lease events. */
    leaseAuthority?: Participant
    /** Optional object-identity authority for Critique events. */
    critiqueAuthority?: Participant
}

interface Correlation {
    evaluationId: string
    storyId: string
    leaseId: string
    generation: number
}

interface PendingEvaluation extends Correlation {
    targetTurn: number | null
    timer: ReturnType<typeof setTimeout> | null
}

interface LeaseWindow {
    leaseId: string
    generation: number
    startTurn: number
}

/**
 * Collective-only acceptance gate. It never evaluates quality itself: it
 * correlates a successful leased StoryResult with Critic's verdict for the
 * story's terminal turn, and fails closed when that evidence never arrives.
 */
export class AcceptanceGate extends SerializedObserver {
    private readonly timeoutMs: number
    private readonly targets: ReadonlyMap<string, readonly string[]>
    private readonly turnCount = new Map<string, number>()
    private readonly latestTerminalTurn = new Map<string, number>()
    private readonly seenTerminalEvents = new Set<string>()
    private readonly critiques = new Map<string, Map<number, CritiqueData>>()
    private readonly activeLeases = new Map<string, LeaseWindow>()
    private readonly acceptedCorrelation = new Map<
        string,
        { leaseId: string; generation: number }
    >()
    private readonly pending = new Map<string, PendingEvaluation>()
    private readonly settledEvaluationIds = new Set<string>()
    private completionAuthority: Participant | null = null

    constructor(private readonly opts: AcceptanceGateOptions) {
        super()
        const timeoutMs = opts.timeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new RangeError("acceptance gate timeoutMs must be finite and non-negative")
        }
        this.timeoutMs = timeoutMs
        this.targets = opts.targets
    }

    setCompletionAuthority(authority: Participant): void {
        this.completionAuthority = authority
    }

    protected override handleEvent(context: SerializedEventContext): void {
        const { event } = context

        if (WorkLeaseGranted.is(event)) {
            if (
                this.opts.leaseAuthority &&
                context.source !== this.opts.leaseAuthority
            ) return
            this.onLease(event.data)
            return
        }

        const input = criticInput(event)
        if (input) {
            if (!isAuthorizedTerminalTurn(
                context.source,
                event,
                input,
                this.opts,
            )) return
            this.onTerminalTurn(event, input)
            return
        }

        if (Critique.is(event)) {
            if (
                this.opts.critiqueAuthority &&
                context.source !== this.opts.critiqueAuthority
            ) return
            this.onCritique(event.data)
            return
        }

        if (StoryResult.is(event)) {
            if (
                this.opts.outcomeAuthority &&
                !this.opts.outcomeAuthority.matchesResult(
                    context.source,
                    event.data,
                )
            ) return
            this.onStoryResult(event.data)
            return
        }

        if (StoryQualityTimedOut.is(event) && context.internal) {
            this.onTimedOut(event.data)
            return
        }

        if (RunCompleted.is(event)) {
            if (
                this.completionAuthority &&
                context.source !== this.completionAuthority
            ) return
            if (event.data.runId && event.data.runId !== this.opts.runId) return
            this.stop()
        }
    }

    protected override onManagedFailure(failure: SerializedObserverFailure): void {
        process.stderr.write(`[acceptance-gate] ${failure.error.message}\n`)
    }

    private onLease(data: {
        runId: string
        leaseId: string
        generation: number
        request: { storyId: string }
    }): void {
        if (data.runId !== this.opts.runId) return
        const storyId = data.request.storyId
        const current = this.activeLeases.get(storyId)
        if (
            current &&
            (data.generation < current.generation ||
                (data.generation === current.generation &&
                    data.leaseId !== current.leaseId))
        ) return
        if (current?.leaseId === data.leaseId) return

        const pending = this.pending.get(storyId)
        if (pending && data.generation > pending.generation) {
            this.cancelPending(pending)
        }
        this.activeLeases.set(storyId, {
            leaseId: data.leaseId,
            generation: data.generation,
            startTurn: this.turnCount.get(storyId) ?? 0,
        })
    }

    private onTerminalTurn(
        event: SemanticEvent<unknown>,
        input: CriticInput,
    ): void {
        const { agentId, isError, resultText } = input
        // Match Critic's turn accounting exactly: only watched, actionable
        // terminal outputs advance the turn number.
        if (!this.hasAcceptanceCriteria(agentId) || isError || !resultText) return

        const lease = this.activeLeases.get(agentId)
        const terminalIdentity = terminalFingerprint(event, input)
        if (terminalIdentity !== null) {
            const fingerprint = JSON.stringify([
                lease?.leaseId ?? null,
                lease?.generation ?? null,
                terminalIdentity,
            ])
            if (this.seenTerminalEvents.has(fingerprint)) return
            this.seenTerminalEvents.add(fingerprint)
        }

        const turn = (this.turnCount.get(agentId) ?? 0) + 1
        this.turnCount.set(agentId, turn)
        this.latestTerminalTurn.set(agentId, turn)

        const pending = this.pending.get(agentId)
        if (!pending || pending.targetTurn !== null) return
        const activeLease = this.activeLeases.get(agentId)
        if (
            activeLease &&
            (activeLease.leaseId !== pending.leaseId ||
                activeLease.generation !== pending.generation ||
                turn <= activeLease.startTurn)
        ) return

        pending.targetTurn = turn
        this.tryResolve(pending)
    }

    private onCritique(data: CritiqueData): void {
        if (!this.hasAcceptanceCriteria(data.agentId) || data.turn <= 0) return
        let byTurn = this.critiques.get(data.agentId)
        if (!byTurn) {
            byTurn = new Map()
            this.critiques.set(data.agentId, byTurn)
        }
        if (!byTurn.has(data.turn)) {
            byTurn.set(data.turn, snapshotCritique(data))
        }

        const pending = this.pending.get(data.agentId)
        if (pending?.targetTurn === data.turn) this.tryResolve(pending)
    }

    private onStoryResult(data: {
        storyId: string
        success: boolean
        runId?: string
        leaseId?: string
        generation?: number
    }): void {
        if (
            !data.success ||
            data.runId !== this.opts.runId ||
            !data.leaseId ||
            !Number.isInteger(data.generation) ||
            data.generation! < 0
        ) return

        const generation = data.generation!
        const active = this.activeLeases.get(data.storyId)
        if (
            active &&
            (active.leaseId !== data.leaseId || active.generation !== generation)
        ) return

        const previous = this.acceptedCorrelation.get(data.storyId)
        if (
            previous &&
            (generation < previous.generation ||
                (generation === previous.generation &&
                    data.leaseId !== previous.leaseId))
        ) return

        const correlation: Correlation = {
            storyId: data.storyId,
            leaseId: data.leaseId,
            generation,
            evaluationId: evaluationId(
                this.opts.runId,
                data.storyId,
                data.leaseId,
                generation,
            ),
        }
        if (
            this.settledEvaluationIds.has(correlation.evaluationId) ||
            this.pending.get(data.storyId)?.evaluationId === correlation.evaluationId
        ) return

        const oldPending = this.pending.get(data.storyId)
        if (oldPending) this.cancelPending(oldPending)
        this.acceptedCorrelation.set(data.storyId, {
            leaseId: data.leaseId,
            generation,
        })

        if (!this.hasAcceptanceCriteria(data.storyId)) {
            this.complete({
                runId: this.opts.runId,
                ...correlation,
                status: "passed",
                targetTurn: null,
                reason: "no acceptance criteria configured",
            })
            return
        }

        const pending: PendingEvaluation = {
            ...correlation,
            targetTurn: this.terminalTurnFor(correlation),
            timer: null,
        }
        this.pending.set(data.storyId, pending)
        if (!this.tryResolve(pending)) this.armTimeout(pending)
    }

    private terminalTurnFor(correlation: Correlation): number | null {
        const turn = this.latestTerminalTurn.get(correlation.storyId)
        if (turn === undefined) return null
        const lease = this.activeLeases.get(correlation.storyId)
        if (
            lease &&
            lease.leaseId === correlation.leaseId &&
            lease.generation === correlation.generation &&
            turn <= lease.startTurn
        ) return null
        return turn
    }

    private hasAcceptanceCriteria(storyId: string): boolean {
        return (this.targets.get(storyId)?.length ?? 0) > 0
    }

    private tryResolve(pending: PendingEvaluation): boolean {
        if (pending.targetTurn === null) return false
        const critique = this.critiques
            .get(pending.storyId)
            ?.get(pending.targetTurn)
        if (!critique) return false

        this.complete({
            runId: this.opts.runId,
            evaluationId: pending.evaluationId,
            storyId: pending.storyId,
            leaseId: pending.leaseId,
            generation: pending.generation,
            status: critique.verdict === "pass" ? "passed" : "failed",
            targetTurn: pending.targetTurn,
            reason: critique.reasoning || `critic verdict: ${critique.verdict}`,
            critique: {
                verdict: critique.verdict,
                reasoning: critique.reasoning,
                violatedCriteria: [...critique.violatedCriteria],
                turn: critique.turn,
                modelUsed: critique.modelUsed,
            },
        })
        return true
    }

    private armTimeout(pending: PendingEvaluation): void {
        pending.timer = setTimeout(() => {
            const current = this.pending.get(pending.storyId)
            if (!current || current.evaluationId !== pending.evaluationId) return
            this.publish(
                StoryQualityTimedOut.create({
                    runId: this.opts.runId,
                    evaluationId: current.evaluationId,
                    storyId: current.storyId,
                    leaseId: current.leaseId,
                    generation: current.generation,
                    targetTurn: current.targetTurn,
                    timeoutMs: this.timeoutMs,
                }),
            )
        }, this.timeoutMs)
    }

    private onTimedOut(data: {
        runId: string
        evaluationId: string
        storyId: string
        leaseId: string
        generation: number
        timeoutMs: number
    }): void {
        if (data.runId !== this.opts.runId || data.timeoutMs !== this.timeoutMs) return
        const pending = this.pending.get(data.storyId)
        if (
            !pending ||
            pending.evaluationId !== data.evaluationId ||
            pending.leaseId !== data.leaseId ||
            pending.generation !== data.generation
        ) return

        const reason = pending.targetTurn === null
            ? `no terminal agent turn arrived within ${this.timeoutMs}ms`
            : `no critique for terminal turn ${pending.targetTurn} arrived within ${this.timeoutMs}ms`
        this.complete({
            runId: this.opts.runId,
            evaluationId: pending.evaluationId,
            storyId: pending.storyId,
            leaseId: pending.leaseId,
            generation: pending.generation,
            status: "failed",
            targetTurn: pending.targetTurn,
            reason,
        })
    }

    private complete(data: StoryQualityCompletedData): void {
        if (this.settledEvaluationIds.has(data.evaluationId)) return
        const pending = this.pending.get(data.storyId)
        if (pending?.evaluationId === data.evaluationId) {
            if (pending.timer) clearTimeout(pending.timer)
            this.pending.delete(data.storyId)
        }
        this.settledEvaluationIds.add(data.evaluationId)
        this.publish(StoryQualityCompleted.create(data))
    }

    private cancelPending(pending: PendingEvaluation): void {
        if (pending.timer) clearTimeout(pending.timer)
        if (this.pending.get(pending.storyId)?.evaluationId === pending.evaluationId) {
            this.pending.delete(pending.storyId)
        }
    }

    private stop(): void {
        for (const pending of this.pending.values()) {
            if (pending.timer) clearTimeout(pending.timer)
        }
        this.pending.clear()
        this.activeLeases.clear()
    }
}

function evaluationId(
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
): string {
    return [runId, "quality", storyId, generation, leaseId]
        .map(encodeURIComponent)
        .join(":")
}

function snapshotCritique(data: CritiqueData): CritiqueData {
    return {
        ...data,
        violatedCriteria: [...data.violatedCriteria],
    }
}

function terminalFingerprint(
    event: SemanticEvent<unknown>,
    input: CriticInput,
): string | null {
    return input.terminalId
        ? JSON.stringify([event.type, input.agentId, input.terminalId])
        : null
}
