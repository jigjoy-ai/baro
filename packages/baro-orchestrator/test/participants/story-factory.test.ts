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
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type ModelInvocationMeasuredData,
} from "../../src/model-telemetry.js"
import {
    ModelInvocationMeasured,
    RouteEstimateUpdated,
    RunStartRequest,
    RunCompleted,
    StoryIntervention,
    StoryResult,
    StoryRouted,
    StorySpawnRequest,
    StorySpawned,
    StorySpawnFailed,
    WorkBlockAccepted,
    WorkBid,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkOfferRetractionResolved,
    WorkOffered,
    WorkSuspended,
    WorkerCapabilityAdvertised,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import type { WorktreeManager } from "../../src/worktree.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import type {
    CollaborationLeaseCapabilityRequest,
} from "../../src/participants/collaboration-bridge.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

const TEST_COLLABORATION_TOKEN = "a".repeat(43)

function capabilityBroker(
    initialMessages: readonly string[] = [],
): {
    readonly requests: CollaborationLeaseCapabilityRequest[]
    capabilityForLease(request: CollaborationLeaseCapabilityRequest): {
        endpoint: string
        token: string
        initialMessages: readonly string[]
    }
} {
    const requests: CollaborationLeaseCapabilityRequest[] = []
    return {
        requests,
        capabilityForLease(request) {
            requests.push(request)
            return {
                endpoint: "http://127.0.0.1:4242",
                token: TEST_COLLABORATION_TOKEN,
                initialMessages,
            }
        },
    }
}

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

    it("enables inconclusive handoff only for a quality-gated collective lease", async () => {
        await withTempDir("story-factory-quality-handoff-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
            const critic = source("critic")
            const projector = source("terminal-projector")
            const gate = source("acceptance-gate")
            const collectiveExecutor = new CapturingExecutor()
            const collective = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-quality-handoff",
                workerId: "worker-a",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority: new StoryOutcomeAuthority(
                    "run-quality-handoff",
                ),
                executor: collectiveExecutor,
                turnReviewAuthority: critic,
                terminalTurnAuthority: projector,
                acceptanceGateAuthority: gate,
            })
            joinWithCapture(collective)
            await collective.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-quality-handoff",
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
                        requiresQualityReview: true,
                    },
                }),
            )
            await flushBus()
            assert.equal(
                collectiveExecutor.calls[0]?.opts
                    .handoffInconclusiveToAcceptanceGate,
                true,
            )
            assert.equal(
                collectiveExecutor.calls[0]?.opts.terminalTurnAuthority,
                projector,
            )

            const legacyExecutor = new CapturingExecutor()
            const legacy = new StoryFactory({
                cwd: dir,
                coordinationMode: "legacy",
                executor: legacyExecutor,
                turnReviewAuthority: critic,
                acceptanceGateAuthority: gate,
            })
            joinWithCapture(legacy)
            await legacy.onExternalEvent(
                source("conductor"),
                StorySpawnRequest.create({
                    storyId: "S2",
                    prompt: "Implement S2",
                    model: "sonnet",
                    retries: 0,
                    timeoutSecs: 30,
                    requiresQualityReview: true,
                }),
            )
            assert.equal(
                legacyExecutor.calls[0]?.opts
                    .handoffInconclusiveToAcceptanceGate,
                false,
            )
        })
    })

    it("wires collective terminal projection and process quiescence independently without a Critic", async () => {
        await withTempDir("story-factory-terminal-only-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
            const projector = source("terminal-projector")
            const executor = new CapturingExecutor()
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-terminal-only",
                workerId: "worker-a",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority: new StoryOutcomeAuthority(
                    "run-terminal-only",
                ),
                executor,
                terminalTurnAuthority: projector,
            })
            joinWithCapture(factory)

            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-terminal-only",
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
                        requiresQualityReview: false,
                    },
                }),
            )
            await flushBus()

            assert.equal(executor.calls.length, 1)
            assert.equal(
                executor.calls[0]?.opts.terminalTurnAuthority,
                projector,
            )
            assert.equal(
                executor.calls[0]?.opts.turnReviewAuthority,
                undefined,
            )
            assert.equal(
                executor.calls[0]?.opts
                    .requireProcessQuiescenceCertification,
                true,
            )
            assert.match(
                executor.calls[0]?.req.prompt ?? "",
                /COLLECTIVE PROCESS-LIFECYCLE CONTRACT/,
            )
            assert.match(
                executor.calls[0]?.req.prompt ?? "",
                /Do not start background, detached, daemonized, or persistent processes/,
            )
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

    it("does not launch an executor after shutdown begins during worktree creation", async () => {
        await withTempDir("story-factory-shutdown-spawn-", async (dir) => {
            const executor = new CapturingExecutor()
            let releaseCreate!: (path: string | null) => void
            const worktrees = {
                create: () => new Promise<string | null>((resolve) => {
                    releaseCreate = resolve
                }),
            } as unknown as WorktreeManager
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "claude",
                worktrees,
            })
            joinWithCapture(factory)
            const pendingSpawn = factory.onExternalEvent(
                source("conductor"),
                StorySpawnRequest.create({
                    storyId: "S-shutdown",
                    prompt: "Never launch after the run ends",
                    model: "sonnet",
                    retries: 0,
                    timeoutSecs: 30,
                }),
            )
            await Promise.resolve()

            assert.deepEqual(
                await factory.quiesceForShutdown(0),
                ["S-shutdown"],
            )
            releaseCreate(join(dir, "S-shutdown-worktree"))
            await pendingSpawn

            assert.equal(executor.calls.length, 0)
            assert.deepEqual(await factory.quiesceForShutdown(0), [])
        })
    })

    it("retains an execution that reports a terminal result synchronously from shutdown abort", async () => {
        await withTempDir("story-factory-shutdown-result-", async (dir) => {
            const resultSource = source("sync-abort-result")
            const executor: StoryExecutor = {
                start: (req, _route, _cwd, env) => ({
                    abort: () => {
                        env.deliverSemanticEvent(
                            resultSource,
                            StoryResult.create({
                                storyId: req.storyId,
                                success: false,
                                attempts: 1,
                                durationSecs: 0,
                                error: "aborted",
                            }),
                        )
                    },
                    dispose: () => {},
                }),
            }
            const factory = new StoryFactory({ cwd: dir, executor })
            const env = joinWithCapture(factory)
            await factory.onExternalEvent(
                source("conductor"),
                StorySpawnRequest.create({
                    storyId: "S-sync-abort",
                    prompt: "Stop safely",
                    model: "sonnet",
                    retries: 0,
                    timeoutSecs: 30,
                }),
            )

            assert.deepEqual(
                await factory.quiesceForShutdown(0),
                ["S-sync-abort"],
            )
            assert.equal(env.events.filter(StoryResult.is).length, 1)
        })
    })

    it("retains an uncertified terminal worktree after execution disposal", async () => {
        await withTempDir("story-factory-uncertified-result-", async (dir) => {
            const resultSource = source("uncertified-result")
            const executor: StoryExecutor = {
                start: (req, _route, _cwd, env) => {
                    env.deliverSemanticEvent(
                        resultSource,
                        StoryResult.create({
                            storyId: req.storyId,
                            success: false,
                            attempts: 1,
                            durationSecs: 0,
                            error: "process group still alive",
                            failure: {
                                kind: "infrastructure",
                                code: "process_quiescence_uncertified",
                            },
                        }),
                    )
                    return { dispose: () => {} }
                },
            }
            const factory = new StoryFactory({ cwd: dir, executor })
            const env = joinWithCapture(factory)

            await factory.onExternalEvent(
                source("conductor"),
                StorySpawnRequest.create({
                    storyId: "S-uncertified",
                    prompt: "Do not delete this worktree",
                    model: "sonnet",
                    retries: 0,
                    timeoutSecs: 30,
                }),
            )

            assert.equal(env.events.filter(StoryResult.is).length, 1)
            assert.deepEqual(
                await factory.quiesceForShutdown(0),
                ["S-uncertified"],
            )
        })
    })

    it("advertises and bids a credential-free route, then executes the frozen winning route", async () => {
        await withTempDir("story-factory-market-", async (dir) => {
            const executor = new CapturingExecutor()
            const broker = source("broker")
            const runtimeBoard = source("runtime-board")
            const collaborationBroker = capabilityBroker([
                "pre-launch peer direction",
            ])
            const outcomeAuthority = new StoryOutcomeAuthority("run-market")
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-market",
                workerId: "worker-cheap",
                leaseAuthority: broker,
                offerAuthority: runtimeBoard,
                outcomeAuthority,
                llm: "claude",
                executor,
                runtimeReplanDecisionAuthority: runtimeBoard,
                collaboration: {
                    commandPath: "/tmp/agent-collab.mjs",
                    capabilityBroker: collaborationBroker,
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
                runtimeBoard,
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
                runtimeBoard,
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
            assert.deepEqual(
                env.events.find(
                    (event) =>
                        StoryRouted.is(event) &&
                        event.data.storyId === "S1",
                )?.data,
                {
                    storyId: "S1",
                    backend: "openai",
                    model: "deepseek-v4-flash",
                    runId: "run-market",
                    leaseId: "lease-S1",
                    generation: 1,
                },
            )
            assert.match(executor.calls[0].req.prompt, /--kind help/)
            assert.match(
                executor.calls[0].req.prompt,
                /Architect decision document is a revisable evidence-backed baseline/,
            )
            assert.match(
                executor.calls[0].req.prompt,
                /Before writing, validate the ADR facts and semantic obligations/,
            )
            assert.match(
                executor.calls[0].req.prompt,
                /Do not create competing challenge and replan repairs for one defect/,
            )
            assert.doesNotMatch(executor.calls[0].req.prompt, /inbox --endpoint/)
            assert.match(executor.calls[0].req.prompt, /--endpoint "http:\/\/127\.0\.0\.1:4242"/)
            assert.match(executor.calls[0].req.prompt, /--token "a{43}"/)
            assert.equal(
                executor.calls[0].req.prompt.match(/pre-launch peer direction/gu)
                    ?.length,
                1,
            )
            assert.doesNotMatch(executor.calls[0].req.prompt, /--kind discover/)
            assert.doesNotMatch(executor.calls[0].req.prompt, /--kind replan/)
            assert.doesNotMatch(executor.calls[0].req.prompt, /decision --endpoint/)
            assert.doesNotMatch(executor.calls[0].req.prompt, /--session/)
            assert.equal(
                executor.calls[0].opts.runtimeReplanDecisionAuthority,
                runtimeBoard,
            )
            assert.deepEqual(executor.calls[0].opts.collaboration, {
                commandPath: "/tmp/agent-collab.mjs",
                endpoint: "http://127.0.0.1:4242",
                token: TEST_COLLABORATION_TOKEN,
                deliveryMode: "live",
            })
            assert.deepEqual(collaborationBroker.requests, [{
                runId: "run-market",
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                deliveryMode: "live",
            }])

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

    it("drops a cached bid route after the Broker retracts its offer", async () => {
        await withTempDir("story-factory-retracted-route-", async (dir) => {
            const runId = "run-retracted-route"
            const broker = source("broker")
            const board = source("board")
            const executor = new CapturingExecutor()
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId,
                workerId: "worker-a",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority: new StoryOutcomeAuthority(runId),
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
            const work = marketOffer(runId, "S1", 1)
            await factory.onExternalEvent(board, work)
            const bid = env.events.find(WorkBid.is)!

            await factory.onExternalEvent(
                broker,
                WorkOfferRetractionResolved.create({
                    runId,
                    proposalId: "proposal-1",
                    retractionId: "retraction-1",
                    offerId: work.data.offerId,
                    storyId: "S1",
                    generation: 1,
                    graphVersion: 2,
                    disposition: "retracted",
                }),
            )
            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: work.data.offerId,
                    leaseId: "stale-lease",
                    workerId: "worker-a",
                    generation: 1,
                    request: work.data.request,
                    bidId: bid.data.bidId,
                    route: bid.data.route,
                }),
            )

            assert.equal(executor.calls.length, 0)
            const failure = env.events.find(StorySpawnFailed.is)
            assert.equal(failure?.data.leaseId, "stale-lease")
            assert.match(failure?.data.error ?? "", /stored bid/)
        })
    })

    it("accepts offers only from the exact board authority, preventing predictable pre-offer tier bypass", async () => {
        await withTempDir("story-factory-offer-authority-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-offer-authority",
                workerId: "worker-light",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority: new StoryOutcomeAuthority(
                    "run-offer-authority",
                ),
                executor: new CapturingExecutor(),
                bid: {
                    routeId: "route-light",
                    route: "claude:haiku",
                    tiers: ["light"],
                    estimate: {
                        expectedCostUsd: 1,
                        estimatedSuccessProbability: 0.8,
                        estimatedLatencyMs: 100,
                        estimateSource: "configured",
                    },
                },
            })
            const env = joinWithCapture(factory)
            const predictable = {
                runId: "run-offer-authority",
                offerId: "offer-predictable",
                generation: 1,
                priority: 1,
                request: {
                    storyId: "S-predictable",
                    prompt: "Implement predictable story",
                    model: "light",
                    retries: 0,
                    timeoutSecs: 30,
                },
            }

            // An attacker cannot seed a valid bid for a predictable future
            // offer id by publishing a cheaper tier before the real Board.
            await factory.onExternalEvent(
                source("forged-board"),
                WorkOffered.create(predictable),
            )
            assert.equal(env.events.filter(WorkBid.is).length, 0)

            await factory.onExternalEvent(
                board,
                WorkOffered.create({
                    ...predictable,
                    request: { ...predictable.request, model: "heavy" },
                }),
            )
            assert.equal(env.events.filter(WorkBid.is).length, 0)

            await factory.onExternalEvent(
                board,
                WorkOffered.create({
                    ...predictable,
                    offerId: "offer-authoritative-light",
                }),
            )
            assert.equal(env.events.filter(WorkBid.is).length, 1)
        })
    })

    it("learns a historical bid from authoritative deduplicated costs and an integrated lease", async (t) => {
        let now = 1_000
        t.mock.method(Date, "now", () => now)

        await withTempDir("story-factory-route-learning-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
            const telemetry = source("telemetry-reducer")
            const configuredEstimate = {
                expectedCostUsd: 3,
                estimatedSuccessProbability: 0.8,
                estimatedLatencyMs: 1_000,
                estimateSource: "configured" as const,
            }
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-learning",
                workerId: "worker-learning",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority: new StoryOutcomeAuthority("run-learning"),
                telemetryAuthority: telemetry,
                executor: new CapturingExecutor(),
                bid: {
                    routeId: "route-learning",
                    route: "claude:haiku",
                    estimate: configuredEstimate,
                },
            })
            const env = joinWithCapture(factory)
            const first = await bidAndGrantMarketLease(
                factory,
                env,
                broker,
                board,
                "run-learning",
                "worker-learning",
                "S-success",
                1,
            )

            assert.deepEqual(first.bid.data.estimate, configuredEstimate)

            // A forged producer and an authoritative but stale lease must not
            // contribute. A replayed invocation contributes once even when
            // its measurement id changes.
            await factory.onExternalEvent(
                source("forged-telemetry"),
                ModelInvocationMeasured.create(
                    storyCostMeasurement(
                        "forged-cost",
                        "forged-invocation",
                        "run-learning",
                        "S-success",
                        first.lease.data.leaseId,
                        first.lease.data.generation,
                        90,
                    ),
                ),
            )
            await factory.onExternalEvent(
                telemetry,
                ModelInvocationMeasured.create(
                    storyCostMeasurement(
                        "stale-cost",
                        "stale-invocation",
                        "run-learning",
                        "S-success",
                        "lease-from-old-generation",
                        0,
                        90,
                    ),
                ),
            )
            await factory.onExternalEvent(
                telemetry,
                ModelInvocationMeasured.create(
                    storyCostMeasurement(
                        "cost-a",
                        "invocation-a",
                        "run-learning",
                        "S-success",
                        first.lease.data.leaseId,
                        first.lease.data.generation,
                        4,
                    ),
                ),
            )
            await factory.onExternalEvent(
                telemetry,
                ModelInvocationMeasured.create(
                    storyCostMeasurement(
                        "cost-a-replay",
                        "invocation-a",
                        "run-learning",
                        "S-success",
                        first.lease.data.leaseId,
                        first.lease.data.generation,
                        4,
                    ),
                ),
            )
            await factory.onExternalEvent(
                telemetry,
                ModelInvocationMeasured.create(
                    storyCostMeasurement(
                        "cost-b",
                        "invocation-b",
                        "run-learning",
                        "S-success",
                        first.lease.data.leaseId,
                        first.lease.data.generation,
                        2,
                    ),
                ),
            )

            now = 1_600
            await factory.onExternalEvent(
                broker,
                WorkLeaseReleased.create({
                    runId: "run-learning",
                    offerId: first.lease.data.offerId,
                    leaseId: first.lease.data.leaseId,
                    storyId: "S-success",
                    workerId: "worker-learning",
                    reason: "integrated",
                }),
            )

            const update = env.events.find(RouteEstimateUpdated.is)
            assert.ok(update)
            assert.deepEqual(update.data, {
                runId: "run-learning",
                workerId: "worker-learning",
                route: {
                    routeId: "route-learning",
                    backend: "claude",
                    model: "haiku",
                },
                verifiedSuccesses: 1,
                workFailures: 0,
                observations: 1,
                estimate: {
                    // Cost prior: (3 * 2 + (4 + 2)) / (2 + 1).
                    expectedCostUsd: 4,
                    // Quality prior: (0.8 * 4 + 1) / (4 + 1).
                    estimatedSuccessProbability: (0.8 * 4 + 1) / 5,
                    // Latency prior: (1000 * 2 + 600) / (2 + 1).
                    estimatedLatencyMs: (1_000 * 2 + 600) / 3,
                    estimateSource: "historical",
                },
            })

            // Gateway/cloud billing may settle after the worker lease is
            // released. Exact historical correlation is retained for this
            // run, so it updates the next auction without being attached to a
            // newer retry of the same story.
            await factory.onExternalEvent(
                telemetry,
                ModelInvocationMeasured.create(
                    storyCostMeasurement(
                        "late-cost-c",
                        "invocation-c",
                        "run-learning",
                        "S-success",
                        first.lease.data.leaseId,
                        first.lease.data.generation,
                        3,
                    ),
                ),
            )
            const lateUpdate = env.events.filter(RouteEstimateUpdated.is).at(-1)
            assert.ok(lateUpdate)
            assert.equal(lateUpdate.data.estimate.expectedCostUsd, 5)
            assert.equal(lateUpdate.data.observations, 1)

            const laterOffer = marketOffer("run-learning", "S-later", 2)
            await factory.onExternalEvent(board, laterOffer)
            const laterBid = env.events.filter(WorkBid.is).at(-1)
            assert.ok(laterBid)
            assert.equal(laterBid.data.storyId, "S-later")
            assert.deepEqual(laterBid.data.estimate, lateUpdate.data.estimate)
        })
    })

    it("lowers route quality for semantic failure but not operational failure", async (t) => {
        let now = 5_000
        t.mock.method(Date, "now", () => now)

        await withTempDir("story-factory-route-quality-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
            const initialSuccessProbability = 0.75
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-quality-learning",
                workerId: "worker-quality-learning",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority: new StoryOutcomeAuthority(
                    "run-quality-learning",
                ),
                executor: new CapturingExecutor(),
                bid: {
                    routeId: "route-quality-learning",
                    route: "claude:haiku",
                    estimate: {
                        expectedCostUsd: 1,
                        estimatedSuccessProbability: initialSuccessProbability,
                        estimatedLatencyMs: 100,
                        estimateSource: "configured",
                    },
                },
            })
            const env = joinWithCapture(factory)
            const semantic = await bidAndGrantMarketLease(
                factory,
                env,
                broker,
                board,
                "run-quality-learning",
                "worker-quality-learning",
                "S-quality-failure",
                1,
            )

            now = 5_100
            await factory.onExternalEvent(
                broker,
                WorkLeaseReleased.create({
                    runId: "run-quality-learning",
                    offerId: semantic.lease.data.offerId,
                    leaseId: semantic.lease.data.leaseId,
                    storyId: "S-quality-failure",
                    workerId: "worker-quality-learning",
                    reason: "quality_failed",
                }),
            )
            const afterSemantic = env.events.filter(RouteEstimateUpdated.is).at(-1)
            assert.ok(afterSemantic)
            assert.equal(afterSemantic.data.verifiedSuccesses, 0)
            assert.equal(afterSemantic.data.workFailures, 1)
            assert.equal(afterSemantic.data.observations, 1)
            assert.equal(
                afterSemantic.data.estimate.estimatedSuccessProbability,
                (initialSuccessProbability * 4) / 5,
            )
            assert.ok(
                afterSemantic.data.estimate.estimatedSuccessProbability <
                    initialSuccessProbability,
            )

            const operational = await bidAndGrantMarketLease(
                factory,
                env,
                broker,
                board,
                "run-quality-learning",
                "worker-quality-learning",
                "S-operational-failure",
                2,
            )
            now = 5_200
            await factory.onExternalEvent(
                broker,
                WorkLeaseReleased.create({
                    runId: "run-quality-learning",
                    offerId: operational.lease.data.offerId,
                    leaseId: operational.lease.data.leaseId,
                    storyId: "S-operational-failure",
                    workerId: "worker-quality-learning",
                    reason: "operational_failed",
                }),
            )

            const updates = env.events.filter(RouteEstimateUpdated.is)
            assert.equal(updates.length, 2)
            const afterOperational = updates[1]
            assert.ok(afterOperational)
            assert.equal(afterOperational.data.verifiedSuccesses, 0)
            assert.equal(afterOperational.data.workFailures, 1)
            assert.equal(afterOperational.data.observations, 2)
            assert.equal(
                afterOperational.data.estimate.estimatedSuccessProbability,
                afterSemantic.data.estimate.estimatedSuccessProbability,
            )
        })
    })

    it("selects exactly one DAG mutation mechanism for native and CLI routes", async () => {
        await withTempDir("story-factory-mutation-route-", async (dir) => {
            const broker = source("broker")
            const runtimeBoard = source("runtime-board")
            const nativeCollaborationBroker = capabilityBroker()

            const nativeExecutor = new CapturingExecutor()
            const nativeFactory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-native",
                workerId: "worker-native",
                leaseAuthority: broker,
                offerAuthority: runtimeBoard,
                outcomeAuthority: new StoryOutcomeAuthority("run-native"),
                llm: "claude",
                executor: nativeExecutor,
                runtimeReplanDecisionAuthority: runtimeBoard,
                collaboration: {
                    commandPath: "/tmp/agent-collab.mjs",
                    capabilityBroker: nativeCollaborationBroker,
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
            assert.doesNotMatch(nativeExecutor.calls[0].req.prompt, /inbox --endpoint/)
            assert.doesNotMatch(nativeExecutor.calls[0].req.prompt, /--kind discover/)
            assert.doesNotMatch(nativeExecutor.calls[0].req.prompt, /--kind replan/)
            assert.doesNotMatch(
                nativeExecutor.calls[0].req.prompt,
                /decision --endpoint/,
            )
            assert.equal(
                nativeExecutor.calls[0].opts.runtimeReplanDecisionAuthority,
                runtimeBoard,
            )
            assert.deepEqual(nativeExecutor.calls[0].opts.collaboration, {
                commandPath: "/tmp/agent-collab.mjs",
                endpoint: "http://127.0.0.1:4242",
                token: TEST_COLLABORATION_TOKEN,
                deliveryMode: "live",
            })

            const cliExecutor = new CapturingExecutor()
            const cliCollaborationBroker = capabilityBroker()
            const cliFactory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-cli",
                workerId: "worker-cli",
                leaseAuthority: broker,
                offerAuthority: runtimeBoard,
                outcomeAuthority: new StoryOutcomeAuthority("run-cli"),
                llm: "codex",
                executor: cliExecutor,
                runtimeReplanDecisionAuthority: runtimeBoard,
                collaboration: {
                    commandPath: "/tmp/agent-collab.mjs",
                    capabilityBroker: cliCollaborationBroker,
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
            assert.match(cliExecutor.calls[0].req.prompt, /\binbox --endpoint\b/)
            assert.match(cliExecutor.calls[0].req.prompt, /decision --endpoint/)
            assert.match(cliExecutor.calls[0].req.prompt, /--proposal "PROPOSAL_ID"/)
            assert.doesNotMatch(cliExecutor.calls[0].req.prompt, /--session/)
            assert.equal(
                cliExecutor.calls[0].opts.runtimeReplanDecisionAuthority,
                undefined,
            )
            assert.deepEqual(cliExecutor.calls[0].opts.collaboration, {
                commandPath: "/tmp/agent-collab.mjs",
                endpoint: "http://127.0.0.1:4242",
                token: TEST_COLLABORATION_TOKEN,
                deliveryMode: "poll",
            })
            assert.equal(nativeCollaborationBroker.requests[0]?.deliveryMode, "live")
            assert.equal(cliCollaborationBroker.requests[0]?.deliveryMode, "poll")
        })
    })

    it("selects live or poll collaboration delivery for every production story harness", async () => {
        await withTempDir("story-factory-collaboration-routes-", async (dir) => {
            for (const [backend, expectedMode] of [
                ["claude", "live"],
                ["openai", "live"],
                ["codex", "poll"],
                ["opencode", "poll"],
                ["pi", "poll"],
            ] as const) {
                const runId = `run-collaboration-${backend}`
                const leaseAuthority = source(`broker-${backend}`)
                const board = source(`board-${backend}`)
                const executor = new CapturingExecutor()
                const requests: CollaborationLeaseCapabilityRequest[] = []
                const broker = {
                    capabilityForLease(
                        request: CollaborationLeaseCapabilityRequest,
                    ) {
                        requests.push(request)
                        return {
                            endpoint: "http://127.0.0.1:4242",
                            token: TEST_COLLABORATION_TOKEN,
                            initialMessages:
                                request.deliveryMode === "live"
                                    ? ["one pre-launch message"]
                                    : [],
                        }
                    },
                }
                const factory = new StoryFactory({
                    cwd: dir,
                    coordinationMode: "collective",
                    runId,
                    workerId: `worker-${backend}`,
                    leaseAuthority,
                    offerAuthority: board,
                    outcomeAuthority: new StoryOutcomeAuthority(runId),
                    llm: backend,
                    executor,
                    collaboration: {
                        commandPath: "/tmp/agent-collab.mjs",
                        capabilityBroker: broker,
                    },
                })
                joinWithCapture(factory)

                await factory.onExternalEvent(
                    leaseAuthority,
                    WorkLeaseGranted.create({
                        runId,
                        offerId: `offer-${backend}`,
                        leaseId: `lease-${backend}`,
                        workerId: `worker-${backend}`,
                        generation: 1,
                        request: {
                            storyId: `S-${backend}`,
                            prompt: `Implement with ${backend}`,
                            model: "test-model",
                            retries: 0,
                            timeoutSecs: 30,
                            graphVersion: 1,
                        },
                    }),
                )
                await flushBus()

                assert.equal(requests[0]?.deliveryMode, expectedMode)
                assert.equal(
                    executor.calls[0]?.opts.collaboration?.deliveryMode,
                    expectedMode,
                )
                const prompt = executor.calls[0]?.req.prompt ?? ""
                assert.match(prompt, /--endpoint "http:\/\/127\.0\.0\.1:4242"/)
                assert.match(prompt, /--token "a{43}"/)
                assert.doesNotMatch(prompt, /--session/)
                if (expectedMode === "poll") {
                    assert.match(prompt, /inbox --endpoint/)
                    assert.doesNotMatch(prompt, /one pre-launch message/)
                } else {
                    assert.doesNotMatch(prompt, /inbox --endpoint/)
                    assert.equal(
                        prompt.match(/one pre-launch message/gu)?.length,
                        1,
                    )
                }
            }
        })
    })

    it("ignores a losing market lease and fails a mismatched winning lease", async () => {
        await withTempDir("story-factory-market-", async (dir) => {
            const executor = new CapturingExecutor()
            const broker = source("broker")
            const board = source("board")
            const outcomeAuthority = new StoryOutcomeAuthority("run-market")
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-market",
                workerId: "worker-a",
                leaseAuthority: broker,
                offerAuthority: board,
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
            await factory.onExternalEvent(board, offer)
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
            await factory.onExternalEvent(board, secondOffer)
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
            const mismatch = env.events.filter(StorySpawnFailed.is).at(-1)
            assert.equal(mismatch?.data.leaseId, "mismatch")
            assert.deepEqual(mismatch?.data.failure, {
                kind: "infrastructure",
                code: "decision_unknown",
            })
        })
    })

    it("fails closed when a collective executor does not register its result source", async () => {
        await withTempDir("story-factory-authority-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
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
                offerAuthority: board,
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
            assert.deepEqual(failed.data.failure, {
                kind: "infrastructure",
                code: "process_spawn_failed",
            })
            assert.equal(
                outcomeAuthority.matchesSpawnFailure(factory, failed.data),
                true,
            )
        })
    })

    it("does not retain an execution when StoryResult arrives before start returns", async () => {
        await withTempDir("story-factory-sync-result-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
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
                offerAuthority: board,
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

    it("retains an accepted block when the advertised executor lacks suspend", async () => {
        await withTempDir("story-factory-missing-suspend-", async (dir) => {
            const runId = "run-missing-suspend"
            const broker = source("broker")
            const board = source("board")
            const outcomeAuthority = new StoryOutcomeAuthority(runId)
            const executor: StoryExecutor = {
                supportsCooperativeSuspend: () => true,
                start: (_req, _route, _cwd, _env, opts) => {
                    opts.registerResultAuthority?.(source("result-source"))
                    return { dispose: () => {} }
                },
            }
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId,
                workerId: "worker",
                leaseAuthority: broker,
                offerAuthority: board,
                runtimeReplanDecisionAuthority: board,
                outcomeAuthority,
                executor,
            })
            joinWithCapture(factory)
            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S7",
                    leaseId: "lease-S7",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S7",
                        prompt: "Implement S7",
                        model: "codex:gpt-5.6",
                        retries: 0,
                        timeoutSecs: 60,
                    },
                }),
            )
            await flushBus()
            await factory.onExternalEvent(
                board,
                WorkBlockAccepted.create({
                    runId,
                    blockId: "block-S7-S8",
                    storyId: "S7",
                    leaseId: "lease-S7",
                    generation: 1,
                    requiredStoryIds: ["S8"],
                    reason: "S8 is required",
                    graphVersion: 2,
                }),
            )

            assert.deepEqual(factory.unreleasedSuspensionStoryIds(), ["S7"])
            assert.deepEqual(await factory.quiesceForShutdown(0), ["S7"])
        })
    })

    it("emits WorkSuspended only after the cooperative executor proves quiescence", async () => {
        await withTempDir("story-factory-block-", async (dir) => {
            const runId = "run-block"
            const broker = source("broker")
            const board = source("board")
            const resultSource = source("S6-result")
            const outcomeAuthority = new StoryOutcomeAuthority(runId)
            let suspends = 0
            let aborts = 0
            let disposals = 0
            let finishSuspend!: (summary: {
                attempts: number
                durationSecs: number
            }) => void
            const executor: StoryExecutor = {
                supportsCooperativeSuspend: () => true,
                start: (_req, _route, _cwd, _env, opts) => {
                    opts.registerResultAuthority?.(resultSource)
                    return {
                        abort: () => { aborts += 1 },
                        suspend: () => {
                            suspends += 1
                            return new Promise((resolve) => {
                                finishSuspend = resolve
                            })
                        },
                        dispose: () => { disposals += 1 },
                    }
                },
            }
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId,
                workerId: "worker",
                leaseAuthority: broker,
                offerAuthority: board,
                runtimeReplanDecisionAuthority: board,
                outcomeAuthority,
                executor,
            })
            const env = joinWithCapture(factory)
            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S6",
                    leaseId: "lease-S6",
                    workerId: "worker",
                    generation: 2,
                    request: {
                        storyId: "S6",
                        prompt: "Implement provider cancellation",
                        model: "codex:gpt-5.6",
                        retries: 0,
                        timeoutSecs: 60,
                    },
                }),
            )
            await flushBus()
            const accepted = WorkBlockAccepted.create({
                runId,
                blockId: "block-S6-S11",
                storyId: "S6",
                leaseId: "lease-S6",
                generation: 2,
                requiredStoryIds: ["S11"],
                reason: "iterateWithAbort must integrate first",
                graphVersion: 5,
            })
            await factory.onExternalEvent(source("attacker"), accepted)
            assert.equal(suspends, 0)
            await factory.onExternalEvent(board, accepted)
            assert.equal(suspends, 1)
            assert.equal(disposals, 0)
            assert.equal(env.events.some(WorkSuspended.is), false)
            assert.deepEqual(await factory.quiesceForShutdown(0), ["S6"])
            assert.equal(aborts, 1)

            // Duplicate decisions are idempotent and cannot start a second
            // process-tree drain.
            await factory.onExternalEvent(board, accepted)
            assert.equal(suspends, 1)

            finishSuspend({ attempts: 1, durationSecs: 2 })
            await flushBus()
            const suspended = env.events.find(WorkSuspended.is)
            assert.ok(suspended)
            assert.deepEqual(suspended.data, {
                runId,
                blockId: "block-S6-S11",
                storyId: "S6",
                leaseId: "lease-S6",
                generation: 2,
                attempts: 1,
                durationSecs: 2,
            })
            assert.deepEqual(await factory.quiesceForShutdown(0), [])
            assert.equal(disposals, 1)

            await factory.onExternalEvent(
                resultSource,
                StoryResult.create({
                    storyId: "S6",
                    success: false,
                    attempts: 1,
                    durationSecs: 2,
                    error: "cooperative suspension",
                    runId,
                    leaseId: "lease-S6",
                    generation: 2,
                    suspension: {
                        kind: "dependency",
                        blockId: "block-S6-S11",
                    },
                }),
            )
            assert.equal(disposals, 1)
        })
    })

    it("accepts collective aborts only from the exact authority and active lease", async () => {
        await withTempDir("story-factory-intervention-authority-", async (dir) => {
            const runId = "run-intervention-authority"
            const broker = source("broker")
            const board = source("board")
            const supervisor = source("supervisor")
            const impostor = source("supervisor")
            const bridge = source("bridge")
            const outcomeAuthority = new StoryOutcomeAuthority(runId)
            let aborts = 0
            const executor: StoryExecutor = {
                start: (_request, _route, _cwd, _env, opts) => {
                    opts.registerResultAuthority?.(source("result"))
                    return {
                        dispose: () => {},
                        abort: () => { aborts += 1 },
                    }
                },
            }
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId,
                workerId: "worker",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority,
                targetedMessageAuthority: bridge,
                interventionAuthority: supervisor,
                executor,
            })
            joinWithCapture(factory)
            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    workerId: "worker",
                    generation: 2,
                    request: {
                        storyId: "S1",
                        prompt: "Implement S1",
                        model: "standard",
                        retries: 0,
                        timeoutSecs: 60,
                    },
                }),
            )
            await flushBus()
            const intervention = StoryIntervention.create({
                storyId: "S1",
                source: "supervisor",
                action: "abort",
                reason: "non-converging",
                runId,
                leaseId: "lease-S1",
                generation: 2,
            })
            await factory.onExternalEvent(impostor, intervention)
            await factory.onExternalEvent(
                supervisor,
                StoryIntervention.create({
                    ...intervention.data,
                    leaseId: "stale-lease",
                }),
            )
            assert.equal(aborts, 0)
            await factory.onExternalEvent(supervisor, intervention)
            assert.equal(aborts, 1)
        })
    })
})

function marketOffer(runId: string, storyId: string, generation: number) {
    return WorkOffered.create({
        runId,
        offerId: `offer-${storyId}`,
        generation,
        priority: 1,
        request: {
            storyId,
            prompt: `Implement ${storyId}`,
            model: "haiku",
            retries: 0,
            timeoutSecs: 30,
        },
    })
}

async function bidAndGrantMarketLease(
    factory: StoryFactory,
    env: ReturnType<typeof joinWithCapture>,
    broker: ReturnType<typeof source>,
    board: ReturnType<typeof source>,
    runId: string,
    workerId: string,
    storyId: string,
    generation: number,
) {
    const offer = marketOffer(runId, storyId, generation)
    await factory.onExternalEvent(board, offer)
    const bid = env.events
        .filter(WorkBid.is)
        .find((candidate) => candidate.data.offerId === offer.data.offerId)
    assert.ok(bid)
    const lease = WorkLeaseGranted.create({
        runId,
        offerId: offer.data.offerId,
        leaseId: `lease-${storyId}`,
        workerId,
        generation,
        request: offer.data.request,
        bidId: bid.data.bidId,
        route: bid.data.route,
    })
    await factory.onExternalEvent(broker, lease)
    await flushBus()
    return { bid, lease }
}

function storyCostMeasurement(
    measurementId: string,
    invocationId: string,
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
    customerCostUsd: number,
): ModelInvocationMeasuredData {
    const unknown = () => unknownMetric("not_reported")
    return {
        schemaVersion: 1,
        measurementId,
        invocationId,
        runId,
        phase: "story",
        storyId,
        leaseId,
        generation,
        attempt: 1,
        turn: 1,
        round: 1,
        backend: "claude",
        provider: "anthropic",
        requestedModel: "haiku",
        resolvedModel: "claude-haiku",
        status: "succeeded",
        durationMs: unknown(),
        tokens: {
            inputTotal: unknown(),
            cachedInput: unknown(),
            cacheWriteInput: notApplicableMetric(),
            outputTotal: unknown(),
            reasoningOutput: notApplicableMetric(),
            total: unknown(),
        },
        cost: {
            providerUsd: unknownMetric("pending_gateway_meter"),
            customerUsd: knownMetric(customerCostUsd, "cloud_charge"),
            equivalentUsd: notApplicableMetric(),
        },
        evidence: {
            producer: "cloud",
            providerRequestId: `request-${invocationId}`,
            rateCardVersion: "test-rate-card",
            granularity: "round",
        },
    }
}

async function flushBus(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
}
