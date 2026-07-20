import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    MAX_ARCHITECT_OUTCOME_BYTES,
    ArchitectOutcomeContractError,
    parseArchitectOutcome,
    wrapArchitectOutcome,
} from "../src/planning/architect-outcome.js"
import { ARCHITECT_OUTCOME_SYSTEM_PROMPT } from "../src/planning/architect-prompts.js"

const DECISION_DOCUMENT = `## Existing context
The repository uses a strict provider-neutral planning contract.

## ADR-001: Keep authority outside model output
**Status:** Accepted
**Context:** Provider text is untrusted.
**Decision:** Attach session and request correlation only after strict parsing.
**Consequences:** Malformed or foreign model output cannot advance planning.`

const OBLIGATION_DOCUMENT = `${DECISION_DOCUMENT}

## Semantic obligation contract

\`\`\`baro-obligations-v1
{"schemaVersion":1,"obligations":[{"id":"O-001","invariantIds":["G-A1"],"subject":"the provider-neutral planning boundary","scenario":"a non-trivial goal advances to planning","expectedOutcome":"the exact validated goal remains observable to downstream planning","evidence":["a focused outcome-contract test"]}]}
\`\`\``

const GOAL_ENVELOPE = {
    objective: "Keep authority outside model output.",
    acceptanceCriteria: ["The validated goal remains observable."],
    constraints: [],
    nonGoals: [],
    assumptions: [],
}

const TRIVIAL_DECISION_DOCUMENT = `## ADR-001: No cross-cutting decisions needed
**Status:** Accepted
**Context:** The requested change is one isolated repository edit.
**Decision:** This goal is trivial; no cross-cutting decisions are needed. Follow the
user's goal as stated and the conventions already in the repo.
**Consequences:** None of note.`

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

        // Non-schema providers and persisted v1 payloads remain compatible
        // with the original optional-reason parser contract.
        const withoutReason = needsInput()
        const question = withoutReason.questions[0] as { reason?: string }
        delete question.reason
        const acceptedWithoutReason = parseArchitectOutcome(
            JSON.stringify(withoutReason),
        )
        assert.equal("reason" in acceptedWithoutReason.questions[0]!, false)
    })

    it("keeps the shared prompt aligned with the strict native schema", () => {
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /reason field is required/)
        assert.doesNotMatch(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /optional reason/)
        assert.match(
            ARCHITECT_OUTCOME_SYSTEM_PROMPT,
            /direct read-only access to the selected\s+checkout/u,
        )
        assert.match(
            ARCHITECT_OUTCOME_SYSTEM_PROMPT,
            /not a\s+valid reason for needsInput/u,
        )
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /baro-obligations-v1/u)
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /directly callable/u)
    })

    it("requires obligations for every outcome-mode document without breaking legacy parsing", () => {
        assert.equal(parseArchitectOutcome(JSON.stringify(ready())).kind, "ready")
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(ready()), {
                requireObligations: true,
            }),
            /requires a baro-obligations-v1 appendix/u,
        )
        assert.equal(
            parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: OBLIGATION_DOCUMENT,
            }), {
                requireObligations: true,
                trustedGoalEnvelope: GOAL_ENVELOPE,
            }).kind,
            "ready",
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: OBLIGATION_DOCUMENT.replace("G-A1", "G-A2"),
            }), {
                requireObligations: true,
                trustedGoalEnvelope: GOAL_ENVELOPE,
            }),
            /unknown GoalContract invariant.*G-A2/u,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: OBLIGATION_DOCUMENT,
            }), {
                requireObligations: true,
                trustedGoalEnvelope: {
                    ...GOAL_ENVELOPE,
                    constraints: ["Existing callers remain compatible."],
                },
            }),
            /does not refine.*G-C1/u,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: TRIVIAL_DECISION_DOCUMENT,
            }), {
                requireObligations: true,
                trustedGoalEnvelope: {
                    objective: "Preserve cancellation across every provider.",
                    acceptanceCriteria: [
                        "Every provider closes its stream.",
                        "Direct adapter callers observe cancellation.",
                        "Retry cleanup remains idempotent.",
                    ],
                    constraints: [
                        "Keep the public API compatible.",
                        "Do not centralize provider ownership.",
                    ],
                    nonGoals: [],
                    assumptions: [],
                },
            }),
            /requires a baro-obligations-v1 appendix/u,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: `${TRIVIAL_DECISION_DOCUMENT}

## ADR-002: Add a real cross-cutting design
**Status:** Accepted
**Context:** Multiple providers need a shared contract.
**Decision:** Introduce a provider-neutral boundary.
**Consequences:** Every provider must implement it.`,
            }), {
                requireObligations: true,
            }),
            /requires a baro-obligations-v1 appendix/u,
        )
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
