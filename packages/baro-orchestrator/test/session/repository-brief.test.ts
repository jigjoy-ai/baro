import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    MAX_REPOSITORY_BRIEF_BYTES,
    validateRepositoryBriefV1,
} from "../../src/session/repository-brief.js"

describe("RepositoryBriefV1", () => {
    it("copies and deeply freezes the exact bounded contract", () => {
        const source = validBrief()
        const result = validateRepositoryBriefV1(source)

        source.summary = "mutated"
        source.facts[0]!.statement = "mutated"
        assert.equal(result.summary, "Bounded repository evidence.")
        assert.equal(result.facts[0]?.statement, "The goal term appears here.")
        assert.equal(Object.isFrozen(result), true)
        assert.equal(Object.isFrozen(result.facts), true)
        assert.equal(Object.isFrozen(result.facts[0]), true)
        assert.equal(Object.isFrozen(result.relevantPaths), true)
    })

    it("rejects source-forged shapes and unsafe evidence paths", () => {
        assert.throws(
            () => validateRepositoryBriefV1({ ...validBrief(), authority: "model" }),
            /exact v1 schema/,
        )
        for (const evidencePath of [
            "/etc/passwd",
            "../secret.txt",
            "src/../../secret.txt",
            "src\\secret.ts",
            "src//secret.ts",
            "./src/index.ts",
            "C:secret.ts",
            "src/safe:secret.txt",
            "src/NUL.txt",
            "src/trailing-dot./file.ts",
            "src/trailing-space /file.ts",
        ]) {
            const candidate = validBrief()
            candidate.facts[0]!.evidencePath = evidencePath
            assert.throws(
                () => validateRepositoryBriefV1(candidate),
                /evidence path/,
                evidencePath,
            )
        }
    })

    it("rejects bidi controls in model-authored display text", () => {
        for (const mutate of [
            (candidate: ReturnType<typeof validBrief>) => {
                candidate.summary = "safe\u202Etxt"
            },
            (candidate: ReturnType<typeof validBrief>) => {
                candidate.facts[0]!.statement = "safe\u2066fact"
            },
            (candidate: ReturnType<typeof validBrief>) => {
                candidate.unknowns[0] = "safe\u202Aunknown"
            },
        ]) {
            const candidate = validBrief()
            mutate(candidate)
            assert.throws(
                () => validateRepositoryBriefV1(candidate),
                /unsafe/,
            )
        }
    })

    it("enforces the final 64 KiB UTF-8 envelope bound", () => {
        const candidate = validBrief()
        candidate.summary = "s".repeat(7_900)
        candidate.facts = Array.from({ length: 32 }, (_, index) => ({
            statement: `${index}:${"x".repeat(1_980)}`,
            evidencePath: `src/file-${index}.ts`,
            confidence: "medium" as const,
        }))
        assert.ok(
            Buffer.byteLength(JSON.stringify(candidate), "utf8") >
                MAX_REPOSITORY_BRIEF_BYTES,
        )
        assert.throws(
            () => validateRepositoryBriefV1(candidate),
            /exceeds 65536 UTF-8 bytes/,
        )
    })
})

function validBrief() {
    return {
        schemaVersion: 1 as const,
        snapshotId: `sha256:${"a".repeat(64)}`,
        summary: "Bounded repository evidence.",
        facts: [{
            statement: "The goal term appears here.",
            evidencePath: "src/index.ts",
            line: 7,
            confidence: "high" as const,
        }],
        relevantPaths: ["src/index.ts"],
        unknowns: ["Runtime behavior was not executed."],
        truncated: false,
    }
}
