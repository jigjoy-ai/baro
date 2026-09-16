import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createFakeAwakeClock } from "../../src/runtime/awake-clock.js"
import type { SemanticEvent } from "../../src/runtime/mozaik.js"
import type { PrdFile } from "../../src/prd.js"
import {
    GoalCompletionCheckTimedOut,
    VerificationGoalGate,
    type VerificationGoalGateHost,
} from "../../src/verification/verification-goal-gate.js"
import {
    GoalCompletionCheckRequested,
    RunVerificationRequested,
    RunVerificationTimedOut,
    type RunVerificationCompletedData,
} from "../../src/semantic-events.js"

const VERIFICATION_TIMEOUT_MS = 30 * 60_000
const GOAL_COMPLETION_TIMEOUT_MS = 30_000
const SUSPENSION_MS = 4 * 60 * 60_000

function createHost(prd: PrdFile | null = null): {
    host: VerificationGoalGateHost
    events: SemanticEvent<unknown>[]
    pushes: (string | null)[]
} {
    const events: SemanticEvent<unknown>[] = []
    const pushes: (string | null)[] = []
    let phase = "running"
    return {
        events,
        pushes,
        host: {
            emit: (event) => {
                events.push(event)
            },
            phase: () => phase,
            enterVerifying: () => {
                phase = "verifying"
            },
            requestPush: (reason) => {
                pushes.push(reason)
            },
            prd: () => prd,
            persistGoalProtocol: () => {},
            waveOrdinal: () => 1,
        },
    }
}

function goalPrd(): PrdFile {
    return {
        project: "Awake gate",
        branchName: "baro/awake-gate",
        description: "test",
        goalEnvelope: {
            objective: "Budgets must not count time the machine spent asleep.",
            constraints: [],
            acceptanceCriteria: ["A suspend never trips a watchdog."],
            nonGoals: [],
            assumptions: [],
        },
        userStories: [],
    }
}

function passingVerification(verificationId: string): RunVerificationCompletedData {
    return {
        runId: "run-awake-gate",
        verificationId,
        status: "passed",
        commands: [{
            command: "npm test",
            status: "passed",
            durationMs: 1,
        }],
        durationMs: 1,
    }
}

function pendingVerificationId(events: readonly SemanticEvent<unknown>[]): string {
    const requested = events.find(RunVerificationRequested.is)
    assert.ok(requested)
    return requested.data.verificationId
}

describe("VerificationGoalGate awake watchdogs", () => {
    it("defers the verification watchdog across a multi-hour suspension and fires it at the original awake elapsed", () => {
        const clock = createFakeAwakeClock()
        const { host, events } = createHost()
        const gate = new VerificationGoalGate({
            runId: "run-awake-gate",
            verifyBeforePush: true,
            verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
            hasGoalCompletionAuthority: false,
            host,
            awakeClock: clock,
        })

        gate.requestVerification(null)
        const verificationId = pendingVerificationId(events)

        clock.suspend(SUSPENSION_MS)
        assert.equal(events.filter(RunVerificationTimedOut.is).length, 0)

        clock.advance(VERIFICATION_TIMEOUT_MS - 1)
        assert.equal(events.filter(RunVerificationTimedOut.is).length, 0)

        clock.advance(1)
        const timedOut = events.filter(RunVerificationTimedOut.is)
        assert.equal(timedOut.length, 1)
        assert.deepEqual(timedOut[0]!.data, {
            runId: "run-awake-gate",
            verificationId,
            timeoutMs: VERIFICATION_TIMEOUT_MS,
        })
    })

    it("still trips the verification watchdog at the same awake elapsed without any suspension", () => {
        const clock = createFakeAwakeClock()
        const { host, events } = createHost()
        const gate = new VerificationGoalGate({
            runId: "run-awake-gate",
            verifyBeforePush: true,
            verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
            hasGoalCompletionAuthority: false,
            host,
            awakeClock: clock,
        })

        gate.requestVerification(null)
        clock.advance(VERIFICATION_TIMEOUT_MS - 1)
        assert.equal(events.filter(RunVerificationTimedOut.is).length, 0)

        clock.advance(1)
        assert.equal(events.filter(RunVerificationTimedOut.is).length, 1)
        assert.equal(clock.absorbedGapMs(), 0)
    })

    it("cancels the verification watchdog once verification completes", () => {
        const clock = createFakeAwakeClock()
        const { host, events } = createHost()
        const gate = new VerificationGoalGate({
            runId: "run-awake-gate",
            verifyBeforePush: true,
            verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
            hasGoalCompletionAuthority: false,
            host,
            awakeClock: clock,
        })

        gate.requestVerification(null)
        gate.onVerificationCompleted(
            passingVerification(pendingVerificationId(events)),
        )

        clock.suspend(SUSPENSION_MS)
        clock.advance(VERIFICATION_TIMEOUT_MS * 2)
        assert.equal(events.filter(RunVerificationTimedOut.is).length, 0)
        assert.deepEqual(clock.pendingDelays(), [])
        assert.equal(gate.status(), "passed")
    })

    it("defers the goal-completion watchdog across a suspension and releasePendings cancels it", () => {
        const clock = createFakeAwakeClock()
        const { host, events } = createHost(goalPrd())
        const gate = new VerificationGoalGate({
            runId: "run-awake-gate",
            verifyBeforePush: true,
            verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
            goalCompletionTimeoutMs: GOAL_COMPLETION_TIMEOUT_MS,
            hasGoalCompletionAuthority: true,
            host,
            awakeClock: clock,
        })

        gate.requestVerification(null)
        gate.onVerificationCompleted(
            passingVerification(pendingVerificationId(events)),
        )
        assert.equal(events.filter(GoalCompletionCheckRequested.is).length, 1)

        clock.suspend(SUSPENSION_MS)
        assert.equal(events.filter(GoalCompletionCheckTimedOut.is).length, 0)

        clock.advance(GOAL_COMPLETION_TIMEOUT_MS - 1)
        assert.equal(events.filter(GoalCompletionCheckTimedOut.is).length, 0)

        gate.releasePendings()
        clock.advance(GOAL_COMPLETION_TIMEOUT_MS * 2)
        assert.equal(events.filter(GoalCompletionCheckTimedOut.is).length, 0)
        assert.deepEqual(clock.pendingDelays(), [])
    })

    it("fires the goal-completion watchdog at the original awake elapsed after a suspension", () => {
        const clock = createFakeAwakeClock()
        const { host, events } = createHost(goalPrd())
        const gate = new VerificationGoalGate({
            runId: "run-awake-gate",
            verifyBeforePush: true,
            verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
            goalCompletionTimeoutMs: GOAL_COMPLETION_TIMEOUT_MS,
            hasGoalCompletionAuthority: true,
            host,
            awakeClock: clock,
        })

        gate.requestVerification(null)
        gate.onVerificationCompleted(
            passingVerification(pendingVerificationId(events)),
        )
        const requested = events.find(GoalCompletionCheckRequested.is)!

        clock.suspend(SUSPENSION_MS)
        clock.advance(GOAL_COMPLETION_TIMEOUT_MS - 1)
        assert.equal(events.filter(GoalCompletionCheckTimedOut.is).length, 0)

        clock.advance(1)
        const timedOut = events.filter(GoalCompletionCheckTimedOut.is)
        assert.equal(timedOut.length, 1)
        assert.deepEqual(timedOut[0]!.data, {
            runId: "run-awake-gate",
            checkId: requested.data.checkId,
            contractId: requested.data.contractId,
            verificationId: requested.data.verificationId,
            timeoutMs: GOAL_COMPLETION_TIMEOUT_MS,
        })
    })
})
