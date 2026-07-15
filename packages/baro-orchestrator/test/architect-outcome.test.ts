import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    MAX_ARCHITECT_OUTCOME_BYTES,
    ArchitectOutcomeContractError,
    parseArchitectOutcome,
    wrapArchitectOutcome,
} from "../src/planning/architect-outcome.js"

const DECISION_DOCUMENT = `## Existing context
The repository uses a strict provider-neutral planning contract.

## ADR-001: Keep authority outside model output
**Status:** Accepted
**Context:** Provider text is untrusted.
**Decision:** Attach session and request correlation only after strict parsing.
**Consequences:** Malformed or foreign model output cannot advance planning.`

function ready() {
    return {
        schemaVersion: 1,
        kind: "ready",
        message: "Repository validation passed; planning may proceed.",
        questions: [],
        evidence: [],
        decisionDocument: DECISION_DOCUMENT,
    }
}

function needsInput() {
    return {
        schemaVersion: 1,
        kind: "needsInput",
        message: "One public compatibility choice remains unresolved.",
        questions: [{
            id: "wire-compat",
            text: "Must existing clients keep the current wire representation?",
            reason: "The repository contains both legacy and v2 serializers.",
        }],
        evidence: [{
            path: "src/protocol/serializer.ts",
            line: 42,
            fact: "The public serializer still emits the legacy field names.",
        }],
        decisionDocument: null,
    }
}

describe("ArchitectOutcomeV1", () => {
    it("accepts and deeply freezes both exact dispositions", () => {
        const acceptedReady = parseArchitectOutcome(JSON.stringify(ready()))
        assert.equal(acceptedReady.kind, "ready")
        assert.ok(Object.isFrozen(acceptedReady))
        assert.ok(Object.isFrozen(acceptedReady.questions))

        const acceptedNeedsInput = parseArchitectOutcome(JSON.stringify(needsInput()))
        assert.equal(acceptedNeedsInput.kind, "needsInput")
        assert.ok(Object.isFrozen(acceptedNeedsInput.questions[0]))
        assert.ok(Object.isFrozen(acceptedNeedsInput.evidence[0]))
        assert.throws(() => {
            ;(acceptedNeedsInput.evidence as unknown as unknown[]).push("forged")
        }, TypeError)
    })

    it("rejects prose, unknown keys, discriminator violations and unsafe evidence", () => {
        assert.throws(
            () => parseArchitectOutcome(`\`\`\`json\n${JSON.stringify(ready())}\n\`\`\``),
            /not valid JSON/,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({ ...ready(), sessionId: "model-owned" })),
            /exact v1 schema/,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                questions: [{ id: "q1", text: "forged" }],
            })),
            /ready.*empty questions and evidence/,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...needsInput(),
                decisionDocument: DECISION_DOCUMENT,
            })),
            /needsInput.*decisionDocument null/,
        )
        for (const path of ["/etc/passwd", "../secret", "src/../secret", "C:/secret", "src\\secret"]) {
            const value = needsInput()
            value.evidence[0]!.path = path
            assert.throws(
                () => parseArchitectOutcome(JSON.stringify(value)),
                /portable project-relative path/,
                path,
            )
        }
    })

    it("requires repository evidence for a needsInput disposition", () => {
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({ ...needsInput(), evidence: [] })),
            /requires repository evidence/,
        )
    })

    it("enforces the UTF-8 wire ceiling before JSON parsing", () => {
        const oversized = "x".repeat(MAX_ARCHITECT_OUTCOME_BYTES + 1)
        assert.throws(
            () => parseArchitectOutcome(oversized),
            /bytes; limit/,
        )
    })

    it("attaches only trusted safe correlation outside the provider payload", () => {
        const outcome = parseArchitectOutcome(JSON.stringify(needsInput()))
        const transport = wrapArchitectOutcome(outcome, {
            sessionId: "session-1",
            goalRequestId: "goal-request-1",
            architectRequestId: "architect-request-1",
        })
        assert.deepEqual(Object.keys(transport), [
            "schemaVersion",
            "sessionId",
            "goalRequestId",
            "architectRequestId",
            "outcome",
        ])
        assert.equal("sessionId" in transport.outcome, false)
        assert.ok(Object.isFrozen(transport))
        assert.throws(
            () => wrapArchitectOutcome(outcome, {
                sessionId: "../foreign",
                goalRequestId: "goal-request-1",
                architectRequestId: "architect-request-1",
            }),
            ArchitectOutcomeContractError,
        )
    })
})
