import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    frontDoorBillingPhase,
    trustedFrontDoorBillingRunId,
} from "../../src/session/frontdoor-billing.js"

describe("front-door billing context", () => {
    it("uses trusted session correlation instead of ambient run identity", () => {
        const previous = process.env.BARO_RUN_ID
        process.env.BARO_RUN_ID = "ambient-collective-run"
        try {
            assert.equal(
                trustedFrontDoorBillingRunId("session-pre-prd"),
                "session-pre-prd",
            )
        } finally {
            if (previous === undefined) delete process.env.BARO_RUN_ID
            else process.env.BARO_RUN_ID = previous
        }
    })

    it("attributes Conversation and RepoScout using existing wire phases", () => {
        assert.equal(frontDoorBillingPhase("conversation"), "dialogue")
        assert.equal(frontDoorBillingPhase("repository_scout"), "intake")
        assert.equal(frontDoorBillingPhase(undefined), "dialogue")
    })
})
