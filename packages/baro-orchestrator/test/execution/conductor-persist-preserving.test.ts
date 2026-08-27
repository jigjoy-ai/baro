import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Conductor } from "../../src/execution/conductor.js"
import type { PrdFile } from "../../src/prd.js"
import {
    RunStartRequest,
    StoryResult,
    StorySpawnRequest,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

/**
 * `oneStoryPrd` is module-private to conductor.test.ts, which this story may
 * not edit, so the fixture is rebuilt here rather than imported.
 */
function oneStoryPrd(): PrdFile {
    return {
        project: "Conductor persist preservation",
        branchName: "conductor-persist-preserving",
        description: "Exercise the default persistPrd seam.",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Implement conductor coverage",
                description: "Add a unit test for Conductor.",
                dependsOn: [],
                retries: 2,
                acceptance: ["Conductor emits lifecycle events"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: "opus",
            },
        ],
    }
}

function passResult(storyId: string) {
    return StoryResult.create({
        storyId,
        success: true,
        attempts: 1,
        durationSecs: 1,
        error: null,
    })
}

async function waitForEvents<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const found = events.filter(guard)
        if (found.length >= count) return found
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.fail("timed out waiting for semantic events")
}

/** Raw read-back: `loadPrd` would strip `goalFingerprint` and pass vacuously. */
function readRaw(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

function storyOnDisk(path: string, storyId: string): Record<string, unknown> {
    const stories = readRaw(path).userStories as Record<string, unknown>[]
    const story = stories.find((entry) => entry.id === storyId)
    assert.ok(story, `story '${storyId}' missing from disk`)
    return story
}

/**
 * Drive the conductor to the point where it holds a loaded snapshot, then let
 * the caller mutate the file underneath it before the story pass is recorded.
 */
async function runStoryPass(
    dir: string,
    prdPath: string,
    beforePass: () => void,
): Promise<void> {
    const conductor = new Conductor({
        prdPath,
        cwd: dir,
        parallel: 1,
        timeoutSecs: 45,
        defaultModel: "sonnet",
        intraLevelDelaySecs: 0,
        // persistPrd deliberately unset: this exercises the real default.
    })
    const env = joinWithCapture(conductor)

    env.deliverSemanticEvent(
        source("operator"),
        RunStartRequest.create({ reason: "unit test" }),
    )
    await waitForEvents(env.events, StorySpawnRequest.is, 1)

    beforePass()

    env.deliverSemanticEvent(source("S1"), passResult("S1"))
    const summary = await conductor.done
    assert.equal(summary.success, true)
}

describe("Conductor.persistPrd default preserves foreign-owned fields", () => {
    it("keeps per-story mergeStatus/mergeCommitSha already present at load time", async () => {
        await withTempDir("conductor-persist-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const prd = oneStoryPrd() as PrdFile & { goalFingerprint?: string }
            prd.goalFingerprint = "rust-stamp-abc123"
            prd.userStories[0] = {
                ...prd.userStories[0]!,
                mergeStatus: "merged",
                mergeCommitSha: "deadbeef",
            }
            writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")

            await runStoryPass(dir, prdPath, () => {})

            const story = storyOnDisk(prdPath, "S1")
            assert.equal(story.mergeStatus, "merged")
            assert.equal(story.mergeCommitSha, "deadbeef")
            assert.equal(story.passes, true)
            // Rust-owned stamp: not a member of PrdFile, so a non-preserving
            // write would have dropped it on the conductor's own persist.
            assert.equal(readRaw(prdPath).goalFingerprint, "rust-stamp-abc123")
        })
    })

    it("does not clobber merge fields written to disk after its snapshot was loaded", async () => {
        await withTempDir("conductor-persist-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const prd = oneStoryPrd() as PrdFile & { goalFingerprint?: string }
            prd.goalFingerprint = "rust-stamp-abc123"
            writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")

            await runStoryPass(dir, prdPath, () => {
                // The lost update this story exists to close: the field owner
                // records the merge AFTER the conductor loaded its snapshot,
                // so the snapshot the conductor is about to persist has
                // neither field. Written raw, exactly as the owner leaves it.
                const raw = readRaw(prdPath)
                const stories = raw.userStories as Record<string, unknown>[]
                stories[0]!.mergeStatus = "merged"
                stories[0]!.mergeCommitSha = "cafebabe"
                writeFileSync(prdPath, JSON.stringify(raw, null, 2) + "\n")
            })

            const story = storyOnDisk(prdPath, "S1")
            assert.equal(story.mergeStatus, "merged")
            assert.equal(story.mergeCommitSha, "cafebabe")
            assert.equal(story.passes, true)
            assert.equal(readRaw(prdPath).goalFingerprint, "rust-stamp-abc123")
        })
    })

    it("still lets an embedder override the persistence seam", async () => {
        await withTempDir("conductor-persist-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const seen: string[] = []
            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                persistPrd: (path: string, prd: PrdFile) => {
                    seen.push(path)
                    writeFileSync(path, JSON.stringify(prd, null, 2) + "\n")
                },
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )
            await waitForEvents(env.events, StorySpawnRequest.is, 1)
            env.deliverSemanticEvent(source("S1"), passResult("S1"))
            await conductor.done

            assert.deepEqual(seen, [prdPath])
        })
    })
})
