import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import {
    MAX_GATE_DETAIL_CHARS,
    gateFingerprint,
    renderGateReport,
    shouldDeliverGate,
    summarizeGate,
} from "../../src/verification/continuous-gate.js"

const green = [
    { label: "go build ./...", passed: true, detail: "" },
    { label: "go test ./...", passed: true, detail: "" },
]
const red = [
    { label: "go build ./...", passed: true, detail: "" },
    { label: "go test ./...", passed: false, detail: "FAIL\tinternal/order 0.4s" },
]

const slow = [
    { label: "npm run build", passed: true, detail: "" },
    {
        label: "npm run test",
        passed: false,
        detail: "npm timed out after 600000ms — exceeded the absolute command ceiling",
        timedOut: true,
    },
]

describe("continuous gate policy", () => {
    // #286: a suite longer than the gate's own limit was reported as FAIL for a six-file change.
    it("reports a command cut at the gate's own limit as unfinished, not as a failure", () => {
        const outcome = summarizeGate(slow)
        const report = renderGateReport(outcome)

        assert.equal(outcome.allPassed, false, "an unfinished gate is not green either")
        assert.match(report, /SLOW {2}npm run test/u)
        assert.doesNotMatch(report, /FAIL/u)
        assert.doesNotMatch(report, /--- npm run test ---/u)
        assert.match(report, /did not finish within this gate's time limit: it says nothing about your change/u)
        assert.match(report, /Run the part of it your change needs yourself \(npm run test\)/u)
    })

    it("keeps an unfinished command apart from a failed one when deciding what is news", () => {
        const failed = summarizeGate([slow[0]!, { ...slow[1]!, timedOut: false }])
        assert.notEqual(gateFingerprint(summarizeGate(slow)), gateFingerprint(failed))
        assert.equal(shouldDeliverGate(summarizeGate(slow), summarizeGate(slow)), false)
    })

    it("is green only when every command passed and something ran", () => {
        assert.equal(summarizeGate(green).allPassed, true)
        assert.equal(summarizeGate(red).allPassed, false)
        // Nothing ran is not success — a project with no detectable gates
        // must not be reported to the agent as verified.
        assert.equal(summarizeGate([]).allPassed, false)
    })

    it("delivers news, and only news", () => {
        const first = summarizeGate(red)
        assert.equal(shouldDeliverGate(null, first), true, "the first result is news")
        assert.equal(
            shouldDeliverGate(first, summarizeGate(red)),
            false,
            "the same failure again teaches nothing and costs a turn to read",
        )
        assert.equal(
            shouldDeliverGate(first, summarizeGate(green)),
            true,
            "going green is news",
        )
        assert.equal(
            shouldDeliverGate(summarizeGate(green), summarizeGate(red)),
            true,
            "breaking is news",
        )
        // A different failure under the same command is also news.
        const otherFailure = summarizeGate([
            red[0]!,
            { ...red[1]!, detail: "FAIL\tinternal/outbox 0.2s" },
        ])
        assert.equal(shouldDeliverGate(first, otherFailure), true)
    })

    it("never delivers when the project has no gates to run", () => {
        assert.equal(shouldDeliverGate(null, summarizeGate([])), false)
    })

    it("tells the agent it no longer has to run these itself", () => {
        // Without this the agent keeps paying for the same commands, which is
        // the entire waste the feature exists to remove.
        assert.match(renderGateReport(summarizeGate(green)), /do not need to run them yourself/u)
        assert.match(renderGateReport(summarizeGate(red)), /do not need to run them yourself/u)
    })

    it("reports what ran and what happened, without instructing", () => {
        const report = renderGateReport(summarizeGate(red))
        assert.match(report, /PASS {2}go build/u)
        assert.match(report, /FAIL {2}go test/u)
        assert.match(report, /internal\/order/u)
        // The host states facts; deciding what to do about them is the
        // agent's job, and telling it otherwise fights its own planning.
        assert.doesNotMatch(report, /you should|you must|please fix/iu)
    })

    it("keeps the tail of a long failure, where the cause actually is", () => {
        const detail = `${"noise\n".repeat(4_000)}FAIL: the real cause`
        const report = renderGateReport(
            summarizeGate([{ label: "go test ./...", passed: false, detail }]),
        )
        assert.match(report, /FAIL: the real cause/u)
        assert.match(report, /earlier characters omitted/u)
        assert.ok(report.length < detail.length)
        assert.ok(report.length < MAX_GATE_DETAIL_CHARS + 1_000)
    })

    it("bounds how many failing commands it pastes", () => {
        const many = Array.from({ length: 6 }, (_, index) => ({
            label: `cmd-${index}`,
            passed: false,
            detail: `failure ${index}`,
        }))
        const report = renderGateReport(summarizeGate(many))
        assert.match(report, /3 further failing command\(s\) omitted/u)
        assert.match(report, /failure 0/u)
        assert.doesNotMatch(report, /failure 5/u)
    })

    it("fingerprints on content, so identical runs collapse", () => {
        assert.equal(gateFingerprint(summarizeGate(red)), gateFingerprint(summarizeGate(red)))
        assert.notEqual(gateFingerprint(summarizeGate(red)), gateFingerprint(summarizeGate(green)))
    })
})
