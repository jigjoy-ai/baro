import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { validateConversationResponse } from "../../src/session/conversation-contract.js"
import {
    ProcessSessionHost,
    type ProcessIsolatedRun,
} from "../../src/session/process-session-host.js"

describe("ProcessSessionHost", () => {
    it("disposes every isolated run and keeps only session state across follow-ups", async () => {
        let created = 0
        const disposed: string[] = []
        const phases: string[] = []
        const host = new ProcessSessionHost({
            sessionId: "session-1",
            factory: {
                create() {
                    created += 1
                    const runId = `run-${created}`
                    return passingRun(runId, disposed)
                },
            },
            onPhaseChange: (change) => phases.push(`${change.runId}:${change.to}`),
        })

        const first = await host.runReadyResponse(ready("request-1"), "request-1")
        assert.deepEqual(first, { runId: "run-1", success: true })
        assert.equal(host.lifecycle.phase, "completed")
        assert.deepEqual(disposed, ["run-1"])

        host.beginFollowUp()
        const second = await host.runReadyResponse(ready("request-2"), "request-2")
        assert.deepEqual(second, { runId: "run-2", success: true })
        assert.deepEqual(disposed, ["run-1", "run-2"])
        assert.equal(host.lifecycle.snapshot().goalRevision, 2)
        assert.ok(phases.includes("run-1:executing"))
        assert.ok(phases.includes("run-2:verifying"))
    })

    it("disposes a failed child and does not misreport it as completed", async () => {
        let disposeCalls = 0
        const host = new ProcessSessionHost({
            sessionId: "session-1",
            factory: {
                create(): ProcessIsolatedRun {
                    return {
                        isolation: "process",
                        runId: "run-failed",
                        async execute({ reportPhase }) {
                            reportPhase("executing", "planning complete")
                            throw new Error("child exited")
                        },
                        dispose() {
                            disposeCalls += 1
                        },
                    }
                },
            },
        })

        const result = await host.runReadyResponse(ready("request-1"), "request-1")
        assert.equal(result.success, false)
        assert.equal(result.error, "child exited")
        assert.equal(disposeCalls, 1)
        assert.equal(host.lifecycle.phase, "failed")
    })

    it("rejects a repeated run identity across follow-ups", async () => {
        let disposeCalls = 0
        const host = new ProcessSessionHost({
            sessionId: "session-1",
            factory: {
                create() {
                    const run = passingRun("run-reused", [])
                    const originalDispose = run.dispose.bind(run)
                    run.dispose = async () => {
                        disposeCalls += 1
                        await originalDispose()
                    }
                    return run
                },
            },
        })
        await host.runReadyResponse(ready("request-1"), "request-1")
        host.beginFollowUp()
        const second = await host.runReadyResponse(ready("request-2"), "request-2")
        assert.equal(second.success, false)
        assert.match(second.error ?? "", /reused/)
        assert.equal(disposeCalls, 2)
    })
})

function passingRun(runId: string, disposed: string[]): ProcessIsolatedRun {
    return {
        isolation: "process",
        runId,
        async execute({ reportPhase }) {
            reportPhase("executing", "headless plan accepted")
            reportPhase("verifying", "implementation integrated")
            return { success: true }
        },
        dispose() {
            disposed.push(runId)
        },
    }
}

function ready(requestId: string) {
    return validateConversationResponse(
        {
            schemaVersion: 1,
            sessionId: "session-1",
            requestId,
            kind: "ready",
            message: "Clear; handing off to planning.",
            questions: [],
            goalEnvelope: {
                objective: "Implement the requested follow-up.",
                constraints: [],
                acceptanceCriteria: ["The isolated run verifies its result."],
                nonGoals: [],
                assumptions: [],
            },
        },
        { sessionId: "session-1", requestId },
    )
}
