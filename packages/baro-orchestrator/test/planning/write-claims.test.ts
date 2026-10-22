import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { PrdStory } from "../../src/prd.js"
import {
    disjointWidthEvidence,
    writeSurfaceOf,
} from "../../src/planning/domain/dependency-evidence.js"
import {
    conflictingWritePaths,
    parseWriteEntry,
    sharedWritePaths,
    writeClaimsOf,
    writeEntriesOf,
} from "../../src/planning/domain/write-claims.js"

const VERIFY = "packages/baro-orchestrator/src/verification/verify.ts"

function story(id: string, writes?: string[], dependsOn: string[] = []): PrdStory {
    return {
        id,
        priority: 1,
        title: id,
        description: "",
        dependsOn,
        retries: 1,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        ...(writes ? { writes } : {}),
    } as PrdStory
}

describe("a writes entry may name a region of a file", () => {
    it("parses path#region and normalizes the path", () => {
        assert.deepEqual(parseWriteEntry("./src/a.ts#resolveCwd"), {
            path: "src/a.ts",
            region: "resolveCwd",
        })
        assert.deepEqual(parseWriteEntry(" src/a.ts "), { path: "src/a.ts", region: null })
        assert.deepEqual(parseWriteEntry("src/a.ts#  "), { path: "src/a.ts", region: null })
    })

    it("lets a bare path absorb the regions declared beside it", () => {
        const claims = writeClaimsOf(story("S1", ["src/a.ts#one", "src/a.ts", "src/b.ts#two"]))
        assert.equal(claims.get("src/a.ts"), null)
        assert.deepEqual([...claims.get("src/b.ts")!], ["two"])
        assert.deepEqual(writeEntriesOf(story("S1", ["src/a.ts#one", "src/a.ts"])), ["src/a.ts"])
    })

    it("keeps every path consumer on plain paths", () => {
        assert.deepEqual(
            writeSurfaceOf(story("S1", [`${VERIFY}#planDeclared`, `${VERIFY}#budget`, "src/x.ts"])),
            [VERIFY, "src/x.ts"],
        )
    })
})

describe("which shared files two stories cannot both hold", () => {
    it("admits disjoint regions of one file", () => {
        const a = story("S1", [`${VERIFY}#planDeclared`])
        const b = story("S2", [`${VERIFY}#resolveCwd`])
        assert.deepEqual(conflictingWritePaths(a, b), [])
        assert.deepEqual(sharedWritePaths(a, b), [VERIFY])
    })

    it("refuses the same region claimed twice", () => {
        const a = story("S1", [`${VERIFY}#planDeclared`, `${VERIFY}#retry`])
        const b = story("S2", [`${VERIFY}#retry`])
        assert.deepEqual(conflictingWritePaths(a, b), [VERIFY])
    })

    it("refuses a whole-file claim against any region", () => {
        assert.deepEqual(
            conflictingWritePaths(story("S1", [VERIFY]), story("S2", [`${VERIFY}#retry`])),
            [VERIFY],
        )
        assert.deepEqual(
            conflictingWritePaths(story("S1", [`${VERIFY}#retry`]), story("S2", [VERIFY])),
            [VERIFY],
        )
    })
})

describe("width evidence counts region-disjoint siblings as disjoint", () => {
    // Run harness-3: #167, #168 and #170 all edited verify.ts in different
    // functions and were chained S1 → S2 → S3, taking the run from ~25 to ~70 min.
    it("proves the three verify.ts siblings independent", () => {
        const evidence = disjointWidthEvidence([
            story("S1", [`${VERIFY}#admitDeclaredCommands`]),
            story("S2", [`${VERIFY}#resolveVerificationCwd`]),
            story("S3", [`${VERIFY}#shouldRetryOnFailureTail`]),
        ])
        assert.equal(evidence.proven, true)
        assert.deepEqual(evidence.conflicts, [])
    })

    it("still reports a bare shared path as a conflict", () => {
        const evidence = disjointWidthEvidence([
            story("S1", [VERIFY]),
            story("S2", [`${VERIFY}#resolveVerificationCwd`]),
        ])
        assert.equal(evidence.proven, false)
        assert.deepEqual(evidence.conflicts, [{ a: "S1", b: "S2", path: VERIFY }])
    })
})
