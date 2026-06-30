import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type { AgenticEnvironment } from "@mozaik-ai/core"

import { StoryFactory } from "../../src/participants/story-factory.js"
import type {
    StoryExecution,
    StoryExecOpts,
    StoryExecutor,
} from "../../src/participants/story-executor.js"
import type { StoryRoute } from "../../src/routing.js"
import {
    StoryResult,
    StorySpawnRequest,
    StorySpawned,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

class CapturingExecutor implements StoryExecutor {
    public calls: Array<{
        req: StorySpawnRequestData
        route: StoryRoute
        cwd: string
        env: AgenticEnvironment
        opts: StoryExecOpts
    }> = []
    public disposedWith: AgenticEnvironment | null = null

    start(
        req: StorySpawnRequestData,
        route: StoryRoute,
        cwd: string,
        env: AgenticEnvironment,
        opts: StoryExecOpts,
    ): StoryExecution {
        this.calls.push({ req, route, cwd, env, opts })
        return {
            dispose: (disposeEnv) => {
                this.disposedWith = disposeEnv
            },
        }
    }
}

describe("StoryFactory", () => {
    it("starts an executor for spawn requests and emits story_spawned", async () => {
        await withTempDir("story-factory-test-", async (dir) => {
            const executor = new CapturingExecutor()
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "claude",
            })
            const env = joinWithCapture(factory)
            const spawn = StorySpawnRequest.create({
                storyId: "S1",
                prompt: "Implement S1",
                model: "sonnet",
                retries: 1,
                timeoutSecs: 30,
            })

            await factory.onExternalEvent(source("conductor"), spawn)

            assert.equal(executor.calls.length, 1)
            assert.deepEqual(executor.calls[0].req, spawn.data)
            assert.deepEqual(executor.calls[0].route, {
                backend: "claude",
                model: "sonnet",
            })
            assert.equal(executor.calls[0].cwd, dir)
            assert.equal(executor.calls[0].env, env)
            assert.deepEqual(executor.calls[0].opts, {
                openaiModel: undefined,
                effort: undefined,
            })

            const spawned = env.events.find(StorySpawned.is)
            assert.ok(spawned)
            assert.deepEqual(spawned.data, { storyId: "S1" })

            await factory.onExternalEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: true,
                    attempts: 1,
                    durationSecs: 4,
                    error: null,
                }),
            )

            assert.equal(executor.disposedWith, env)
        })
    })
})
