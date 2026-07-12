import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    freezeVerificationInputs,
    includeUnmeasuredAttempts,
    StoryAttemptCoverageTracker,
    verificationInputsFingerprint,
    verificationInputsMatch,
} from "../scripts/ab-evidence.js"

describe("A/B experiment evidence", () => {
    it("hashes explicit and literal absolute verifier files", () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-ab-evidence-"))
        try {
            const automatic = join(dir, "hidden oracle.mjs")
            const explicit = join(dir, "fixture.json")
            writeFileSync(automatic, "export default 1\n")
            writeFileSync(explicit, '{"ok":true}\n')

            const inputs = freezeVerificationInputs({
                explicitPaths: [explicit],
                verifyCommands: [`node '${automatic}'`, "node ./repo-local-test.mjs"],
                launchCwd: dir,
            })

            assert.equal(inputs.length, 2)
            assert.deepEqual(
                inputs.map((input) => input.discoveredFrom).sort(),
                ["explicit", "verify_command"],
            )
            assert.equal(inputs.every((input) => /^[a-f0-9]{64}$/.test(input.sha256)), true)
            assert.equal(verificationInputsMatch(inputs), true)
            assert.match(verificationInputsFingerprint(inputs), /^[a-f0-9]{64}$/)

            writeFileSync(automatic, "export default 2\n")
            assert.equal(verificationInputsMatch(inputs), false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("deduplicates an explicit input also found in a verify command", () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-ab-evidence-"))
        try {
            const verifier = join(dir, "holdout.mjs")
            writeFileSync(verifier, "// holdout\n")
            const inputs = freezeVerificationInputs({
                explicitPaths: [verifier],
                verifyCommands: [`node ${verifier}`],
                launchCwd: dir,
            })
            assert.equal(inputs.length, 1)
            assert.equal(inputs[0]?.discoveredFrom, "explicit")
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("makes missing terminal attempts explicit in metric coverage", () => {
        assert.deepEqual(
            includeUnmeasuredAttempts({
                value: 123,
                known: 5,
                unknown: 0,
                notApplicable: 0,
                total: 5,
            }, 1),
            {
                value: null,
                known: 5,
                unknown: 1,
                notApplicable: 0,
                total: 6,
            },
        )
    })

    it("does not let multiple measured turns hide a killed attempt", () => {
        const tracker = new StoryAttemptCoverageTracker()
        tracker.start("G1")
        tracker.measured("G1")
        tracker.measured("G1")
        tracker.finish("G1")

        tracker.start("G2")
        // Starting a retry closes the killed first attempt as unmeasured.
        tracker.start("G2")
        tracker.measured("G2")
        tracker.finishAll()

        assert.equal(tracker.attemptsWithMeasurement, 2)
        assert.equal(tracker.attemptsWithoutMeasurement, 1)
    })
})
