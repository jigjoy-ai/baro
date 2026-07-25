import {
    assertCorrelationId,
    goalEnvelopeFingerprint,
    validateConversationResponse,
    type ConversationResponse,
    type GoalEnvelope,
} from "./conversation-contract.js"

export type SessionPhase =
    | "clarifying"
    | "ready"
    | "planning"
    | "reviewing"
    | "executing"
    | "verifying"
    | "completed"
    | "failed"
    | "closed"

export interface SessionPhaseChange {
    sessionId: string
    sequence: number
    from: SessionPhase
    to: SessionPhase
    requestId: string | null
    runId: string | null
    reason: string
}

export interface SessionLifecycleSnapshot {
    sessionId: string
    phase: SessionPhase
    goalRevision: number
    requestId: string | null
    runId: string | null
    goalEnvelope: GoalEnvelope | null
    goalFingerprint: string | null
}

export class SessionLifecycleError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SessionLifecycleError"
    }
}

/**
 * Caller-owned phase authority. Model output can supply a validated goal, but
 * cannot name, skip, or advance lifecycle phases.
 */
export class SessionLifecycle {
    private phaseValue: SessionPhase = "clarifying"
    private sequence = 0
    private revision = 0
    private requestId: string | null = null
    private runId: string | null = null
    private goal: GoalEnvelope | null = null
    private fingerprint: string | null = null
    private readonly changes: SessionPhaseChange[] = []

    constructor(readonly sessionId: string) {
        assertCorrelationId(sessionId, "sessionId")
    }

    get phase(): SessionPhase {
        return this.phaseValue
    }

    /**
     * Consume a correlated response. Clarify/answer never move phase; ready
     * only records the goal and moves CLARIFYING→READY.
     */
    acceptConversationResponse(
        value: unknown,
        expectedRequestId: string,
    ): ConversationResponse {
        const response = validateConversationResponse(value, {
            sessionId: this.sessionId,
            requestId: expectedRequestId,
        })
        if (response.kind !== "ready") return response
        if (this.phaseValue !== "clarifying") {
            throw new SessionLifecycleError(
                `cannot accept a ready goal while session is ${this.phaseValue}`,
            )
        }
        this.goal = response.goalEnvelope
        this.fingerprint = goalEnvelopeFingerprint(response.goalEnvelope!)
        this.requestId = response.requestId
        this.revision += 1
        this.transition("ready", "conversation produced a validated goal")
        return response
    }

    startRun(runId: string): void {
        assertCorrelationId(runId, "runId")
        if (this.phaseValue !== "ready" || this.goal === null) {
            throw new SessionLifecycleError("a run can start only from ready")
        }
        this.runId = runId
        this.transition("planning", "caller started an isolated run")
    }

    advanceRun(
        runId: string,
        next: "reviewing" | "executing" | "verifying" | "completed",
        reason: string,
    ): void {
        this.assertActiveRun(runId)
        const allowed: Readonly<Record<typeof next, readonly SessionPhase[]>> = {
            reviewing: ["planning"],
            executing: ["planning", "reviewing"],
            verifying: ["executing"],
            completed: ["verifying"],
        }
        if (!allowed[next].includes(this.phaseValue)) {
            throw new SessionLifecycleError(
                `cannot advance run from ${this.phaseValue} to ${next}`,
            )
        }
        this.transition(next, boundedReason(reason))
    }

    fail(reason: string, runId?: string): void {
        if (this.phaseValue === "closed") {
            throw new SessionLifecycleError("closed session cannot fail")
        }
        if (runId !== undefined) this.assertActiveRun(runId)
        this.transition("failed", boundedReason(reason))
    }

    beginFollowUp(reason = "user started a follow-up"): void {
        if (this.phaseValue !== "completed" && this.phaseValue !== "failed") {
            throw new SessionLifecycleError(
                "follow-up can begin only after a completed or failed run",
            )
        }
        this.runId = null
        this.requestId = null
        this.goal = null
        this.fingerprint = null
        this.transition("clarifying", boundedReason(reason))
    }

    close(reason = "session closed"): void {
        if (this.phaseValue === "closed") return
        this.transition("closed", boundedReason(reason))
        this.runId = null
    }

    snapshot(): SessionLifecycleSnapshot {
        return Object.freeze({
            sessionId: this.sessionId,
            phase: this.phaseValue,
            goalRevision: this.revision,
            requestId: this.requestId,
            runId: this.runId,
            goalEnvelope: this.goal,
            goalFingerprint: this.fingerprint,
        })
    }

    phaseChanges(): readonly SessionPhaseChange[] {
        return Object.freeze(this.changes.map((change) => Object.freeze({ ...change })))
    }

    private assertActiveRun(runId: string): void {
        assertCorrelationId(runId, "runId")
        if (this.runId === null || runId !== this.runId) {
            throw new SessionLifecycleError("stale or foreign run correlation")
        }
    }

    private transition(to: SessionPhase, reason: string): void {
        const from = this.phaseValue
        this.phaseValue = to
        this.sequence += 1
        this.changes.push(Object.freeze({
            sessionId: this.sessionId,
            sequence: this.sequence,
            from,
            to,
            requestId: this.requestId,
            runId: this.runId,
            reason,
        }))
    }
}

function boundedReason(value: string): string {
    if (typeof value !== "string") throw new SessionLifecycleError("phase reason must be text")
    const reason = value.trim()
    if (reason.length === 0 || reason.length > 2_000) {
        throw new SessionLifecycleError("phase reason is empty or too long")
    }
    return reason
}
