import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { envFlag } from "../../src/runtime/env-flag.js"

describe("envFlag", () => {
    it("opt-out rule: unset/missing and any non-\"0\" value are enabled; only the literal \"0\" is disabled", () => {
        const previous = process.env.BARO_ENV_FLAG_TEST
        try {
            delete process.env.BARO_ENV_FLAG_TEST
            assert.equal(envFlag("BARO_ENV_FLAG_TEST"), true)

            process.env.BARO_ENV_FLAG_TEST = "0"
            assert.equal(envFlag("BARO_ENV_FLAG_TEST"), false)

            process.env.BARO_ENV_FLAG_TEST = "1"
            assert.equal(envFlag("BARO_ENV_FLAG_TEST"), true)

            process.env.BARO_ENV_FLAG_TEST = "false"
            assert.equal(envFlag("BARO_ENV_FLAG_TEST"), true)

            process.env.BARO_ENV_FLAG_TEST = "true"
            assert.equal(envFlag("BARO_ENV_FLAG_TEST"), true)

            process.env.BARO_ENV_FLAG_TEST = ""
            assert.equal(envFlag("BARO_ENV_FLAG_TEST"), true)
        } finally {
            if (previous === undefined) {
                delete process.env.BARO_ENV_FLAG_TEST
            } else {
                process.env.BARO_ENV_FLAG_TEST = previous
            }
        }
    })
})
