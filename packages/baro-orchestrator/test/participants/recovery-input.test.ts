import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { recoveryInput } from "../../src/participants/recovery-input.js"
import { StoryResult } from "../../src/semantic-events.js"

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
})
