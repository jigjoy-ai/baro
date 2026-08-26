import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import {
    RESUME_WITHOUT_STATUS_WARNING,
    selectResumeStories,
} from "../../src/execution/resume-selection.js"
import { orchestrate } from "../../src/orchestrate.js"
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

const temporaryRoots: string[] = []

after(() => {
    for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function prdFileWith(...stories: Partial<PrdStory>[]): string {
    const root = mkdtempSync(join(tmpdir(), "resume-selection-"))
    temporaryRoots.push(root)
    const path = join(root, "prd.json")
    writeFileSync(path, JSON.stringify(prdWith(...stories), null, 2))
    return path
}

/**
 * The orchestrate notices a run prints before it starts.
 *
 * orchestrate() rejects collective Operator control hooks before any
 * participant joins the bus, so this reaches the resume decision — which runs
 * first — without starting a run, touching git, or spawning an agent.
 */
async function orchestrateNotices(resumeRun: boolean, prdPath: string): Promise<string[]> {
    const lines: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof chunk === "string" && chunk.startsWith("[orchestrate] ")) {
            lines.push(chunk.trimEnd())
        }
        return (original as (...a: never[]) => boolean)(
            chunk as never,
            ...(rest as never[]),
        )
    }) as typeof process.stderr.write
    try {
        await assert.rejects(
            orchestrate({
                prdPath,
                cwd: "/not-read",
                coordinationMode: "collective",
                ...(resumeRun ? { resumeRun } : {}),
                operatorHooks: { onAbort: () => undefined },
            }),
            /control must cross a source-bound Mozaik semantic lane/,
        )
    } finally {
        process.stderr.write = original
    }
    return lines
}

describe("what a resumed run tells the operator", () => {
    it("warns exactly once when the plan on disk carries no status", async () => {
        const notices = await orchestrateNotices(true, prdFileWith({}, {}))

        assert.deepEqual(notices, [
            "[orchestrate] prd.json carries no per-story status; resuming with legacy behavior (all stories will be executed)",
        ])
    })

    it("reports what it skips instead of warning when the plan has status", async () => {
        const notices = await orchestrateNotices(
            true,
            prdFileWith(
                { passes: true, mergeStatus: "merged" },
                { mergeStatus: "failed" },
                {},
            ),
        )

        assert.equal(notices.length, 1)
        assert.doesNotMatch(notices[0]!, /no per-story status/)
        assert.match(notices[0]!, /skipping 1 finished story\(ies\), executing 2/)
    })

    it("says nothing about resuming when the run is not a resume", async () => {
        assert.deepEqual(await orchestrateNotices(false, prdFileWith({}, {})), [])
    })
})
