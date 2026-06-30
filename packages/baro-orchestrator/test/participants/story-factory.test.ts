import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

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
import type { WorktreeManager } from "../../src/worktree.js"
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
    public disposeCalls: AgenticEnvironment[] = []

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
                this.disposeCalls.push(disposeEnv)
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

    it("deduplicates active spawns and disposes only the completed story execution", async () => {
        await withTempDir("story-factory-test-", async (dir) => {
            const executor = new CapturingExecutor()
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "codex",
            })
            const env = joinWithCapture(factory)
            const spawn = StorySpawnRequest.create({
                storyId: "S2",
                prompt: "Implement S2",
                model: "gpt-5.5",
                retries: 2,
                timeoutSecs: 60,
            })

            await factory.onExternalEvent(source("conductor"), spawn)
            await factory.onExternalEvent(source("conductor"), spawn)

            assert.equal(executor.calls.length, 1)
            assert.deepEqual(executor.calls[0].route, {
                backend: "codex",
                model: "gpt-5.5",
            })
            assert.equal(env.events.filter(StorySpawned.is).length, 1)

            await factory.onExternalEvent(
                source("S3"),
                StoryResult.create({
                    storyId: "S3",
                    success: true,
                    attempts: 1,
                    durationSecs: 2,
                    error: null,
                }),
            )
            assert.equal(executor.disposeCalls.length, 0)

            await factory.onExternalEvent(
                source("S2"),
                StoryResult.create({
                    storyId: "S2",
                    success: false,
                    attempts: 2,
                    durationSecs: 8,
                    error: "failed",
                }),
            )
            await factory.onExternalEvent(
                source("S2"),
                StoryResult.create({
                    storyId: "S2",
                    success: false,
                    attempts: 2,
                    durationSecs: 8,
                    error: "duplicate result",
                }),
            )

            assert.deepEqual(executor.disposeCalls, [env])
        })
    })

    it("uses an in-progress marker so duplicate spawn requests share one worktree create", async () => {
        await withTempDir("story-factory-test-", async (dir) => {
            const executor = new CapturingExecutor()
            let releaseCreate!: (path: string | null) => void
            const createCalls: string[] = []
            const worktrees = {
                create: (storyId: string) => {
                    createCalls.push(storyId)
                    return new Promise<string | null>((resolve) => {
                        releaseCreate = resolve
                    })
                },
            } as unknown as WorktreeManager
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "claude",
                worktrees,
            })
            joinWithCapture(factory)
            const spawn = StorySpawnRequest.create({
                storyId: "S3",
                prompt: "Implement S3",
                model: "sonnet",
                retries: 1,
                timeoutSecs: 30,
            })

            const first = factory.onExternalEvent(source("conductor"), spawn)
            const second = factory.onExternalEvent(source("conductor"), spawn)
            await Promise.resolve()

            assert.deepEqual(createCalls, ["S3"])
            releaseCreate(join(dir, "S3-worktree"))
            await Promise.all([first, second])

            assert.equal(executor.calls.length, 1)
            assert.equal(executor.calls[0].cwd, join(dir, "S3-worktree"))
        })
    })
})
