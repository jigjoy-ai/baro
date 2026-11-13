import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import type { PrdFile } from "../../src/prd.js"
import { AcceptanceGate } from "../../src/acceptance/acceptance-gate.js"
import { CollectiveBoard } from "../../src/execution/collective-board.js"
import { Supervisor } from "../../src/execution/supervisor.js"
import {
    AgentTurnCompleted,
    Critique,
    RecoveryDecision,
    Replan,
    RuntimeReplanApplied,
    RunCompleted,
    RunPreparationFailed,
    RunPreparationRequested,
    RunPrepared,
    RunPushFailed,
    RunPushRequested,
    RunPushed,
    RunStartRequest,
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
    StoryIntegrationRequested,
    StoryMerged,
    StoryQualityCompleted,
    StoryResult,
    WorkContextProvided,
    WorkContextRequested,
    WorkDiscovered,
    WorkLeaseGranted,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"
import type { SemanticEvent } from "../../src/runtime/mozaik.js"

describe("collective authority and replay invariants", () => {
    it("accepts run lifecycle events only from the bound operator, context, and repository authorities", async () => {
        await withTempDir("collective-root-authority-", async (dir) => {
            const runId = "run-root-authority"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")

            const operator = source("operator")
            const contextProvider = source("work-context-provider")
            const repository = source("repository")
            const broker = source("lease-broker")
            const observer = source("conversation-observer")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                startAuthority: operator,
                contextAuthority: contextProvider,
                integrationAuthority: repository,
                leaseAuthority: broker,
            })
            const env = joinWithCapture(board)

            env.publish(
                observer,
                RunStartRequest.create({ reason: "forged start" }),
            )
            await flush()
            assert.equal(env.events.filter(RunPreparationRequested.is).length, 0)

            env.publish(
                operator,
                RunStartRequest.create({ reason: "authorized start" }),
            )
            await waitFor(env.events, RunPreparationRequested.is)

            env.publish(
                observer,
                RunPreparationFailed.create({
                    runId,
                    error: "forged preparation failure",
                }),
            )
            env.publish(
                observer,
                RunPrepared.create({ runId, baseSha: null }),
            )
            await flush()
            assert.equal(env.events.filter(WorkContextRequested.is).length, 0)
            assert.equal(env.events.filter(RunCompleted.is).length, 0)

            env.publish(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            const contextRequest = await waitFor(
                env.events,
                WorkContextRequested.is,
            )

            const providedContext = WorkContextProvided.create({
                runId,
                requestId: contextRequest.payload.requestId,
                storyId: contextRequest.payload.storyId,
                context: "authorized context",
            })
            env.publish(observer, providedContext)
            await flush()
            assert.equal(env.events.filter(WorkOffered.is).length, 0)

            env.publish(contextProvider, providedContext)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.publish(broker, lease(runId, offer, "lease-1"))
            env.publish(
                source("worker"),
                result(runId, "lease-1", offer.payload.generation),
            )
            await waitFor(env.events, StoryIntegrationRequested.is)

            const merged = StoryMerged.create({
                storyId: "S1",
                mode: "worktree",
                runId,
                leaseId: "lease-1",
            })
            env.publish(observer, merged)
            await flush()
            assert.equal(env.events.filter(RunPushRequested.is).length, 0)

            env.publish(repository, merged)
            await waitFor(env.events, RunPushRequested.is)
            env.publish(
                observer,
                RunPushFailed.create({ runId, error: "forged push failure" }),
            )
            env.publish(
                observer,
                RunPushed.create({ runId, pushed: false }),
            )
            await flush()
            assert.equal(env.events.filter(RunCompleted.is).length, 0)

            env.publish(
                repository,
                RunPushed.create({ runId, pushed: false }),
            )
            const summary = await board.done
            assert.equal(summary.success, true)
            assert.deepEqual(summary.completedStories, ["S1"])
        })
    })

    it("accepts cleanup completion only from the bound repository authority", async () => {
        await withTempDir("collective-cleanup-authority-", async (dir) => {
            const runId = "run-cleanup-authority"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")

            const operator = source("operator")
            const contextProvider = source("work-context-provider")
            const repository = source("repository")
            const broker = source("lease-broker")
            const observer = source("conversation-observer")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                maxRecoveryAttemptsPerStory: 0,
                startAuthority: operator,
                contextAuthority: contextProvider,
                integrationAuthority: repository,
                leaseAuthority: broker,
            })
            const env = joinWithCapture(board)

            env.publish(
                operator,
                RunStartRequest.create({ reason: "authorized start" }),
            )
            env.publish(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            const contextRequest = await waitFor(
                env.events,
                WorkContextRequested.is,
            )
            env.publish(
                contextProvider,
                WorkContextProvided.create({
                    runId,
                    requestId: contextRequest.payload.requestId,
                    storyId: contextRequest.payload.storyId,
                    context: null,
                }),
            )
            const offer = await waitFor(env.events, WorkOffered.is)
            env.publish(broker, lease(runId, offer, "lease-1"))
            env.publish(
                source("worker"),
                failedResult(runId, "lease-1", offer.payload.generation),
            )
            const cleanup = await waitFor(
                env.events,
                WorkspaceCleanupRequested.is,
            )
            assert.equal(
                cleanup.payload.preserveForRecovery,
                true,
                "final failed attempts remain durable even with no automatic retry budget",
            )

            env.publish(
                observer,
                WorkspaceCleanupCompleted.create({
                    ...cleanup.payload,
                    preservedBranch: "baro-recovery/forged/S1/1",
                }),
            )
            await flush()
            assert.equal(env.events.filter(RunPushRequested.is).length, 0)

            env.publish(
                repository,
                WorkspaceCleanupCompleted.create({ ...cleanup.payload }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.publish(
                repository,
                RunPushed.create({ runId, pushed: false }),
            )
            const summary = await board.done
            assert.equal(summary.success, false)
            assert.match(summary.abortReason ?? "", /incomplete stories: S1/)
        })
    })

    it("rejects an observer forging lease, quality, or integration success and finishes after Supervisor leaves", async () => {
        await withTempDir("collective-authority-", async (dir) => {
            const runId = "run-authority"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")

            const broker = source("lease-broker")
            const qualityGate = source("acceptance-gate")
            const repository = source("repository")
            const observer = source("conversation-observer")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectQualityDecisions: true,
                leaseAuthority: broker,
                qualityAuthority: qualityGate,
                integrationAuthority: repository,
            })
            const env = joinWithCapture(board)
            const supervisor = new Supervisor()
            supervisor.join(env)

            env.publish(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.publish(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            await provideContext(env, runId)
            const offer = await waitFor(env.events, WorkOffered.is)

            const forgedLease = lease(runId, offer, "forged-lease")
            env.publish(observer, forgedLease)
            env.publish(
                observer,
                result(runId, "forged-lease", offer.payload.generation),
            )
            // A replay from the real gate must not validate a lease the broker
            // never granted.
            env.publish(
                qualityGate,
                quality(runId, "forged-lease", offer.payload.generation),
            )
            await flush()
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 0)

            const realLease = lease(runId, offer, "real-lease")
            env.publish(broker, realLease)
            env.publish(
                source("worker"),
                result(runId, "real-lease", offer.payload.generation),
            )
            env.publish(
                observer,
                quality(runId, "real-lease", offer.payload.generation),
            )
            await flush()
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 0)

            const accepted = quality(runId, "real-lease", offer.payload.generation)
            env.publish(qualityGate, accepted)
            env.publish(qualityGate, accepted)
            await waitFor(env.events, StoryIntegrationRequested.is)
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 1)

            // This observer is optional policy, not a root coordinator. Its
            // departure cannot become a liveness dependency of the Board.
            supervisor.leave(env)
            assert.equal(supervisor.getBuses().length, 0)

            env.publish(
                observer,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId,
                    leaseId: "real-lease",
                }),
            )
            await flush()
            assert.equal(readPrd(prdPath).userStories[0]?.passes, false)
            assert.equal(env.events.filter(RunPushRequested.is).length, 0)

            env.publish(
                repository,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId,
                    leaseId: "real-lease",
                }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.publish(
                repository,
                RunPushed.create({ runId, pushed: false }),
            )

            const summary = await board.done
            assert.equal(summary.success, true)
            assert.deepEqual(summary.completedStories, ["S1"])
            assert.equal(readPrd(prdPath).userStories[0]?.passes, true)
        })
    })

    it("deduplicates replayed terminal, critique, result, and quality events before integration", async () => {
        await withTempDir("collective-replay-", async (dir) => {
            const runId = "run-replay"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")

            const broker = source("lease-broker")
            const critic = source("critic")
            const repository = source("repository")
            const gate = new AcceptanceGate({
                runId,
                targets: new Map([["S1", ["tests pass"]]]),
                timeoutMs: 200,
                leaseAuthority: broker,
                critiqueAuthority: critic,
            })
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectQualityDecisions: true,
                leaseAuthority: broker,
                qualityAuthority: gate,
                integrationAuthority: repository,
            })
            const env = joinWithCapture(board)
            gate.join(env)

            env.publish(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.publish(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            await provideContext(env, runId)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.publish(broker, lease(runId, offer, "lease-1"))

            const terminal = AgentTurnCompleted.create({
                agentId: "S1",
                terminalId: "projected:S1:1",
                backend: "codex",
                isError: false,
                resultText: "implementation and tests completed",
                canContinue: false,
            })
            const critique = Critique.create({
                agentId: "S1",
                verdict: "pass",
                reasoning: "tests pass",
                violatedCriteria: [],
                turn: 1,
                modelUsed: "test-critic",
            })
            const completed = result(runId, "lease-1", offer.payload.generation)

            env.publish(source("projector"), terminal)
            env.publish(source("projector"), terminal)
            env.publish(critic, critique)
            env.publish(critic, critique)
            env.publish(source("worker"), completed)
            env.publish(source("worker"), completed)

            await waitFor(env.events, StoryIntegrationRequested.is)
            await gate.idle()
            assert.equal(env.events.filter(StoryQualityCompleted.is).length, 1)
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 1)

            const replay = env.events.find(StoryQualityCompleted.is)!
            env.publish(gate, replay)
            env.publish(gate, replay)
            await flush()
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 1)
        })
    })

    it("accepts objective verification only from the bound verifier", async () => {
        await withTempDir("collective-verifier-authority-", async (dir) => {
            const runId = "run-verifier-authority"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")

            const broker = source("lease-broker")
            const repository = source("repository")
            const verifier = source("run-verifier")
            const observer = source("conversation-observer")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                verifyBeforePush: true,
                verificationTimeoutMs: 10_000,
                leaseAuthority: broker,
                integrationAuthority: repository,
                verifierAuthority: verifier,
            })
            const env = joinWithCapture(board)

            env.publish(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.publish(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            await provideContext(env, runId)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.publish(broker, lease(runId, offer, "lease-1"))
            env.publish(
                source("worker"),
                result(runId, "lease-1", offer.payload.generation),
            )
            await waitFor(env.events, StoryIntegrationRequested.is)
            env.publish(
                repository,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId,
                    leaseId: "lease-1",
                }),
            )
            const request = await waitFor(env.events, RunVerificationRequested.is)

            env.publish(
                observer,
                RunVerificationCompleted.create({
                    runId,
                    verificationId: request.payload.verificationId,
                    status: "passed",
                    commands: [
                        {
                            command: "node --check proof.mjs",
                            status: "passed",
                            durationMs: 1,
                        },
                    ],
                    durationMs: 1,
                }),
            )
            env.publish(
                observer,
                RunVerificationTimedOut.create({
                    runId,
                    verificationId: request.payload.verificationId,
                    timeoutMs: 1,
                }),
            )
            await flush()
            assert.equal(env.events.filter(RunPushRequested.is).length, 0)

            env.publish(
                verifier,
                RunVerificationCompleted.create({
                    runId,
                    verificationId: request.payload.verificationId,
                    status: "passed",
                    commands: [
                        {
                            command: "node --check proof.mjs",
                            status: "passed",
                            durationMs: 1,
                        },
                    ],
                    durationMs: 2,
                }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.publish(
                repository,
                RunPushed.create({ runId, pushed: false }),
            )
            assert.equal((await board.done).success, true)
        })
    })

    it("accepts recovery decisions and replans only from the bound recovery agent", async () => {
        await withTempDir("collective-recovery-authority-", async (dir) => {
            const runId = "run-recovery-authority"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")

            const broker = source("lease-broker")
            const repository = source("repository")
            const surgeon = source("surgeon")
            const observer = source("conversation-observer")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                leaseAuthority: broker,
                integrationAuthority: repository,
                recoveryAuthority: surgeon,
            })
            const env = joinWithCapture(board)

            env.publish(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.publish(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            await provideContext(env, runId)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.publish(broker, lease(runId, offer, "lease-1"))
            env.publish(
                source("worker"),
                failedResult(runId, "lease-1", offer.payload.generation),
            )
            const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
            env.publish(
                repository,
                WorkspaceCleanupCompleted.create({ ...cleanup.payload }),
            )

            const replacement = {
                ...replacementReplan(),
                recovery: {
                    runId,
                    storyId: "S1",
                    leaseId: "lease-1",
                    generation: offer.payload.generation,
                },
            }
            env.publish(observer, Replan.create(replacement))
            env.publish(
                observer,
                RecoveryDecision.create({
                    runId,
                    storyId: "S1",
                    source: "observer",
                    action: "replan",
                    reason: replacement.reason,
                }),
            )
            await flush()
            assert.equal(env.events.filter(WorkContextRequested.is).length, 1)

            env.publish(surgeon, Replan.create(replacement))
            env.publish(
                surgeon,
                RecoveryDecision.create({
                    runId,
                    storyId: "S1",
                    source: "surgeon:test",
                    action: "replan",
                    reason: replacement.reason,
                }),
            )
            await provideContext(env, runId, 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            assert.equal(offers[1]?.payload.request.storyId, "S2")
            assert.equal(
                env.events.filter(RuntimeReplanApplied.is).length,
                1,
            )
            const persisted = JSON.parse(readFileSync(prdPath, "utf8"))
            assert.equal(persisted.runtimeGraph.version, 2)
            assert.equal(persisted.runtimeGraph.dynamicStories, 0)
            assert.equal(persisted.runtimeGraph.policyStories, 1)
            assert.equal(persisted.runtimeGraph.appliedDecisions.length, 1)
            assert.match(
                persisted.runtimeGraph.appliedDecisions[0].applied.proposalId,
                new RegExp(`^${runId}:policy-replan:[0-9a-f-]{36}$`),
            )
        })
    })

    it("accepts discovered work only from the bound collaboration bridge", async () => {
        await withTempDir("collective-discovery-authority-", async (dir) => {
            const runId = "run-discovery-authority"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")

            const broker = source("lease-broker")
            const repository = source("repository")
            const bridge = source("collaboration-bridge")
            const observer = source("conversation-observer")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                leaseAuthority: broker,
                integrationAuthority: repository,
                discoveryAuthority: bridge,
            })
            const env = joinWithCapture(board)

            env.publish(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.publish(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            await provideContext(env, runId)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.publish(broker, lease(runId, offer, "lease-1"))

            env.publish(
                observer,
                discovery(runId, "S2", "lease-1", offer.payload.generation),
            )
            env.publish(
                bridge,
                discovery(runId, "S3", "lease-1", offer.payload.generation),
            )
            env.publish(
                source("worker"),
                result(runId, "lease-1", offer.payload.generation),
            )
            await waitFor(env.events, StoryIntegrationRequested.is)
            env.publish(
                repository,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId,
                    leaseId: "lease-1",
                }),
            )
            await waitForCount(env.events, WorkContextRequested.is, 2)

            const storyIds = readPrd(prdPath).userStories.map((story) => story.id)
            assert.equal(storyIds.includes("S2"), false)
            assert.equal(storyIds.includes("S3"), true)
        })
    })
})

function prd(): PrdFile {
    return {
        project: "Collective authority test",
        branchName: "baro/collective-authority-test",
        description: "test",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Implement the story",
                description: "Complete the requested behavior.",
                dependsOn: [],
                acceptance: ["tests pass"],
                tests: [],
                passes: false,
            },
        ],
    }
}

function readPrd(path: string): PrdFile {
    return JSON.parse(readFileSync(path, "utf8")) as PrdFile
}

function lease(
    runId: string,
    offer: ReturnType<typeof WorkOffered.create>,
    leaseId: string,
): ReturnType<typeof WorkLeaseGranted.create> {
    return WorkLeaseGranted.create({
        runId,
        offerId: offer.payload.offerId,
        leaseId,
        workerId: "worker",
        generation: offer.payload.generation,
        request: offer.payload.request,
    })
}

function result(
    runId: string,
    leaseId: string,
    generation: number,
): ReturnType<typeof StoryResult.create> {
    return StoryResult.create({
        storyId: "S1",
        success: true,
        attempts: 1,
        durationSecs: 1,
        error: null,
        runId,
        leaseId,
        generation,
    })
}

function failedResult(
    runId: string,
    leaseId: string,
    generation: number,
): ReturnType<typeof StoryResult.create> {
    return StoryResult.create({
        storyId: "S1",
        success: false,
        attempts: 1,
        durationSecs: 1,
        error: "intentional failure",
        runId,
        leaseId,
        generation,
    })
}

function replacementReplan(): Parameters<typeof Replan.create>[0] {
    return {
        source: "surgeon:test",
        reason: "replace failed work with a smaller story",
        removedStoryIds: ["S1"],
        modifiedDeps: {},
        addedStories: [
            {
                id: "S2",
                priority: 1,
                title: "Smaller replacement",
                description: "Complete the bounded replacement.",
                dependsOn: [],
                retries: 1,
                acceptance: ["tests pass"],
                tests: ["npm test"],
            },
        ],
    }
}

function discovery(
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
): ReturnType<typeof WorkDiscovered.create> {
    return WorkDiscovered.create({
        runId,
        sourceAgentId: "S1",
        leaseId,
        generation,
        reason: "worker found required follow-up work",
        story: {
            id: storyId,
            title: `Implement ${storyId}`,
            description: `Complete follow-up ${storyId}.`,
            dependsOn: ["S1"],
            acceptance: ["tests pass"],
            tests: ["npm test"],
        },
    })
}

function quality(
    runId: string,
    leaseId: string,
    generation: number,
): ReturnType<typeof StoryQualityCompleted.create> {
    return StoryQualityCompleted.create({
        runId,
        evaluationId: `quality-${leaseId}`,
        storyId: "S1",
        leaseId,
        generation,
        status: "passed",
        targetTurn: 1,
        reason: "acceptance criteria passed",
    })
}

async function provideContext(
    env: ReturnType<typeof joinWithCapture>,
    runId: string,
    count = 1,
): Promise<void> {
    const requests = await waitForCount(env.events, WorkContextRequested.is, count)
    const request = requests[count - 1]!
    env.publish(
        source("context"),
        WorkContextProvided.create({
            runId,
            requestId: request.payload.requestId,
            storyId: request.payload.storyId,
            context: null,
        }),
    )
}

async function waitForCount<T extends SemanticEvent<string, unknown>>(
    events: readonly SemanticEvent<string, unknown>[],
    guard: (event: SemanticEvent<string, unknown>) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = events.filter(guard)
        if (found.length >= count) return found
        await flush()
    }
    assert.fail(`timed out waiting for ${count} collective events`)
}

async function waitFor<T extends SemanticEvent<string, unknown>>(
    events: readonly SemanticEvent<string, unknown>[],
    guard: (event: SemanticEvent<string, unknown>) => event is T,
): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const event = events.find(guard)
        if (event) return event
        await flush()
    }
    assert.fail("timed out waiting for collective event")
}

async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
}
