import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { validateConversationResponse } from "../../src/session/conversation-contract.js"
import {
    SessionLifecycle,
    SessionLifecycleError,
} from "../../src/session/session-lifecycle.js"

describe("SessionLifecycle", () => {
    it("keeps phase caller-owned and source-correlates one complete run", () => {
        const lifecycle = new SessionLifecycle("session-1")
        const clarify = response("request-1", "clarify")
        lifecycle.acceptConversationResponse(clarify, "request-1")
        assert.equal(lifecycle.phase, "clarifying")

        const ready = response("request-2", "ready")
        lifecycle.acceptConversationResponse(ready, "request-2")
        assert.equal(lifecycle.phase, "ready")
        assert.equal(lifecycle.snapshot().goalRevision, 1)

        lifecycle.startRun("run-1")
        lifecycle.advanceRun("run-1", "reviewing", "plan is ready for review")
        lifecycle.advanceRun("run-1", "executing", "plan accepted")
        lifecycle.advanceRun("run-1", "verifying", "implementation integrated")
        lifecycle.advanceRun("run-1", "completed", "verification passed")

        assert.equal(lifecycle.phase, "completed")
        assert.deepEqual(
            lifecycle.phaseChanges().map((change) => change.to),
            ["ready", "planning", "reviewing", "executing", "verifying", "completed"],
        )
    })

    it("rejects stale run events and impossible phase skips", () => {
        const lifecycle = new SessionLifecycle("session-1")
        lifecycle.acceptConversationResponse(response("request-1", "ready"), "request-1")
        lifecycle.startRun("run-current")

        assert.throws(
            () => lifecycle.advanceRun("run-stale", "executing", "forged"),
            /stale or foreign run/,
        )
        assert.throws(
            () => lifecycle.advanceRun("run-current", "completed", "skip verification"),
            /cannot advance run/,
        )
    })

    it("starts a follow-up as a new goal revision without reviving the old run", () => {
        const lifecycle = new SessionLifecycle("session-1")
        lifecycle.acceptConversationResponse(response("request-1", "ready"), "request-1")
        lifecycle.startRun("run-1")
        lifecycle.advanceRun("run-1", "executing", "headless plan accepted")
        lifecycle.advanceRun("run-1", "verifying", "work integrated")
        lifecycle.advanceRun("run-1", "completed", "verified")

        lifecycle.beginFollowUp()
        assert.equal(lifecycle.phase, "clarifying")
        assert.equal(lifecycle.snapshot().runId, null)
        lifecycle.acceptConversationResponse(response("request-2", "ready"), "request-2")
        assert.equal(lifecycle.snapshot().goalRevision, 2)
        assert.throws(
            () => lifecycle.advanceRun("run-1", "executing", "late old event"),
            SessionLifecycleError,
        )
    })
})

function response(requestId: string, kind: "ready" | "clarify") {
    return validateConversationResponse(
        kind === "ready"
            ? {
                  schemaVersion: 1,
                  sessionId: "session-1",
                  requestId,
                  kind,
                  message: "Clear; ready for planning.",
                  questions: [],
                  goalEnvelope: {
                      objective: "Implement session-first intake.",
                      constraints: [],
                      acceptanceCriteria: ["The session uses strict correlation."],
                      nonGoals: [],
                      assumptions: [],
                  },
              }
            : {
                  schemaVersion: 1,
                  sessionId: "session-1",
                  requestId,
                  kind,
                  message: "One material detail is unclear.",
                  questions: [{ id: "q1", text: "Must compatibility remain?" }],
                  goalEnvelope: null,
              },
        { sessionId: "session-1", requestId },
    )
}
