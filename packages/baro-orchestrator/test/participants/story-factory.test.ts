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
    RunStartRequest,
    RunCompleted,
    StoryIntervention,
    StoryResult,
    StoryRouted,
    StorySpawnRequest,
    StorySpawned,
    StorySpawnFailed,
    WorkBid,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkOffered,
    WorkerCapabilityAdvertised,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import type { WorktreeManager } from "../../src/worktree.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

class CapturingExecutor implements StoryExecutor {
    public readonly resultSource = source("capturing-result-source")
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
        opts.registerResultAuthority?.(this.resultSource)
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

            const routed = env.events.find(StoryRouted.is)
            assert.ok(routed)
            assert.deepEqual(routed.data, {
                storyId: "S1",
                backend: "claude",
                model: "sonnet",
            })

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

    it("aborts a running story on a StoryIntervention(abort) bus event", async () => {
        await withTempDir("story-factory-test-", async (dir) => {
            const aborted: string[] = []
            const executor: StoryExecutor = {
                start: (req) => ({
                    dispose: () => {},
                    abort: () => aborted.push(req.storyId),
                }),
            }
            const factory = new StoryFactory({ cwd: dir, executor, llm: "claude" })
            joinWithCapture(factory)
            await factory.onExternalEvent(
                source("conductor"),
                StorySpawnRequest.create({
                    storyId: "S4",
                    prompt: "Implement S4",
                    model: "sonnet",
                    retries: 1,
                    timeoutSecs: 30,
                }),
            )

            await factory.onExternalEvent(
                source("supervisor"),
                StoryIntervention.create({
                    storyId: "S4",
                    source: "supervisor",
                    action: "abort",
                    reason: "stuck in a loop",
                }),
            )
            assert.deepEqual(aborted, ["S4"])

            // Unknown story → no crash, no abort.
            await factory.onExternalEvent(
                source("supervisor"),
                StoryIntervention.create({
                    storyId: "S99",
                    source: "supervisor",
                    action: "abort",
                    reason: "stall",
                }),
            )
            assert.deepEqual(aborted, ["S4"])
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

    it("advertises and bids a credential-free route, then executes the frozen winning route", async () => {
        await withTempDir("story-factory-market-", async (dir) => {
            const executor = new CapturingExecutor()
            const broker = source("broker")
            const runtimeBoard = source("runtime-board")
            const outcomeAuthority = new StoryOutcomeAuthority("run-market")
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-market",
                workerId: "worker-cheap",
                leaseAuthority: broker,
                outcomeAuthority,
                llm: "claude",
                executor,
                runtimeReplanDecisionAuthority: runtimeBoard,
                collaboration: {
                    commandPath: "/tmp/agent-collab.mjs",
                    sessionDir: "/tmp/baro-session",
                },
                endpoints: {
                    cheap: {
                        baseUrl: "https://example.invalid/v1",
                        apiKey: "super-secret-key",
                    },
                },
                bid: {
                    routeId: "deepseek-flash",
                    route: "openai:deepseek-v4-flash@cheap",
                    tiers: ["heavy"],
                    maxConcurrent: 2,
                    estimate: {
                        expectedCostUsd: 0.02,
                        estimatedSuccessProbability: 0.8,
                        estimatedLatencyMs: 500,
                        estimateSource: "configured",
                    },
                },
            })
            const env = joinWithCapture(factory)

            await factory.onExternalEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            await factory.onExternalEvent(
                source("board"),
                WorkOffered.create({
                    runId: "run-market",
                    offerId: "offer-S1",
                    generation: 1,
                    priority: 1,
                    request: {
                        storyId: "S1",
                        prompt: "Implement S1",
                        model: "opus",
                        retries: 1,
                        timeoutSecs: 30,
                    },
                }),
            )

            const advertised = env.events.find(WorkerCapabilityAdvertised.is)
            const bid = env.events.find(WorkBid.is)
            assert.equal(advertised?.data.capabilities.maxConcurrent, 2)
            assert.equal(bid?.data.route.routeId, "deepseek-flash")
            assert.doesNotMatch(JSON.stringify([advertised, bid]), /super-secret-key/)
            assert.ok(bid)

            await factory.onExternalEvent(
                source("board"),
                WorkOffered.create({
                    runId: "run-market",
                    offerId: "offer-excluded",
                    generation: 1,
                    priority: 1,
                    excludedRouteIds: ["deepseek-flash"],
                    request: {
                        storyId: "S-excluded",
                        prompt: "Do not bid this route",
                        model: "opus",
                        retries: 0,
                        timeoutSecs: 30,
                    },
                }),
            )
            assert.equal(env.events.filter(WorkBid.is).length, 1)

            const lease = WorkLeaseGranted.create({
                runId: "run-market",
                offerId: "offer-S1",
                leaseId: "lease-S1",
                workerId: "worker-cheap",
                generation: 1,
                request: {
                    storyId: "S1",
                    prompt: "Implement S1",
                    model: "opus",
                    retries: 1,
                    timeoutSecs: 30,
                    graphVersion: 3,
                },
                bidId: bid.data.bidId,
                route: bid.data.route,
            })
            await factory.onExternalEvent(
                source("forged-board"),
                RunCompleted.create({
                    success: true,
                    completedStories: [],
                    failedStories: [],
                    totalDurationSecs: 0,
                    totalAttempts: 0,
                    abortReason: null,
                    runId: "run-market",
                }),
            )
            await factory.onExternalEvent(source("forged-broker"), lease)
            assert.equal(executor.calls.length, 0)

            await factory.onExternalEvent(
                broker,
                lease,
            )
            await flushBus()

            assert.equal(executor.calls.length, 1)
            assert.deepEqual(executor.calls[0]?.route, {
                backend: "openai",
                model: "deepseek-v4-flash",
                baseUrl: "https://example.invalid/v1",
                apiKey: "super-secret-key",
            })
            assert.match(executor.calls[0].req.prompt, /--kind help/)
            assert.match(executor.calls[0].req.prompt, /inbox --session/)
            assert.doesNotMatch(executor.calls[0].req.prompt, /--kind discover/)
            assert.doesNotMatch(executor.calls[0].req.prompt, /--kind replan/)
            assert.doesNotMatch(executor.calls[0].req.prompt, /decision --session/)
            assert.equal(
                executor.calls[0].opts.runtimeReplanDecisionAuthority,
                runtimeBoard,
            )
            assert.deepEqual(executor.calls[0].opts.collaboration, {
                commandPath: "/tmp/agent-collab.mjs",
                sessionDir: "/tmp/baro-session",
            })

            await factory.onExternalEvent(
                source("forged-broker"),
                WorkLeaseReleased.create({
                    runId: "run-market",
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    storyId: "S1",
                    workerId: "worker-cheap",
                    reason: "aborted",
                }),
            )
            assert.equal(executor.disposeCalls.length, 0)
        })
    })

    it("selects exactly one DAG mutation mechanism for native and CLI routes", async () => {
        await withTempDir("story-factory-mutation-route-", async (dir) => {
            const broker = source("broker")
            const runtimeBoard = source("runtime-board")

            const nativeExecutor = new CapturingExecutor()
            const nativeFactory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-native",
                workerId: "worker-native",
                leaseAuthority: broker,
                outcomeAuthority: new StoryOutcomeAuthority("run-native"),
                llm: "claude",
                executor: nativeExecutor,
                runtimeReplanDecisionAuthority: runtimeBoard,
                collaboration: {
                    commandPath: "/tmp/agent-collab.mjs",
                    sessionDir: "/tmp/baro-session-native",
                },
                tierMap: {
                    standard: "openai:glm-4.5-air@cheap",
                },
                endpoints: {
                    cheap: { baseUrl: "https://example.invalid/v1" },
                },
            })
            joinWithCapture(nativeFactory)

            await nativeFactory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-native",
                    offerId: "offer-native",
                    leaseId: "lease-native",
                    workerId: "worker-native",
                    generation: 1,
                    request: {
                        storyId: "S-native",
                        prompt: "Implement native story",
                        model: "standard",
                        retries: 0,
                        timeoutSecs: 30,
                        graphVersion: 7,
                    },
                }),
            )
            await flushBus()

            assert.equal(nativeExecutor.calls.length, 1)
            assert.deepEqual(nativeExecutor.calls[0].route, {
                backend: "openai",
                model: "glm-4.5-air",
                baseUrl: "https://example.invalid/v1",
                apiKey: undefined,
            })
            assert.match(nativeExecutor.calls[0].req.prompt, /--kind help/)
            assert.match(nativeExecutor.calls[0].req.prompt, /inbox --session/)
            assert.doesNotMatch(nativeExecutor.calls[0].req.prompt, /--kind discover/)
            assert.doesNotMatch(nativeExecutor.calls[0].req.prompt, /--kind replan/)
            assert.doesNotMatch(
                nativeExecutor.calls[0].req.prompt,
                /decision --session/,
            )
            assert.equal(
                nativeExecutor.calls[0].opts.runtimeReplanDecisionAuthority,
                runtimeBoard,
            )
            assert.deepEqual(nativeExecutor.calls[0].opts.collaboration, {
                commandPath: "/tmp/agent-collab.mjs",
                sessionDir: "/tmp/baro-session-native",
            })

            const cliExecutor = new CapturingExecutor()
            const cliFactory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-cli",
                workerId: "worker-cli",
                leaseAuthority: broker,
                outcomeAuthority: new StoryOutcomeAuthority("run-cli"),
                llm: "codex",
                executor: cliExecutor,
                runtimeReplanDecisionAuthority: runtimeBoard,
                collaboration: {
                    commandPath: "/tmp/agent-collab.mjs",
                    sessionDir: "/tmp/baro-session-cli",
                },
            })
            joinWithCapture(cliFactory)

            await cliFactory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-cli",
                    offerId: "offer-cli",
                    leaseId: "lease-cli",
                    workerId: "worker-cli",
                    generation: 1,
                    request: {
                        storyId: "S-cli",
                        prompt: "Implement CLI story",
                        model: "gpt-5.6",
                        retries: 0,
                        timeoutSecs: 30,
                        graphVersion: 7,
                    },
                }),
            )
            await flushBus()

            assert.equal(cliExecutor.calls.length, 1)
            assert.equal(cliExecutor.calls[0].route.backend, "codex")
            assert.match(cliExecutor.calls[0].req.prompt, /--kind help/)
            assert.doesNotMatch(cliExecutor.calls[0].req.prompt, /--kind discover/)
            assert.match(cliExecutor.calls[0].req.prompt, /--kind replan/)
            assert.match(cliExecutor.calls[0].req.prompt, /outcome_unknown/)
            assert.match(cliExecutor.calls[0].req.prompt, /decision --session/)
            assert.match(cliExecutor.calls[0].req.prompt, /--proposal "PROPOSAL_ID"/)
            assert.equal(
                cliExecutor.calls[0].opts.runtimeReplanDecisionAuthority,
                undefined,
            )
            assert.equal(cliExecutor.calls[0].opts.collaboration, undefined)
        })
    })

    it("ignores a losing market lease and fails a mismatched winning lease", async () => {
        await withTempDir("story-factory-market-", async (dir) => {
            const executor = new CapturingExecutor()
            const broker = source("broker")
            const outcomeAuthority = new StoryOutcomeAuthority("run-market")
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-market",
                workerId: "worker-a",
                leaseAuthority: broker,
                outcomeAuthority,
                executor,
                bid: {
                    routeId: "route-a",
                    route: "claude:haiku",
                    estimate: {
                        expectedCostUsd: 1,
                        estimatedSuccessProbability: 0.8,
                        estimatedLatencyMs: 100,
                        estimateSource: "configured",
                    },
                },
            })
            const env = joinWithCapture(factory)
            const offer = WorkOffered.create({
                runId: "run-market",
                offerId: "offer-S1",
                generation: 1,
                priority: 1,
                request: {
                    storyId: "S1",
                    prompt: "S1",
                    model: "haiku",
                    retries: 0,
                    timeoutSecs: 30,
                },
            })
            await factory.onExternalEvent(source("board"), offer)
            const bid = env.events.find(WorkBid.is)
            assert.ok(bid)

            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-market",
                    offerId: "offer-S1",
                    leaseId: "losing",
                    workerId: "worker-b",
                    generation: 1,
                    request: offer.data.request,
                    bidId: "other-bid",
                    route: { routeId: "route-b", backend: "claude", model: "sonnet" },
                }),
            )
            assert.equal(executor.calls.length, 0)

            // Re-bid a fresh generation, then corrupt the frozen route.
            const secondOffer = WorkOffered.create({
                ...offer.data,
                offerId: "offer-S1-2",
                generation: 2,
            })
            await factory.onExternalEvent(source("board"), secondOffer)
            const secondBid = env.events.filter(WorkBid.is).at(-1)
            assert.ok(secondBid)
            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-market",
                    offerId: secondOffer.data.offerId,
                    leaseId: "mismatch",
                    workerId: "worker-a",
                    generation: 2,
                    request: secondOffer.data.request,
                    bidId: secondBid.data.bidId,
                    route: { ...secondBid.data.route, model: "opus" },
                }),
            )

            assert.equal(executor.calls.length, 0)
            assert.equal(env.events.filter(StorySpawnFailed.is).at(-1)?.data.leaseId, "mismatch")
        })
    })

    it("fails closed when a collective executor does not register its result source", async () => {
        await withTempDir("story-factory-authority-", async (dir) => {
            const broker = source("broker")
            const outcomeAuthority = new StoryOutcomeAuthority("run-authority")
            let aborts = 0
            let disposals = 0
            const executor: StoryExecutor = {
                start: () => ({
                    abort: () => { aborts++ },
                    dispose: () => { disposals++ },
                }),
            }
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-authority",
                workerId: "worker-a",
                leaseAuthority: broker,
                outcomeAuthority,
                executor,
            })
            const env = joinWithCapture(factory)

            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-authority",
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    workerId: "worker-a",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "Implement S1",
                        model: "sonnet",
                        retries: 0,
                        timeoutSecs: 30,
                    },
                }),
            )
            await flushBus()

            assert.equal(aborts, 1)
            assert.equal(disposals, 1)
            assert.equal(env.events.filter(StorySpawned.is).length, 0)
            const failed = env.events.filter(StorySpawnFailed.is).at(-1)
            assert.ok(failed)
            assert.match(failed.data.error, /without registering/)
            assert.equal(
                outcomeAuthority.matchesSpawnFailure(factory, failed.data),
                true,
            )
        })
    })

    it("does not retain an execution when StoryResult arrives before start returns", async () => {
        await withTempDir("story-factory-sync-result-", async (dir) => {
            const broker = source("broker")
            const resultSource = source("worker-result")
            const outcomeAuthority = new StoryOutcomeAuthority("run-sync")
            let disposals = 0
            const executor: StoryExecutor = {
                start: (req, _route, _cwd, env, opts) => {
                    opts.registerResultAuthority?.(resultSource)
                    env.deliverSemanticEvent(
                        resultSource,
                        StoryResult.create({
                            storyId: req.storyId,
                            success: true,
                            attempts: 1,
                            durationSecs: 0,
                            error: null,
                            runId: req.runId,
                            leaseId: req.leaseId,
                            generation: req.generation,
                        }),
                    )
                    return { dispose: () => { disposals++ } }
                },
            }
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-sync",
                workerId: "worker-a",
                leaseAuthority: broker,
                outcomeAuthority,
                executor,
            })
            joinWithCapture(factory)

            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-sync",
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    workerId: "worker-a",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "Implement S1",
                        model: "sonnet",
                        retries: 0,
                        timeoutSecs: 30,
                    },
                }),
            )
            await flushBus()

            assert.equal(disposals, 1)
            const active = (factory as unknown as {
                active: Map<string, StoryExecution>
            }).active
            assert.equal(active.size, 0)
        })
    })
})

async function flushBus(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
}
