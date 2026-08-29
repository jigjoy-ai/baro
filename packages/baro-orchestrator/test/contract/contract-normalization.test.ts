import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ContractAuthorityFieldError,
    ContractNormalizationError,
    type ContractNote,
    HOST_ASSIGNED_CORRELATION_FIELDS,
    canonicalFieldKey,
    contractDefects,
    defectFlavor,
    formatDefectList,
    joinDefectMessages,
    normalizeRecordKeys,
} from "../../src/contract/contract-normalization.js"

const PREDICATE_KEYS = ["invariantId", "kind", "pathPrefix", "pathSuffix", "text"] as const

function recorder(): { notes: ContractNote[]; sink: (note: ContractNote) => void } {
    const notes: ContractNote[] = []
    return { notes, sink: (note) => notes.push(note) }
}

/** Stands in for the required-field checks that run after normalization. */
function requireKeys(record: Record<string, unknown>, keys: readonly string[]): void {
    for (const key of keys) {
        if (!(key in record)) throw new Error(`missing ${key}`)
    }
}

describe("field names the model spelled its own way", () => {
    // The three drifts that arrive together: one key spelled exactly right,
    // one that differs only in casing/punctuation, one that means nothing here.
    it("keeps the exact key, renames the drifted key, drops the unknown one", () => {
        const value = ["a", "b"]
        const { notes, sink } = recorder()
        const normalized = normalizeRecordKeys(
            {
                invariantId: "G-C1",
                Path_Prefix: "internal/",
                explanation: value,
            },
            PREDICATE_KEYS,
            "constraintPredicates[0]",
            sink,
        )

        assert.deepEqual(normalized, { invariantId: "G-C1", pathPrefix: "internal/" })
        assert.deepEqual(notes, [
            {
                severity: "warn",
                kind: "canonicalized_field",
                path: "constraintPredicates[0]",
                detail: 'constraintPredicates[0]: renamed field "Path_Prefix" to "pathPrefix"',
            },
            {
                severity: "warn",
                kind: "stripped_unexpected_field",
                path: "constraintPredicates[0]",
                detail: 'constraintPredicates[0]: dropped unexpected field "explanation"',
            },
        ])
    })

    // Normalization is a key operation only: a value it moved must be the same
    // object the model sent, so no downstream check sees a copy.
    it("copies values by reference and never inspects them", () => {
        const evidence = [" untrimmed "]
        const normalized = normalizeRecordKeys(
            { EVIDENCE: evidence, subject: "  " },
            ["evidence", "subject"],
            "obligations[0]",
        )
        assert.equal(normalized["evidence"], evidence)
        assert.equal(normalized["subject"], "  ")
    })

    it("returns a new plain object rather than mutating the candidate", () => {
        const candidate = { invariantID: "G-A1", note: "x" }
        const normalized = normalizeRecordKeys(candidate, PREDICATE_KEYS, "c[0]")
        assert.notEqual(normalized, candidate)
        assert.deepEqual(candidate, { invariantID: "G-A1", note: "x" })
        assert.equal(Object.getPrototypeOf(normalized), Object.prototype)
    })

    it("emits nothing and behaves identically without a sink", () => {
        assert.deepEqual(
            normalizeRecordKeys({ KIND: "absent", extra: 1 }, PREDICATE_KEYS, "c[0]"),
            { kind: "absent" },
        )
    })

    it("leaves a record whose keys are all exact untouched and unannotated", () => {
        const { notes, sink } = recorder()
        const normalized = normalizeRecordKeys(
            { invariantId: "G-C1", kind: "absent" },
            PREDICATE_KEYS,
            "c[0]",
            sink,
        )
        assert.deepEqual(normalized, { invariantId: "G-C1", kind: "absent" })
        assert.deepEqual(notes, [])
    })
})

describe("what normalization refuses to guess", () => {
    // Two spellings of one field: choosing either would silently throw away
    // whichever value the model actually meant.
    it("rejects two variants that name the same expected field", () => {
        const { notes, sink } = recorder()
        assert.throws(
            () =>
                normalizeRecordKeys(
                    { invariant_id: "G-A1", "invariant-id": "G-A2" },
                    PREDICATE_KEYS,
                    "constraintPredicates[3]",
                    sink,
                ),
            (error: unknown) => {
                assert.ok(error instanceof ContractNormalizationError)
                assert.equal(error.name, "ContractNormalizationError")
                assert.equal(error.path, "constraintPredicates[3]")
                assert.equal(
                    error.message,
                    'constraintPredicates[3]: fields "invariant-id" and "invariant_id" both name "invariantId"',
                )
                return true
            },
        )
        assert.deepEqual(notes, [], "an ambiguous record is not partially normalized")
    })

    // An exact match does not win the collision either.
    it("rejects a drifted key colliding with an exact match", () => {
        assert.throws(
            () =>
                normalizeRecordKeys(
                    { invariantId: "G-A1", invariantID: "G-A2" },
                    PREDICATE_KEYS,
                    "obligations[1]",
                ),
            (error: unknown) => {
                assert.ok(error instanceof ContractNormalizationError)
                assert.equal(
                    error.message,
                    'obligations[1]: fields "invariantID" and "invariantId" both name "invariantId"',
                )
                return true
            },
        )
    })

    // Collision is only a failure when the shared canonical name is expected;
    // two unknown keys that look alike are both simply dropped.
    it("does not call two unexpected lookalikes ambiguous", () => {
        const { notes, sink } = recorder()
        assert.deepEqual(
            normalizeRecordKeys({ note_a: 1, noteA: 2 }, PREDICATE_KEYS, "c[0]", sink),
            {},
        )
        assert.deepEqual(
            notes.map((note) => note.kind),
            ["stripped_unexpected_field", "stripped_unexpected_field"],
        )
    })

    // The drift tolerance must not become a way to pass a required field the
    // model never sent.
    it("never invents an expected key that was omitted", () => {
        const { notes, sink } = recorder()
        const normalized = normalizeRecordKeys(
            { invariantId: "G-C1", kind: "absent", pathPrefix: "internal/", pathSuffix: "", commentary: "why" },
            PREDICATE_KEYS,
            "constraintPredicates[0]",
            sink,
        )

        assert.deepEqual(Object.keys(normalized), [
            "invariantId",
            "kind",
            "pathPrefix",
            "pathSuffix",
        ])
        assert.equal("text" in normalized, false)
        assert.deepEqual(
            notes.map((note) => note.kind),
            ["stripped_unexpected_field"],
        )
        assert.throws(() => requireKeys(normalized, PREDICATE_KEYS), /missing text/u)
    })
})

describe("host-assigned correlation fields", () => {
    const OUTCOME_KEYS = ["schemaVersion", "kind"] as const
    const OBLIGATION_KEYS = ["invariantId", "text"] as const

    it("refuses an outcome record that carries forged session authority", () => {
        const { notes, sink } = recorder()
        assert.throws(
            () =>
                normalizeRecordKeys(
                    { schemaVersion: 1, kind: "ready", sessionId: "x" },
                    OUTCOME_KEYS,
                    "",
                    sink,
                ),
            (error: unknown) => {
                assert.ok(error instanceof ContractAuthorityFieldError)
                assert.equal(error.name, "ContractAuthorityFieldError")
                assert.equal(error.field, "sessionId")
                assert.equal(error.path, "")
                assert.ok(error.message.includes('"sessionId"'), error.message)
                assert.match(error.message, /model output may not carry host-assigned correlation/u)
                return true
            },
        )
        assert.deepEqual(notes, [], "a refused record is not partially normalized")
    })

    // The same guard, reached through the obligation path, so the defect the
    // repair prompt groups by is the obligation flavor and not "outcome".
    it("refuses an obligation record that carries a forged run id", () => {
        const { notes, sink } = recorder()
        assert.throws(
            () =>
                normalizeRecordKeys(
                    { invariantId: "G-A1", text: "t", runId: "run-7" },
                    OBLIGATION_KEYS,
                    "obligations[0]",
                    sink,
                ),
            (error: unknown) => {
                assert.ok(error instanceof ContractAuthorityFieldError)
                assert.equal(error.field, "runId")
                assert.equal(error.path, "obligations[0]")
                assert.ok(error.message.includes('"runId"'), error.message)
                assert.equal(
                    defectFlavor({ path: error.path, message: error.message }),
                    "obligations",
                )
                return true
            },
        )
        assert.deepEqual(notes, [])
    })

    // Denial is canonical, so respelling the field is not a way past it.
    it("rejects every spelling that canonicalizes to a denied field", () => {
        for (const spelling of ["session_id", "SessionID", "goal-request-id"]) {
            assert.throws(
                () => normalizeRecordKeys({ [spelling]: "x" }, OUTCOME_KEYS, ""),
                (error: unknown) => {
                    assert.ok(error instanceof ContractAuthorityFieldError)
                    // The model's own spelling, so the repair names what it sent.
                    assert.equal(error.field, spelling)
                    assert.ok(error.message.includes(`"${spelling}"`), error.message)
                    return true
                },
            )
        }
    })

    // The denylist is layered on top of drift tolerance, not in place of it.
    it("still strips an unexpected field that is not host-assigned", () => {
        const { notes, sink } = recorder()
        const normalized = normalizeRecordKeys(
            { schemaVersion: 1, kind: "ready", vibes: "good" },
            OUTCOME_KEYS,
            "",
            sink,
        )
        assert.deepEqual(normalized, { schemaVersion: 1, kind: "ready" })
        assert.deepEqual(notes, [{
            severity: "warn",
            kind: "stripped_unexpected_field",
            path: "",
            detail: ': dropped unexpected field "vibes"',
        }])
    })

    it("refuses even when every other key is an exact expected spelling", () => {
        const { notes, sink } = recorder()
        assert.throws(
            () =>
                normalizeRecordKeys(
                    { invariantId: "G-A1", text: "t", architectRequestId: "req-1" },
                    OBLIGATION_KEYS,
                    "obligations[2]",
                    sink,
                ),
            (error: unknown) => {
                assert.ok(error instanceof ContractAuthorityFieldError)
                assert.equal(error.field, "architectRequestId")
                assert.equal(error.path, "obligations[2]")
                return true
            },
        )
        assert.deepEqual(notes, [])
    })

    // Two failures in one record must resolve deterministically to the
    // authority one: it is the more serious claim.
    it("reports forged authority before an ambiguous field pair", () => {
        const { notes, sink } = recorder()
        assert.throws(
            () =>
                normalizeRecordKeys(
                    { invariant_id: "G-A1", "invariant-id": "G-A2", sessionId: "x" },
                    OBLIGATION_KEYS,
                    "obligations[0]",
                    sink,
                ),
            (error: unknown) => {
                assert.ok(error instanceof ContractAuthorityFieldError)
                assert.equal(error.field, "sessionId")
                return true
            },
        )
        assert.deepEqual(notes, [])
    })

    it("denies the audited authority fields and no legitimate contract field", () => {
        for (const field of ["sessionId", "goalRequestId", "architectRequestId", "runId"]) {
            assert.ok(
                HOST_ASSIGNED_CORRELATION_FIELDS.includes(field),
                `${field} must be denied`,
            )
        }
        // An obligation draft carries a model id the host discards, and
        // schemaVersion is a real contract field: denying either breaks parsing.
        assert.equal(HOST_ASSIGNED_CORRELATION_FIELDS.includes("id"), false)
        assert.equal(HOST_ASSIGNED_CORRELATION_FIELDS.includes("schemaVersion"), false)
        assert.equal(HOST_ASSIGNED_CORRELATION_FIELDS.length, 19)
    })
})

describe("canonicalFieldKey", () => {
    // Casing and punctuation only. Anything cleverer would accept a field that
    // means something else.
    it("collapses casing and punctuation and nothing else", () => {
        assert.equal(canonicalFieldKey("invariantIDs"), "invariantids")
        assert.equal(canonicalFieldKey("invariant_ids"), "invariantids")
        assert.equal(canonicalFieldKey("Invariant-IDs"), "invariantids")
        assert.equal(canonicalFieldKey("path suffix 2"), "pathsuffix2")
        assert.notEqual(canonicalFieldKey("invariant"), canonicalFieldKey("invariantIds"))
        assert.notEqual(canonicalFieldKey("pathPrefix"), canonicalFieldKey("prefixPath"))
    })
})

describe("defect records carried to the repair prompt", () => {
    it("returns the carried defects when the error has them", () => {
        const error = Object.assign(new Error("a; b"), {
            defects: [
                { path: "evidence[0]", message: "a" },
                { path: "evidence[2]", message: "b" },
            ],
        })
        assert.deepEqual(contractDefects(error), [
            { path: "evidence[0]", message: "a" },
            { path: "evidence[2]", message: "b" },
        ])
    })

    // Validators that were never converted still reach the repair prompt.
    it("synthesises one defect from a plain error or a thrown non-error", () => {
        assert.deepEqual(contractDefects(new Error("plain")), [{ path: "", message: "plain" }])
        assert.deepEqual(contractDefects("boom"), [{ path: "", message: "boom" }])
        assert.deepEqual(
            contractDefects(Object.assign(new Error("empty"), { defects: [] })),
            [{ path: "", message: "empty" }],
        )
    })

    it("names the flavor by the path segment before the first index or field", () => {
        assert.equal(defectFlavor({ path: "obligations[0].evidence[3]", message: "" }), "obligations")
        assert.equal(defectFlavor({ path: "questions[1].reason", message: "" }), "questions")
        assert.equal(defectFlavor({ path: "constraintPredicates", message: "" }), "constraintPredicates")
        assert.equal(defectFlavor({ path: "", message: "" }), "outcome")
    })

    it("formats one line per defect and omits the prefix for a top-level path", () => {
        assert.equal(
            formatDefectList([
                { path: "questions[1].reason", message: "must be a string" },
                { path: "", message: "kind must be ready or needsInput" },
            ]),
            "- questions[1].reason: must be a string\n- kind must be ready or needsInput",
        )
    })

    // A model that echoes a whole document back must not blow the prompt out.
    it("truncates each message to 400 characters and the block to 4000", () => {
        const line = formatDefectList([{ path: "e[0]", message: "x".repeat(500) }])
        assert.equal(line, `- e[0]: ${"x".repeat(400)}`)

        const many = Array.from({ length: 40 }, (_unused, index) => ({
            path: `evidence[${index}]`,
            message: "y".repeat(500),
        }))
        assert.equal(formatDefectList(many).length, 4000)
    })

    // One defect must reproduce the pre-accumulation message exactly.
    it("joins defect messages with a semicolon", () => {
        assert.equal(joinDefectMessages([{ path: "c[0]", message: "only" }]), "only")
        assert.equal(
            joinDefectMessages([
                { path: "c[0]", message: "first" },
                { path: "c[1]", message: "second" },
            ]),
            "first; second",
        )
        assert.equal(joinDefectMessages([]), "")
    })
})
