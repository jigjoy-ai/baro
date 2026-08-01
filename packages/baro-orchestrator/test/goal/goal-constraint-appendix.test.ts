import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    GOAL_CONSTRAINT_FENCE,
    GoalConstraintContractError,
    attachGoalConstraintContract,
    goalPredicatesFromWire,
    parseGoalConstraintContract,
    validateGoalConstraintPredicates,
} from "../../src/goal/goal-constraint-appendix.js"

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

    it("rejects an entry that invents or omits a key", () => {
        assert.throws(
            () =>
                validateGoalConstraintPredicates([
                    { ...ABSENT, severity: "high" } as never,
                ]),
            /exact predicate shape/u,
        )
        const { text: _text, ...withoutText } = ABSENT
        assert.throws(
            () => validateGoalConstraintPredicates([withoutText as never]),
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
