import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { type ContractNote } from "../../src/contract/contract-normalization.js"
import {
    GOAL_CONSTRAINT_FENCE,
    GoalConstraintContractError,
    MAX_CONSTRAINT_PREDICATES,
    attachGoalConstraintContract,
    goalPredicatesFromWire,
    hasGoalConstraintFence,
    parseGoalConstraintContract,
    validateGoalConstraintPredicates,
} from "../../src/goal/goal-constraint-appendix.js"
import { validateArchitectOutcome } from "../../src/planning/domain/architect-outcome.js"

const ABSENT = {
    invariantId: "G-C1",
    kind: "absent" as const,
    pathPrefix: "internal/",
    pathSuffix: "",
    text: "github.com/jackc/pgx/v5",
}
const UNCHANGED = {
    invariantId: "G-C2",
    kind: "unchanged" as const,
    pathPrefix: "",
    pathSuffix: "_test.go",
    text: "",
}

function recorder(): { notes: ContractNote[]; sink: (note: ContractNote) => void } {
    const notes: ContractNote[] = []
    return { notes, sink: (note) => notes.push(note) }
}

function defectsOf(run: () => unknown): readonly { path: string; message: string }[] {
    try {
        run()
    } catch (error) {
        assert.ok(error instanceof GoalConstraintContractError, String(error))
        return error.defects
    }
    assert.fail("expected the appendix to reject")
}

describe("predicates stated by the stage that read the repository", () => {
    // The parser this replaces read the constraint text with regular
    // expressions. It fit one goal and one repository: a Go import looked like
    // a path, a package without a hyphen was invisible, and "do not modify any
    // *_test.go" froze every Go file in the tree.
    it("carries a Go import and a Go test suffix, which prose parsing could not", () => {
        const predicates = validateGoalConstraintPredicates([ABSENT, UNCHANGED])
        assert.deepEqual(goalPredicatesFromWire(predicates), [
            {
                kind: "absent",
                invariantId: "G-C1",
                pathPrefix: "internal/",
                text: "github.com/jackc/pgx/v5",
            },
            { kind: "unchanged", invariantId: "G-C2", pathSuffix: "_test.go" },
        ])
    })

    it("survives a round trip through the decision document", () => {
        const document = attachGoalConstraintContract(
            "## Existing context\nA repository.",
            [ABSENT, UNCHANGED],
        )
        assert.match(document, new RegExp(GOAL_CONSTRAINT_FENCE, "u"))
        assert.deepEqual(parseGoalConstraintContract(document), [ABSENT, UNCHANGED])
    })

    it("leaves a document alone when nothing could be stated", () => {
        const document = "## Existing context\nA repository."
        assert.equal(attachGoalConstraintContract(document, []), document)
        assert.deepEqual(parseGoalConstraintContract(document), [])
    })

    it("is not an error for a document written before the appendix existed", () => {
        assert.deepEqual(parseGoalConstraintContract(undefined), [])
        assert.deepEqual(parseGoalConstraintContract("## Existing context"), [])
    })

    it("refuses a second appendix rather than choosing between them", () => {
        const once = attachGoalConstraintContract("## ctx", [ABSENT])
        assert.throws(
            () => attachGoalConstraintContract(once, [UNCHANGED]),
            GoalConstraintContractError,
        )
    })
})

describe("what the host refuses to evaluate", () => {
    it("rejects a predicate missing the key that gives it meaning", () => {
        assert.throws(
            () =>
                validateGoalConstraintPredicates([
                    { ...ABSENT, pathPrefix: "" },
                ]),
            /needs both a pathPrefix and the text/u,
        )
        assert.throws(
            () =>
                validateGoalConstraintPredicates([
                    { ...UNCHANGED, pathSuffix: "" },
                ]),
            /needs the pathSuffix/u,
        )
    })

    // The measured false positive: ".go" as a protected suffix would freeze
    // every source file, and the report would name the whole repository.
    it("rejects a suffix too broad to mean anything", () => {
        for (const pathSuffix of [".go", ".ts", ".py", ".rs"]) {
            assert.throws(
                () => validateGoalConstraintPredicates([{ ...UNCHANGED, pathSuffix }]),
                /bare extension/u,
                `${pathSuffix} names every source file`,
            )
        }
        for (const pathSuffix of ["_test.go", ".spec.ts", ".test.tsx"]) {
            assert.doesNotThrow(() =>
                validateGoalConstraintPredicates([{ ...UNCHANGED, pathSuffix }]),
            )
        }
    })

    it("rejects a prefix that leaves the repository", () => {
        for (const pathPrefix of ["/etc/", "../secrets/"]) {
            assert.throws(
                () => validateGoalConstraintPredicates([{ ...ABSENT, pathPrefix }]),
                /repository-relative/u,
            )
        }
    })

    it("rejects an invariant id that is not the host's", () => {
        assert.throws(
            () =>
                validateGoalConstraintPredicates([
                    { ...ABSENT, invariantId: "whatever" },
                ]),
            /GoalContract id/u,
        )
    })

    // Omission is still fatal: normalization drops and renames keys, and has
    // no way to invent the one the model never wrote.
    it("rejects an entry that omits a key", () => {
        const { text: _text, ...withoutText } = ABSENT
        assert.throws(
            () => validateGoalConstraintPredicates([withoutText as never]),
            /exact predicate shape/u,
        )
        assert.throws(
            () => validateGoalConstraintPredicates([{} as never]),
            /exact predicate shape/u,
        )
    })

    it("rejects a malformed appendix instead of ignoring it", () => {
        const broken = ["## ctx", "", "```" + GOAL_CONSTRAINT_FENCE, "{not json", "```"].join("\n")
        assert.throws(() => parseGoalConstraintContract(broken), GoalConstraintContractError)
    })

    it("rejects an appendix from a schema it does not know", () => {
        const future = [
            "## ctx",
            "",
            "```" + GOAL_CONSTRAINT_FENCE,
            JSON.stringify({ schemaVersion: 2, predicates: [] }),
            "```",
        ].join("\n")
        assert.throws(() => parseGoalConstraintContract(future), /schemaVersion/u)
    })
})

describe("attaching is not validating", () => {
    // A run died at "already contains the reserved baro-constraints-v1 fence"
    // after the appendix was attached inside validateArchitectOutcome: the
    // same outcome is validated more than once, and the second pass saw the
    // fence the first pass wrote. A validator that transforms its input is the
    // very defect this appendix exists to catch elsewhere.
    it("lets the same outcome be validated twice", () => {
        const outcome = {
            schemaVersion: 1,
            kind: "ready",
            message: "Planning may proceed.",
            questions: [],
            evidence: [],
            constraintPredicates: [ABSENT],
            decisionDocument: {
                existingContext: "A repository.",
                decisions: [
                    {
                        title: "Keep the contract",
                        context: "Something is true.",
                        decision: "Do the thing.",
                        consequences: "Nothing else changes.",
                    },
                ],
            },
        }
        const first = validateArchitectOutcome(outcome, { decisionOnly: true })
        const second = validateArchitectOutcome(outcome, { decisionOnly: true })
        assert.equal(first.decisionDocument, second.decisionDocument)
        assert.equal(
            hasGoalConstraintFence(String(first.decisionDocument)),
            false,
            "validation reports what it read; the host attaches on acceptance",
        )
        assert.deepEqual(first.constraintPredicates, [ABSENT])
    })
})

describe("spelling drift the host can read through", () => {
    // A predicate that says everything the host needs, spelled the way a model
    // spells it: one explanatory field nobody asked for, one key in the wrong
    // case. Rejecting it discards meaning that was fully present.
    it("strips an unexpected field and canonicalizes a drifted one", () => {
        const { notes, sink } = recorder()
        const predicates = validateGoalConstraintPredicates(
            [
                {
                    invariantID: "G-C1",
                    kind: "absent",
                    pathPrefix: "internal/",
                    pathSuffix: "",
                    text: "github.com/jackc/pgx/v5",
                    rationale: "the goal forbids this driver",
                },
            ],
            sink,
        )
        assert.deepEqual(predicates, [ABSENT])
        assert.deepEqual(
            notes.map((note) => [note.severity, note.kind, note.path]),
            [
                ["warn", "canonicalized_field", "constraintPredicates[0]"],
                ["warn", "stripped_unexpected_field", "constraintPredicates[0]"],
            ],
        )
        assert.match(notes[1]!.detail, /dropped unexpected field "rationale"/u)
    })

    // Notes are computed either way; the sink only decides whether anyone is
    // listening, never what validation accepts.
    it("accepts the same drifted entry with no sink attached", () => {
        const drifted = {
            invariantId: "G-C2",
            kind: "unchanged",
            pathPrefix: "",
            "path-suffix": "_test.go",
            text: "",
        }
        assert.deepEqual(validateGoalConstraintPredicates([drifted]), [UNCHANGED])
    })

    // Two keys naming the same field: whichever one the host picked, it would
    // be discarding a value the model meant to state.
    it("refuses to choose between two keys that name one field", () => {
        const defects = defectsOf(() =>
            validateGoalConstraintPredicates([
                { ...ABSENT, invariantID: "G-C9" } as never,
            ]),
        )
        assert.deepEqual(defects, [
            {
                path: "constraintPredicates[0]",
                message:
                    'constraintPredicates[0]: fields "invariantID" and "invariantId" both name "invariantId"',
            },
        ])
    })

    // One pass, every bad entry: the repair prompt downstream is only as good
    // as the defect list it is handed.
    it("reports a later entry's own defect alongside the ambiguity", () => {
        const defects = defectsOf(() =>
            validateGoalConstraintPredicates([
                { ...ABSENT, invariantID: "G-C9" } as never,
                UNCHANGED,
                { ...UNCHANGED, invariantId: "whatever" },
            ]),
        )
        assert.deepEqual(
            defects.map((defect) => defect.path),
            ["constraintPredicates[0]", "constraintPredicates[2]"],
        )
        assert.match(defects[0]!.message, /both name "invariantId"/u)
        assert.match(defects[1]!.message, /GoalContract id/u)
    })

    // A single rejection still reads exactly as it did before defects existed.
    it("keeps a lone defect's message character-for-character", () => {
        try {
            validateGoalConstraintPredicates([{ ...ABSENT, invariantId: "whatever" }])
            assert.fail("expected the appendix to reject")
        } catch (error) {
            assert.ok(error instanceof GoalConstraintContractError)
            assert.equal(
                error.message,
                "constraintPredicates[0].invariantId must be a GoalContract id such as G-C1",
            )
            assert.equal(error.defects.length, 1)
            assert.equal(error.defects[0]!.message, error.message)
        }
    })

    it("defaults an error raised outside the entry loop to one top-level defect", () => {
        const defects = defectsOf(() => validateGoalConstraintPredicates("nope"))
        assert.deepEqual(defects, [
            { path: "", message: "constraintPredicates must be an array" },
        ])
    })

    // Canonicalizing the key does not soften what the value has to say.
    it("still rejects the kind/pathSuffix rules through drifted spellings", () => {
        const { notes, sink } = recorder()
        assert.throws(
            () =>
                validateGoalConstraintPredicates(
                    [
                        {
                            invariantId: "G-C2",
                            Kind: "unchanged",
                            pathPrefix: "",
                            "path-suffix": "",
                            text: "",
                            note: "protect the suite",
                        },
                    ],
                    sink,
                ),
            /needs the pathSuffix/u,
        )
        assert.throws(
            () =>
                validateGoalConstraintPredicates([
                    {
                        invariantId: "G-C2",
                        Kind: "unchanged",
                        pathPrefix: "",
                        "path-suffix": ".go",
                        text: "",
                    },
                ]),
            /bare extension/u,
        )
        assert.throws(
            () =>
                validateGoalConstraintPredicates([
                    {
                        InvariantId: "G-C1",
                        kind: "absent",
                        pathPrefix: "",
                        pathSuffix: "",
                        Text: "github.com/jackc/pgx/v5",
                    },
                ]),
            /needs both a pathPrefix and the text/u,
        )
        assert.ok(notes.length > 0, "the drift was normalized before the rule ran")
    })

    it("still rejects an entry that is not an object at all", () => {
        assert.throws(
            () => validateGoalConstraintPredicates(["G-C1 must stay absent"]),
            /constraintPredicates\[0\] must be an object/u,
        )
    })
})

describe("holes in the array", () => {
    // A model that emits a hole has still stated every other predicate. Killing
    // the appendix over the hole throws away claims that stand on their own.
    it("skips an absent entry and keeps the predicates that stand alone", () => {
        const { notes, sink } = recorder()
        const predicates = validateGoalConstraintPredicates(
            [ABSENT, null, UNCHANGED],
            sink,
        )
        assert.deepEqual(predicates, [ABSENT, UNCHANGED])
        assert.deepEqual(notes, [
            {
                severity: "warn",
                kind: "skipped_absent_entry",
                path: "constraintPredicates[1]",
                detail: "constraintPredicates[1]: skipped absent entry",
            },
        ])
    })

    it("skips an undefined entry the same way", () => {
        const { notes, sink } = recorder()
        assert.deepEqual(
            validateGoalConstraintPredicates([undefined, UNCHANGED], sink),
            [UNCHANGED],
        )
        assert.deepEqual(notes.map((note) => note.path), ["constraintPredicates[0]"])
    })

    // An empty object is not a hole. It is a predicate that states nothing,
    // and it rejects as it always did.
    it("does not mistake an empty object for an absent entry", () => {
        const { notes, sink } = recorder()
        assert.throws(
            () => validateGoalConstraintPredicates([{}, UNCHANGED], sink),
            /exact predicate shape/u,
        )
        assert.deepEqual(
            notes.filter((note) => note.kind === "skipped_absent_entry"),
            [],
        )
    })

    it("rejects an appendix whose every entry was a hole", () => {
        const defects = defectsOf(() =>
            validateGoalConstraintPredicates([null, undefined, null]),
        )
        assert.deepEqual(defects, [
            {
                path: "constraintPredicates",
                message: "constraintPredicates must declare at least one predicate",
            },
        ])
    })

    // The bound is what the model sent, not what survived skipping; measuring
    // the survivors would let an oversized reply pad itself with holes.
    it("counts holes against the entry bound before skipping any of them", () => {
        const { notes, sink } = recorder()
        const oversized = Array.from(
            { length: MAX_CONSTRAINT_PREDICATES + 1 },
            (_unused, index) => (index % 2 === 0 ? null : ABSENT),
        )
        assert.throws(
            () => validateGoalConstraintPredicates(oversized, sink),
            new RegExp(`exceeds ${MAX_CONSTRAINT_PREDICATES} entries`, "u"),
        )
        assert.deepEqual(notes, [], "nothing was skipped or normalized first")
    })

    it("carries the sink through the decision-document reader", () => {
        const { notes, sink } = recorder()
        const document = attachGoalConstraintContract("## ctx", [ABSENT])
        const drifted = document.replace('"invariantId"', '"invariantID"')
        assert.deepEqual(parseGoalConstraintContract(drifted, sink), [ABSENT])
        assert.deepEqual(notes.map((note) => note.kind), ["canonicalized_field"])
    })
})
