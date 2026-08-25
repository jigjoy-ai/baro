import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { nativeStreamingEnabled } from "../../../src/harness/openai/runtime.js"

describe("nativeStreamingEnabled", () => {
    it("opt-out rule: unset default path is enabled, \"0\" opt-out path is disabled, \"1\" is enabled", () => {
        const previous = process.env.BARO_NATIVE_STREAM
        try {
            delete process.env.BARO_NATIVE_STREAM
            assert.equal(nativeStreamingEnabled(), true)

            process.env.BARO_NATIVE_STREAM = "0"
            assert.equal(nativeStreamingEnabled(), false)

            process.env.BARO_NATIVE_STREAM = "1"
            assert.equal(nativeStreamingEnabled(), true)
        } finally {
            if (previous === undefined) {
                delete process.env.BARO_NATIVE_STREAM
            } else {
                process.env.BARO_NATIVE_STREAM = previous
            }
        }
    })
})
