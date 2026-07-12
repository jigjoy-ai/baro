import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type {
    AgenticEnvironment,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    StoryResult,
    StorySpawnRequest,
    StorySpawned,
} from "../src/semantic-events.js"
import { StoryFactory } from "../src/participants/story-factory.js"
import { LocalStoryExecutor } from "../src/participants/story-executor.js"
import type {
    StoryExecOpts,
    StoryExecution,
    StoryExecutor,
} from "../src/participants/story-executor.js"
import type { StoryRoute } from "../src/routing.js"

function source(id: string): Participant {
    return { agentId: id } as unknown as Participant
}

function spawn(storyId: string, model = "sonnet") {
    return StorySpawnRequest.create({
        storyId,
        prompt: "do it",
        model,
        retries: 1,
        timeoutSecs: 60,
    })
}

function settle(storyId: string) {
    return StoryResult.create({
        storyId,
        success: true,
        attempts: 1,
        durationSecs: 1,
        error: null,
    })
}

describe("StoryFactory — StoryExecutor seam", () => {
    it("delegates to the injected executor and disposes the execution on StoryResult", async () => {
        const starts: Array<{ storyId: string; route: StoryRoute; cwd: string; opts: StoryExecOpts }> = []
        const disposed: string[] = []

        // An out-of-process-style executor: records the dispatch instead of
        // running an agent in-process. The factory can't tell the difference.
        const fake: StoryExecutor = {
            start(req, route, cwd, _env, opts): StoryExecution {
                starts.push({ storyId: req.storyId, route, cwd, opts })
                return { dispose: () => disposed.push(req.storyId) }
            },
        }

        const delivered: SemanticEvent<unknown>[] = []
        const env = {
            deliverSemanticEvent: (_s: unknown, e: SemanticEvent<unknown>) => {
                delivered.push(e)
            },
        } as unknown as AgenticEnvironment

        const factory = new StoryFactory({ cwd: "/work", executor: fake })
        factory.setEnvironment(env)

        await factory.onExternalEvent(source("conductor"), spawn("S1"))

        assert.equal(starts.length, 1, "executor.start called once")
        assert.equal(starts[0].storyId, "S1")
        assert.equal(starts[0].cwd, "/work", "shared cwd passed when no worktrees")
        assert.ok(starts[0].route, "resolved route handed to the executor")
        assert.ok(
            delivered.some((e) => StorySpawned.is(e)),
            "StorySpawned emitted for observers",
        )

        // A duplicate spawn for the same story is ignored (idempotent).
        await factory.onExternalEvent(source("conductor"), spawn("S1"))
        assert.equal(starts.length, 1, "duplicate spawn does not start twice")

        // When the story settles, the execution is disposed and forgotten.
        await factory.onExternalEvent(source("S1"), settle("S1"))
        assert.deepEqual(disposed, ["S1"], "execution disposed on StoryResult")
    })

    it("defaults to LocalStoryExecutor when none is injected", () => {
        const factory = new StoryFactory({ cwd: "/work" })
        const executor = (factory as unknown as { executor: unknown }).executor
        assert.ok(
            executor instanceof LocalStoryExecutor,
            "wires the in-process executor by default",
        )
    })

    it("LocalStoryExecutor registers the concrete agent before join/run", () => {
        const executor = new LocalStoryExecutor()
        const env = {} as AgenticEnvironment
        let registered: Participant | null = null

        assert.throws(
            () => executor.start(
                {
                    storyId: "S-local",
                    prompt: "do not run",
                    model: "sonnet",
                    retries: 0,
                    timeoutSecs: 1,
                    runId: "run-local",
                    leaseId: "lease-local",
                    generation: 1,
                },
                { backend: "claude", model: "sonnet" },
                "/work",
                env,
                {
                    registerResultAuthority: (sourceParticipant) => {
                        registered = sourceParticipant
                        assert.equal(sourceParticipant.agentId, "S-local")
                        assert.equal(
                            (sourceParticipant as unknown as {
                                resultAuthority: Participant
                            }).resultAuthority,
                            sourceParticipant,
                        )
                        throw new Error("stop before join")
                    },
                },
            ),
            /stop before join/,
        )
        assert.ok(registered)
    })

    it("LocalStoryExecutor forwards correlated runtime replan context to OpenAI", () => {
        const executor = new LocalStoryExecutor()
        const env = {} as AgenticEnvironment
        const board = source("collective-board")
        let inspected = false

        assert.throws(
            () =>
                executor.start(
                    {
                        storyId: "S-openai",
                        prompt: "do not run",
                        model: "fake-model",
                        retries: 0,
                        timeoutSecs: 1,
                        runId: "run-openai",
                        leaseId: "lease-openai",
                        generation: 4,
                        graphVersion: 9,
                    },
                    { backend: "openai", model: "fake-model" },
                    "/work",
                    env,
                    {
                        runtimeReplanDecisionAuthority: board,
                        runtimeReplanDecisionTimeoutMs: 1_234,
                        registerResultAuthority: (participant) => {
                            const agent = participant as unknown as {
                                spec: {
                                    runId?: string
                                    leaseId?: string
                                    generation?: number
                                    graphVersion?: number
                                }
                                opts: {
                                    runtimeReplanDecisionAuthority: Participant
                                    runtimeReplanDecisionTimeoutMs: number
                                }
                                tools: Array<{ name: string; strict?: boolean }>
                            }
                            assert.deepEqual(
                                {
                                    runId: agent.spec.runId,
                                    leaseId: agent.spec.leaseId,
                                    generation: agent.spec.generation,
                                    graphVersion: agent.spec.graphVersion,
                                },
                                {
                                    runId: "run-openai",
                                    leaseId: "lease-openai",
                                    generation: 4,
                                    graphVersion: 9,
                                },
                            )
                            assert.equal(
                                agent.opts.runtimeReplanDecisionAuthority,
                                board,
                            )
                            assert.equal(
                                agent.opts.runtimeReplanDecisionTimeoutMs,
                                1_234,
                            )
                            assert.equal(
                                agent.tools.some(
                                    (tool) =>
                                        tool.name === "propose_replan" &&
                                        tool.strict === true,
                                ),
                                true,
                            )
                            inspected = true
                            throw new Error("stop before join")
                        },
                    },
                ),
            /stop before join/,
        )
        assert.equal(inspected, true)
    })
})
