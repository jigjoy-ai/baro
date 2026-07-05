import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { testVerdict } from "../../../src/participants/forwarders/test-verdict.js"

// Real runner outputs grouped by expected verdict; adding a format is one line.

const GREEN: Array<[string, string]> = [
    ["node:test summary", "ℹ tests 144\nℹ pass 144\nℹ fail 0"],
    [
        "cargo test summary",
        "test result: ok. 144 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    ],
    ["jest-style zero failed", "Tests: 0 failed, 12 passed, 12 total"],
    ["rspec zero failures", "12 examples, 0 failures"],
    ["pytest", "===== 12 passed in 0.53s ====="],
    ["mocha passing", "  12 passing (340ms)"],
    ["plain english", "All 5 tests passed"],
    ["tests ok", "12 tests ok"],
]

const RED: Array<[string, string]> = [
    ["count-first failed", "2 failed, 3 passed"],
    ["node:test failures", "ℹ tests 144\nℹ pass 141\nℹ fail 3"],
    ["cargo failures", "test result: FAILED. 1 failed; 143 passed; 0 ignored"],
    ["mocha failing", "10 passing (2s)\n2 failing"],
    ["go test FAIL", "--- FAIL: TestParse (0.00s)\nFAIL\nexit status 1"],
    ["jest suite FAIL line", "FAIL src/app.test.ts\n● Test suite failed to run"],
]

const NO_VERDICT: Array<[string, string]> = [
    ["not a test run", "installed 12 packages in 3s"],
    ["plain output", "done"],
    ["go package lines only", "ok  example.com/pkg  0.2s"],
    ["all skipped", "0 passed"],
]

describe("testVerdict", () => {
    for (const [name, out] of GREEN) {
        it(`green: ${name}`, () => assert.equal(testVerdict(out), true))
    }
    for (const [name, out] of RED) {
        it(`red: ${name}`, () => assert.equal(testVerdict(out), false))
    }
    for (const [name, out] of NO_VERDICT) {
        it(`no verdict: ${name}`, () => assert.equal(testVerdict(out), null))
    }
})
