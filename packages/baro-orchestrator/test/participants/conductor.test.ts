import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Conductor } from "../../src/participants/conductor.js"
import type { PrdFile } from "../../src/prd.js"
import {
    LevelCompleted,
    LevelStarted,
    RecoveryStarted,
    RunCompleted,
    RunStartRequest,
    RunStarted,
    StoryResult,
    StorySpawnRequest,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("Conductor", () => {
    it("emits run, level, spawn, and completion events for a passing story", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )

            const spawn = await waitForEvent(env.events, StorySpawnRequest.is)
            assert.equal(RunStarted.is(env.events.find(RunStarted.is)!), true)
            assert.deepEqual(env.events.find(RunStarted.is)?.data, {
                project: "Participant Tests",
                storyCount: 1,
            })
            assert.deepEqual(env.events.find(LevelStarted.is)?.data, {
                ordinal: 1,
                totalLevelsHint: 1,
                storyIds: ["S1"],
            })
            assert.equal(spawn.data.storyId, "S1")
            assert.equal(spawn.data.model, "opus")
            assert.equal(spawn.data.retries, 2)
            assert.equal(spawn.data.timeoutSecs, 45)
            assert.match(spawn.data.prompt, /Implement conductor coverage/)

            env.deliverSemanticEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: true,
                    attempts: 2,
                    durationSecs: 7,
                    error: null,
                }),
            )

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.deepEqual(env.events.find(LevelCompleted.is)?.data, {
                ordinal: 1,
                passed: ["S1"],
                failed: [],
            })
            assert.equal(completed.data.success, true)
            assert.deepEqual(completed.data.completedStories, ["S1"])
            assert.deepEqual(completed.data.failedStories, [])
            assert.equal(completed.data.totalAttempts, 2)
            assert.equal(completed.data.abortReason, null)

            const savedPrd = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(savedPrd.userStories[0]?.passes, true)
            assert.equal(savedPrd.userStories[0]?.durationSecs, 7)
        })
    })

    it("runs the recovery lifecycle once and completes failed when the story still fails", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const failedStories: string[] = []
            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                onStoryFailed: (storyId) => failedStories.push(storyId),
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )

            await waitForEvent(env.events, StorySpawnRequest.is)
            env.deliverSemanticEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: false,
                    attempts: 1,
                    durationSecs: 3,
                    error: "first failure",
                }),
            )

            await waitForEvents(env.events, StorySpawnRequest.is, 2)
            env.deliverSemanticEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: false,
                    attempts: 2,
                    durationSecs: 5,
                    error: "still failing",
                }),
            )

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, false)
            assert.deepEqual(completed.data.completedStories, [])
            assert.deepEqual(completed.data.failedStories, ["S1"])
            assert.equal(completed.data.totalAttempts, 3)
            assert.equal(
                completed.data.abortReason,
                "all stories in level failed; aborting remaining levels",
            )
            assert.deepEqual(failedStories, ["S1", "S1"])

            const levelEvents = env.events.filter(LevelStarted.is)
            assert.equal(levelEvents.length, 2)
            assert.deepEqual(levelEvents.map((event) => event.data.ordinal), [1, 2])

            const recoveries = env.events.filter(RecoveryStarted.is)
            assert.equal(recoveries.length, 1)
            assert.deepEqual(recoveries[0].data, { attempt: 1, storyIds: ["S1"] })

            const savedPrd = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(savedPrd.userStories[0]?.passes, false)
            assert.equal(savedPrd.userStories[0]?.durationSecs, null)
        })
    })
})

function oneStoryPrd(): PrdFile {
    return {
        project: "Participant Tests",
        branchName: "participant-tests",
        description: "Exercise conductor semantic events.",
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

async function waitForEvent<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const event = events.find(guard)
        if (event) return event
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.fail("timed out waiting for semantic event")
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
