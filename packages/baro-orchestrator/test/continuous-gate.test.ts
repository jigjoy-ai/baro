import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { continuousGateEnabled } from "../src/orchestrate.js"

describe("continuousGateEnabled", () => {
    it("opt-out rule: unset default path is enabled, \"0\" opt-out path is disabled, \"1\" is enabled", () => {
        const previous = process.env.BARO_CONTINUOUS_GATE
        try {
            delete process.env.BARO_CONTINUOUS_GATE
            assert.equal(continuousGateEnabled(), true)

            process.env.BARO_CONTINUOUS_GATE = "0"
            assert.equal(continuousGateEnabled(), false)

            process.env.BARO_CONTINUOUS_GATE = "1"
            assert.equal(continuousGateEnabled(), true)
        } finally {
            if (previous === undefined) {
                delete process.env.BARO_CONTINUOUS_GATE
            } else {
                process.env.BARO_CONTINUOUS_GATE = previous
            }
        }
    })
})
