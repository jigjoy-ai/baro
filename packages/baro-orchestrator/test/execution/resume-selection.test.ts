import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    RESUME_WITHOUT_STATUS_WARNING,
    selectResumeStories,
} from "../../src/execution/resume-selection.js"
import { normalizePrd, type PrdStory } from "../../src/prd.js"

function prdWith(...stories: Partial<PrdStory>[]) {
    return normalizePrd(
        {
            project: "p",
            branchName: "baro/p",
            description: "d",
            userStories: stories.map((overrides, index) => ({
                id: `S${index + 1}`,
                priority: 0,
                title: `S${index + 1}`,
                description: "",
                dependsOn: [],
                retries: 1,
                acceptance: [],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                ...overrides,
            })),
        },
        "test",
    )
}

describe("what a resumed run still has to do", () => {
    it("skips what landed and keeps what did not", () => {
        const selection = selectResumeStories(
            prdWith(
                { passes: true, mergeStatus: "merged", mergeCommitSha: "sha-1" },
                { mergeStatus: "failed" },
                {},
            ),
        )

        assert.equal(selection.mode, "statuses")
        assert.deepEqual(selection.skipped, ["S1"])
        assert.deepEqual(
            selection.remaining.map((s) => s.id),
            ["S2", "S3"],
            "a failed merge is unfinished work, so resume retries it",
        )
        assert.equal(selection.warning, undefined)
    })

    it("treats a merged story as finished even without passes", () => {
        const selection = selectResumeStories(
            prdWith({ mergeStatus: "merged" }, {}),
        )

        assert.equal(selection.mode, "statuses")
        assert.deepEqual(selection.skipped, ["S1"])
        assert.deepEqual(selection.remaining.map((s) => s.id), ["S2"])
    })

    it("treats a passed story as finished even without a merge status", () => {
        const selection = selectResumeStories(prdWith({ passes: true }, {}))

        assert.equal(selection.mode, "statuses")
        assert.deepEqual(selection.skipped, ["S1"])
        assert.deepEqual(selection.remaining.map((s) => s.id), ["S2"])
    })

    it("re-runs everything, and says why, when the PRD carries no status", () => {
        const selection = selectResumeStories(prdWith({}, {}))

        assert.equal(selection.mode, "legacy")
        assert.deepEqual(selection.skipped, [])
        assert.deepEqual(selection.remaining.map((s) => s.id), ["S1", "S2"])
        assert.equal(
            selection.warning,
            "prd.json carries no per-story status; resuming with legacy behavior (all stories will be executed)",
        )
        assert.equal(selection.warning, RESUME_WITHOUT_STATUS_WARNING)
    })

    it("reports a plan with no stories as legacy rather than complete", () => {
        const selection = selectResumeStories(prdWith())

        assert.equal(selection.mode, "legacy")
        assert.deepEqual(selection.remaining, [])
        assert.equal(selection.warning, RESUME_WITHOUT_STATUS_WARNING)
    })

    it("leaves nothing to run when every story landed", () => {
        const selection = selectResumeStories(
            prdWith({ passes: true }, { mergeStatus: "merged" }),
        )

        assert.equal(selection.mode, "statuses")
        assert.deepEqual(selection.skipped, ["S1", "S2"])
        assert.deepEqual(selection.remaining, [])
    })

    it("does not mutate the PRD it was handed", () => {
        const prd = prdWith({ passes: true }, {})
        const before = JSON.stringify(prd)

        selectResumeStories(prd)

        assert.equal(JSON.stringify(prd), before)
    })
})
