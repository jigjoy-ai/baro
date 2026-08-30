import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ArchitectureObligationContractError,
    architectureObligationsFromDecision,
    canonicalizeObligationMappings,
    missingObligationIdsFromError,
    renderArchitectureObligationCriterion,
    validateArchitectureObligationCoverage,
    violationsFromError,
} from "../../src/planning/domain/architecture-obligation-contract.js"
import type {
    ArchitectureObligationContractV1,
    ObligationNote,
    StoryObligationMapping,
} from "../../src/planning/domain/architecture-obligation-contract.js"
import { emitObligationNote } from "../../src/planning/application/plan-events.js"
import { deriveGoalContract } from "../../src/goal/goal-contract.js"

const goal = deriveGoalContract({
    objective: "Preserve behavior at every affected boundary.",
    acceptanceCriteria: ["Every affected boundary has the required behavior."],
    constraints: ["Existing callers remain compatible."],
    nonGoals: [],
    assumptions: [],
})!

const DECISION = `## Existing context
Observed repository facts.

## ADR-001: Preserve the shared behavior
**Status:** Accepted
**Context:** Multiple boundaries implement the contract.
**Decision:** Keep their behavior aligned.
**Consequences:** Each boundary needs independent evidence.

\`\`\`baro-obligations-v1
${JSON.stringify({
    schemaVersion: 1,
    obligations: [
        {
            id: "O-001",
            invariantIds: ["G-A1"],
            subject: "the direct public boundary",
            scenario: "the changed operation is invoked directly",
            expectedOutcome: "the required behavior remains observable",
            evidence: ["a focused direct-boundary test"],
        },
        {
            id: "O-002",
            invariantIds: ["G-C1"],
            subject: "existing callers",
            scenario: "the new capability is not requested",
            expectedOutcome: "their call shape and result remain compatible",
            evidence: ["typecheck", "a no-option regression test"],
        },
    ],
})}
\`\`\``

const contract = architectureObligationsFromDecision(DECISION, goal)!
const first = renderArchitectureObligationCriterion(contract.obligations[0]!)
const second = renderArchitectureObligationCriterion(contract.obligations[1]!)

describe("architecture obligation canonicalization", () => {
    // (a)
    it("canonicalizes a paraphrased known-id claim, registers ownership and warns once", () => {
        const notes: ObligationNote[] = []
        const activity: { kind: string; text: string }[] = []
        let result: ReturnType<typeof validateArchitectureObligationCoverage> | undefined
        captureActivity(activity, () => {
            result = validateArchitectureObligationCoverage(
                contract,
                [
                    {
                        storyId: "S1",
                        acceptance: [`${first} narrowed to the happy path`],
                        invariantIds: ["G-A1"],
                    },
                ],
                "partial",
                (note) => {
                    notes.push(note)
                    emitObligationNote(note)
                },
            )
        })

        assert.deepEqual(result?.coveredObligationIds, ["O-001"])
        assert.equal(notes.length, 1)
        assert.deepEqual(notes[0], {
            severity: "warn",
            kind: "canonicalized_obligation_criterion",
            storyId: "S1",
            obligationId: "O-001",
            detail:
                "story S1: canonicalized paraphrased architecture obligation O-001 criterion text",
        })
        assert.equal(activity.length, 1)
        assert.equal(activity[0]?.kind, "warn")
        assert.equal(activity[0]?.text, notes[0]!.detail)

        // The rewritten text is byte-identical to today's canonical rendering.
        const [canonicalized] = canonicalizeObligationMappings(contract, [
            {
                storyId: "S1",
                acceptance: [`${first} narrowed to the happy path`],
                invariantIds: ["G-A1"],
            },
        ])
        assert.deepEqual(canonicalized?.acceptance, [first])
    })

    // (b)
    it("passes an unknown obligation id through untouched and still rejects it", () => {
        const notes: ObligationNote[] = []
        const mappings: StoryObligationMapping[] = [
            {
                storyId: "S1",
                // Invariant-looking tokens in the text must never be sourced.
                acceptance: ["[O-099]; invented; parents G-A1, G-C1"],
                invariantIds: ["G-A1"],
            },
        ]
        const [passed] = canonicalizeObligationMappings(contract, mappings, (note) =>
            notes.push(note),
        )
        assert.equal(passed, mappings[0])
        assert.deepEqual(passed?.acceptance, mappings[0]!.acceptance)
        assert.deepEqual(passed?.invariantIds, ["G-A1"])
        assert.equal(notes.length, 0)

        const error = throws(() =>
            validateArchitectureObligationCoverage(contract, mappings, "partial", (note) =>
                notes.push(note),
            ),
        )
        assert.deepEqual(
            violationsFromError(error).map(({ kind }) => kind),
            ["unknown_obligation"],
        )
        assert.equal(
            error.message,
            "story S1 claims unknown architecture obligation O-099",
        )
        assert.equal(notes.length, 0)
    })

    // (c)
    it("still rejects two obligation ids written in one claim", () => {
        const notes: ObligationNote[] = []
        const error = throws(() =>
            validateArchitectureObligationCoverage(
                contract,
                [
                    {
                        storyId: "S2",
                        acceptance: ["[O-001/O-002] both boundaries stay compatible"],
                        invariantIds: ["G-A1", "G-C1"],
                    },
                ],
                "partial",
                (note) => notes.push(note),
            ),
        )
        const violations = violationsFromError(error)
        assert.deepEqual(violations.map(({ kind }) => kind), ["compound_claim"])
        assert.equal(
            violations[0]?.detail,
            "story S2 writes 2 obligation ids in one claim [O-001/O-002]; " +
                "each obligation needs its own acceptance criterion",
        )
        assert.equal(notes.length, 0)
    })

    // (d)
    it("still rejects two stories owning one obligation and keeps the first owner", () => {
        const error = throws(() =>
            validateArchitectureObligationCoverage(
                contract,
                [
                    { storyId: "S1", acceptance: [first], invariantIds: ["G-A1"] },
                    { storyId: "S3", acceptance: [first], invariantIds: ["G-A1"] },
                ],
                "partial",
            ),
        )
        const violations = violationsFromError(error)
        assert.deepEqual(violations.map(({ kind }) => kind), ["duplicate_owner"])
        assert.equal(
            violations[0]?.detail,
            "architecture obligation O-001 has multiple evidence owners: S1, S3",
        )
        assert.equal(error.message, violations[0]!.detail)
    })

    // (e)
    it("collects three distinct violations across all mappings in one throw", () => {
        const error = throws(() =>
            validateArchitectureObligationCoverage(
                contract,
                [
                    { storyId: "S1", acceptance: [first], invariantIds: ["G-A1"] },
                    { storyId: "S2", acceptance: [first], invariantIds: ["G-A1"] },
                    {
                        storyId: "S3",
                        acceptance: ["[O-001/O-002] both boundaries"],
                        invariantIds: ["G-A1", "G-C1"],
                    },
                    { storyId: "S4", acceptance: ["[O-099] invented"], invariantIds: [] },
                ],
                "partial",
            ),
        )
        const violations = violationsFromError(error)
        assert.deepEqual(violations.map(({ kind }) => kind), [
            "duplicate_owner",
            "compound_claim",
            "unknown_obligation",
        ])
        assert.equal(
            error.message,
            "3 architecture obligation violations: " +
                violations.map(({ detail }) => detail).join("; "),
        )
        assert.deepEqual(missingObligationIdsFromError(error), [])
    })

    // (f) first half
    it("completes omitted parent invariants with a warn instead of rejecting", () => {
        const notes: ObligationNote[] = []
        const activity: { kind: string; text: string }[] = []
        let result: ReturnType<typeof validateArchitectureObligationCoverage> | undefined
        captureActivity(activity, () => {
            result = validateArchitectureObligationCoverage(
                contract,
                [{ storyId: "S7", acceptance: [`[O-001]: weakened`], invariantIds: [] }],
                "partial",
                (note) => {
                    notes.push(note)
                    emitObligationNote(note)
                },
            )
        })

        assert.deepEqual(result?.coveredObligationIds, ["O-001"])
        const completion = notes.find(
            ({ kind }) => kind === "completed_obligation_parent_invariants",
        )
        assert.deepEqual(completion, {
            severity: "warn",
            kind: "completed_obligation_parent_invariants",
            storyId: "S7",
            obligationId: "O-001",
            detail:
                "story S7: completed parent GoalContract invariant(s) for O-001: G-A1",
        })
        const [canonicalized] = canonicalizeObligationMappings(contract, [
            { storyId: "S7", acceptance: [`[O-001]: weakened`], invariantIds: [] },
        ])
        assert.deepEqual(canonicalized?.invariantIds, ["G-A1"])
        assert.equal(activity.length, notes.length)
        assert.ok(activity.every(({ kind }) => kind === "warn"))
    })

    // (f) second half
    it("keeps the missing-parents branch fatal for mappings the canonicalizer cannot resolve", () => {
        // Only an id outside the canonical O-000 shape reaches the backstop:
        // every parsable claim is completed before the loops run.
        const unresolvable: ArchitectureObligationContractV1 = {
            schemaVersion: 1,
            obligations: [
                {
                    id: "O-1",
                    invariantIds: ["G-A1"],
                    subject: "the direct public boundary",
                    scenario: "the changed operation is invoked directly",
                    expectedOutcome: "the required behavior remains observable",
                    evidence: ["a focused direct-boundary test"],
                },
            ],
        }
        const criterion = renderArchitectureObligationCriterion(
            unresolvable.obligations[0]!,
        )
        const notes: ObligationNote[] = []
        const error = throws(() =>
            validateArchitectureObligationCoverage(
                unresolvable,
                [{ storyId: "S8", acceptance: [criterion], invariantIds: [] }],
                "partial",
                (note) => notes.push(note),
            ),
        )
        const violations = violationsFromError(error)
        assert.deepEqual(violations.map(({ kind }) => kind), [
            "missing_parent_invariants",
        ])
        assert.equal(
            violations[0]?.detail,
            "story S8 owns O-1 but omits parent GoalContract invariant(s): G-A1",
        )
        assert.equal(error.message, violations[0]!.detail)
        assert.equal(notes.length, 0)
    })

    it("is idempotent: a second pass changes nothing and warns nothing", () => {
        const notes: ObligationNote[] = []
        const mappings: StoryObligationMapping[] = [
            { storyId: "S1", acceptance: [`${first} narrowed`], invariantIds: [] },
            { storyId: "S2", acceptance: [second], invariantIds: ["G-C1"] },
        ]
        const once = canonicalizeObligationMappings(contract, mappings, (note) =>
            notes.push(note),
        )
        assert.equal(notes.length, 2)
        assert.equal(once[1], mappings[1])

        const secondNotes: ObligationNote[] = []
        const twice = canonicalizeObligationMappings(contract, once, (note) =>
            secondNotes.push(note),
        )
        assert.equal(secondNotes.length, 0)
        for (const [index, mapping] of twice.entries()) {
            assert.equal(mapping, once[index])
        }
    })

    it("keeps the incomplete-coverage throw and partial mode unchanged", () => {
        const owned = [{ storyId: "S1", acceptance: [first], invariantIds: ["G-A1"] }]
        assert.deepEqual(
            validateArchitectureObligationCoverage(contract, owned, "partial"),
            { coveredObligationIds: ["O-001"], missingObligationIds: ["O-002"] },
        )

        const error = throws(() =>
            validateArchitectureObligationCoverage(contract, owned, "complete"),
        )
        assert.equal(
            error.message,
            "architecture obligation coverage is incomplete; no story owns: O-002",
        )
        assert.deepEqual(missingObligationIdsFromError(error), ["O-002"])
        assert.deepEqual(
            violationsFromError(error).map(({ kind }) => kind),
            ["unowned_obligation"],
        )
        assert.equal(
            violationsFromError(error)[0]?.detail,
            "architecture obligation O-002 has no evidence owner",
        )
    })

    it("aggregates a mapping violation with unowned obligations, keeping the ids", () => {
        const error = throws(() =>
            validateArchitectureObligationCoverage(
                contract,
                [{ storyId: "S1", acceptance: ["[O-099] invented"], invariantIds: [] }],
                "complete",
            ),
        )
        const violations = violationsFromError(error)
        assert.deepEqual(violations.map(({ kind }) => kind), [
            "unknown_obligation",
            "unowned_obligation",
            "unowned_obligation",
        ])
        assert.equal(
            error.message,
            "3 architecture obligation violations: " +
                violations.map(({ detail }) => detail).join("; "),
        )
        assert.deepEqual(missingObligationIdsFromError(error), ["O-001", "O-002"])
    })

    it("caps the aggregate message at twelve details and never truncates violations", () => {
        const many = Array.from({ length: 14 }, (_, index) => ({
            storyId: `S${index}`,
            acceptance: [`[O-${String(100 + index)}] invented`],
            invariantIds: [],
        }))
        const error = throws(() =>
            validateArchitectureObligationCoverage(contract, many, "partial"),
        )
        const violations = violationsFromError(error)
        assert.equal(violations.length, 14)
        assert.equal(
            error.message,
            "14 architecture obligation violations: " +
                [
                    ...violations.slice(0, 12).map(({ detail }) => detail),
                    "… (+2 more)",
                ].join("; "),
        )
    })
})

function throws(run: () => unknown): ArchitectureObligationContractError {
    try {
        run()
    } catch (error) {
        assert.ok(error instanceof ArchitectureObligationContractError)
        return error
    }
    assert.fail("expected an ArchitectureObligationContractError")
}

/**
 * emitPlanActivity writes the `activity` BaroEvent straight to stdout, so
 * intercepting the write is the only way to observe the canonicalization warn.
 */
function captureActivity(
    sink: { kind: string; text: string }[],
    run: () => void,
): boolean {
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        const line = typeof chunk === "string" ? chunk : String(chunk)
        try {
            const parsed = JSON.parse(line) as {
                type?: string
                id?: string
                kind?: string
                text?: string
            }
            if (parsed.type === "activity" && parsed.id === "plan") {
                sink.push({ kind: parsed.kind ?? "", text: parsed.text ?? "" })
                return true
            }
        } catch {
            /* not one of ours — pass it through */
        }
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write
    try {
        run()
    } finally {
        process.stdout.write = original
    }
    return true
}
