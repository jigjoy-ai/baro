import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { recoveryInput } from "../../src/participants/recovery-input.js"
import { StoryQualityCompleted, StoryResult } from "../../src/semantic-events.js"

describe("recoveryInput", () => {
    it("keeps legacy execution failures eligible for Surgeon policy", () => {
        const event = StoryResult.create({
            storyId: "S1",
            success: false,
            attempts: 1,
            durationSecs: 1,
            error: "tests failed",
        })

        assert.equal(recoveryInput(event), event.data)
    })

    it("keeps provider capacity out of every Surgeon backend", () => {
        const event = StoryResult.create({
            storyId: "S1",
            success: false,
            attempts: 1,
            durationSecs: 1,
            error: "quota exhausted",
            failure: {
                kind: "provider_capacity",
                code: "quota_exhausted",
            },
        })

        assert.equal(recoveryInput(event), null)
    })

    it("keeps operational incidents and inconclusive quality out of Surgeon policy", () => {
        for (const kind of ["transport", "infrastructure", "verification"] as const) {
            const event = StoryResult.create({
                storyId: "S1",
                success: false,
                attempts: 1,
                durationSecs: 1,
                error: `${kind} incident`,
                failure: { kind },
            })
            assert.equal(recoveryInput(event), null, kind)
        }
        const quality = StoryQualityCompleted.create({
            runId: "run",
            evaluationId: "evaluation",
            storyId: "S1",
            leaseId: "lease",
            generation: 1,
            status: "inconclusive",
            targetTurn: 1,
            reason: "evaluator unavailable",
        })
        assert.equal(recoveryInput(quality), null)
    })

    it("keeps evaluated verification failures eligible for Surgeon policy", () => {
        for (const code of ["acceptance_not_met", "canonical_check_failed"] as const) {
            const event = StoryResult.create({
                storyId: "S1",
                success: false,
                attempts: 1,
                durationSecs: 1,
                error: code,
                failure: { kind: "verification", code },
            })
            assert.equal(recoveryInput(event), event.data, code)
        }
    })
})
