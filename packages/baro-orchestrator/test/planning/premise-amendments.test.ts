import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ArchitecturePremiseAmended, ArchitecturePremiseDisputed } from "../../src/semantic-events.js"
import {
    MAX_PREMISE_AMENDMENTS,
    PremiseAmendmentAuthority,
    decisionDocumentWithAmendments,
    withoutPremiseAmendments,
} from "../../src/planning/application/premise-amendments.js"
import { joinWithCapture, source } from "../execution/helpers.js"

const DOCUMENT = [
    "## ADR-001: Run the suite through the directory form",
    "**Status:** Accepted",
    "**Decision:** `scripts.test` is exactly `node --test test/`.",
].join("\n")

function dispute(overrides: Record<string, unknown> = {}) {
    return ArchitecturePremiseDisputed.create({
        runId: "run-1",
        storyId: "S1",
        claim: "`node --test test/` runs the suite",
        command: "node --test test/",
        output: "Error: Cannot find module /repo/test\ntests 0 | pass 0 | fail 1",
        ...overrides,
    })
}

describe("premise amendments", () => {
    it("withdraws a claim on evidence and leaves the decision standing", async () => {
        let stored = DOCUMENT
        const authority = new PremiseAmendmentAuthority({
            runId: "run-1",
            read: () => stored,
            persist: (document) => {
                stored = document
            },
        })
        const env = joinWithCapture(authority)
        env.deliverSemanticEvent(source("bridge"), dispute({ obligationId: "O-015" }))

        assert.match(stored, /## Amendments \(evidence-backed\)/)
        assert.match(stored, /Amendment 1 — O-015/)
        assert.match(stored, /\*\*Withdrawn claim:\*\* `node --test test\/` runs the suite/)
        assert.match(stored, /tests 0 \| pass 0 \| fail 1/)
        // The decision itself is untouched, byte for byte.
        assert.match(stored, /\*\*Decision:\*\* `scripts\.test` is exactly `node --test test\/`\./)
        assert.equal(withoutPremiseAmendments(stored), DOCUMENT)

        const amended = env.events.filter(ArchitecturePremiseAmended.is)
        assert.equal(amended.length, 1)
        assert.equal(amended[0]!.data.obligationId, "O-015")
        assert.equal(amended[0]!.data.ordinal, 1)
    })

    it("records one amendment per claim, however many stories rediscover it", async () => {
        let stored = DOCUMENT
        const authority = new PremiseAmendmentAuthority({
            runId: "run-1",
            read: () => stored,
            persist: (document) => {
                stored = document
            },
        })
        const env = joinWithCapture(authority)
        env.deliverSemanticEvent(source("bridge"), dispute())
        env.deliverSemanticEvent(source("bridge"), dispute({ storyId: "S2" }))
        env.deliverSemanticEvent(source("bridge"), dispute({ storyId: "S3" }))

        assert.equal(authority.applied.length, 1)
        assert.equal(stored.match(/### Amendment/gu)?.length, 1)
    })

    it("ignores another run's dispute and stops at the budget", async () => {
        let stored = DOCUMENT
        const lines: string[] = []
        const authority = new PremiseAmendmentAuthority({
            runId: "run-1",
            read: () => stored,
            persist: (document) => {
                stored = document
            },
            maxAmendments: 2,
            onProgress: (line) => lines.push(line),
        })
        const env = joinWithCapture(authority)
        env.deliverSemanticEvent(source("bridge"), dispute({ runId: "run-2" }))
        assert.equal(authority.applied.length, 0, "a foreign run cannot amend this contract")

        for (const claim of ["claim one", "claim two", "claim three"]) {
            env.deliverSemanticEvent(source("bridge"), dispute({ claim }))
        }
        assert.equal(authority.applied.length, 2)
        assert.ok(
            lines.some((line) => /exceeds the amendment budget of 2/u.test(line)),
            "the refusal is stated, not silent",
        )
    })

    it("never nests amendment blocks when the document is re-rendered", () => {
        const once = decisionDocumentWithAmendments(DOCUMENT, [
            {
                storyId: "S1",
                claim: "a",
                command: "cmd",
                output: "out",
                ordinal: 1,
            },
        ])
        const twice = decisionDocumentWithAmendments(once, [
            { storyId: "S1", claim: "a", command: "cmd", output: "out", ordinal: 1 },
            { storyId: "S2", claim: "b", command: "cmd2", output: "out2", ordinal: 2 },
        ])
        assert.equal(twice.match(/## Amendments \(evidence-backed\)/gu)?.length, 1)
        assert.equal(twice.match(/### Amendment/gu)?.length, 2)
        assert.ok(MAX_PREMISE_AMENDMENTS >= 2)
    })
})
