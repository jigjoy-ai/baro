import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Conductor } from "../../src/participants/conductor.js"
import type { PrdFile } from "../../src/prd.js"
import {
    LevelCompleted,
    LevelStarted,
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
