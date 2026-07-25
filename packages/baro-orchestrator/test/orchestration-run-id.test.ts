import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveOrchestrationRunId } from "../src/orchestrate.js"

describe("orchestration run identity", () => {
    it("keeps the server-issued identity across the execution runtime", () => {
        assert.equal(
            resolveOrchestrationRunId(undefined, "run-local-abcdefghijklmnopqrstuvwxyz"),
            "run-local-abcdefghijklmnopqrstuvwxyz",
        )
        assert.equal(
            resolveOrchestrationRunId("run-explicit", "run-inherited"),
            "run-explicit",
        )
    })

    it("falls back only when no shared identity exists and rejects unsafe input", () => {
        assert.equal(resolveOrchestrationRunId(undefined, undefined, () => "run-fallback"), "run-fallback")
        assert.throws(
            () => resolveOrchestrationRunId(undefined, "run/unsafe"),
            /safe 1-128 character identifier/,
        )
        assert.throws(
            () => resolveOrchestrationRunId("x".repeat(129), undefined),
            /safe 1-128 character identifier/,
        )
    })
})
