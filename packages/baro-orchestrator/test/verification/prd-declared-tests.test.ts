import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { readAuthoritativeVerifyPlanOptions } from "../../src/verification/prd-declared-tests.js"

function prdFile(prd: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "prd-declared-"))
    const path = join(dir, "prd.json")
    writeFileSync(path, JSON.stringify(prd))
    return path
}

const story = (id: string, tests: string[], extra: Record<string, unknown> = {}) => ({
    id,
    title: id,
    tests,
    ...extra,
})

describe("readAuthoritativeVerifyPlanOptions", () => {
    it("keeps every story's tests when the PRD has no progressive admission ledger", () => {
        const path = prdFile({
            userStories: [story("S1", ["npm test -- a"]), story("S2", ["npm test -- b"])],
        })
        const options = readAuthoritativeVerifyPlanOptions(path)
        assert.deepEqual(
            options.declaredTests.map((t) => t.storyId),
            ["S1", "S2"],
        )
        assert.deepEqual(options.notStartedStoryIds, [])
    })

    it("drops a story the planner never admitted and reports it as not started (#175)", () => {
        const path = prdFile({
            userStories: [
                story("S1", ["npm test -- a"], { passes: true, mergeStatus: "merged" }),
                story("S3", ["npm test -- c"], { passes: false }),
                story("S6", ["node --test test/never-created.test.ts"], { passes: false }),
            ],
            runtimeGraph: { planning: { admittedStoryIds: ["S1", "S3"] } },
        })
        const options = readAuthoritativeVerifyPlanOptions(path)
        assert.deepEqual(
            options.declaredTests.map((t) => t.storyId),
            ["S1", "S3"],
        )
        assert.deepEqual(options.notStartedStoryIds, ["S6"])
    })

    it("never drops a story that executed, even when the ledger does not list it", () => {
        const path = prdFile({
            userStories: [
                story("S7", ["npm test -- d"], { passes: true }),
                story("S8", ["npm test -- e"], { mergeStatus: "failed" }),
                story("S9", ["npm test -- f"], { completedAt: "2026-09-20T10:00:00.000Z" }),
            ],
            runtimeGraph: { planning: { admittedStoryIds: [] } },
        })
        const options = readAuthoritativeVerifyPlanOptions(path)
        assert.deepEqual(
            options.declaredTests.map((t) => t.storyId),
            ["S7", "S8", "S9"],
        )
        assert.deepEqual(options.notStartedStoryIds, [])
    })

    it("still reports a malformed tests field of an admitted story as an objective unknown", () => {
        const path = prdFile({
            userStories: [{ id: "S1", title: "S1", tests: "not-an-array" }],
            runtimeGraph: { planning: { admittedStoryIds: ["S1"] } },
        })
        const options = readAuthoritativeVerifyPlanOptions(path)
        assert.equal(options.declaredTests.length, 1)
        assert.equal(options.declaredTests[0]?.storyId, "S1")
    })
})
