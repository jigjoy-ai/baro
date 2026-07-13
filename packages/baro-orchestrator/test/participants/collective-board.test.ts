import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { PrdFile } from "../../src/prd.js"
import { CollectiveBoard } from "../../src/participants/collective-board.js"
import {
    RecoveryDecision,
    RecoveryEvaluationStarted,
    RecoveryStarted,
    Replan,
    RunCompleted,
    RunPrepared,
    RunPushRequested,
    RunPushed,
    RunStartRequest,
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
    StoryIntegrationRequested,
    StoryMergeFailed,
    StoryMerged,
    StoryQualityCompleted,
    StoryResult,
    WorkLeaseGranted,
    WorkContextProvided,
    WorkContextRequested,
    WorkDiscovered,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupFailed,
    WorkspaceCleanupRequested,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("CollectiveBoard", () => {
    it("gates push and success on correlated run verification", async () => {
        await withTempDir("collective-verify-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-verify",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                verifyBeforePush: true,
            })
            const env = joinWithCapture(board)
            const request = await integrateSingleStory(env, "run-verify")

            assert.equal(env.events.some(RunPushRequested.is), false)
            env.deliverSemanticEvent(
                source("stale-verifier"),
                RunVerificationCompleted.create({
                    runId: "run-verify",
                    verificationId: `${request.data.verificationId}-stale`,
                    status: "passed",
                    commands: [],
                    durationMs: 1,
                }),
            )
            await flush()
            assert.equal(env.events.some(RunPushRequested.is), false)

            env.deliverSemanticEvent(
                source("verifier"),
                RunVerificationCompleted.create({
                    runId: "run-verify",
                    verificationId: request.data.verificationId,
                    status: "passed",
                    commands: [
                        {
                            command: "npm run test",
                            status: "passed",
                            durationMs: 10,
                        },
                    ],
                    durationMs: 10,
                }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId: "run-verify", pushed: false }),
            )

            const summary = await board.done
            assert.equal(summary.success, true)
            assert.equal(summary.verificationStatus, "passed")
            assert.deepEqual(summary.verification, {
                verificationId: request.data.verificationId,
                status: "passed",
                commands: [
                    {
                        command: "npm run test",
                        status: "passed",
                        durationMs: 10,
                    },
                ],
                durationMs: 10,
            })
        })
    })

    it("cannot report success when objective run verification fails", async () => {
        await withTempDir("collective-verify-fail-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-verify-fail",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                verifyBeforePush: true,
            })
            const env = joinWithCapture(board)
            const request = await integrateSingleStory(env, "run-verify-fail")
            env.deliverSemanticEvent(
                source("verifier"),
                RunVerificationCompleted.create({
                    runId: "run-verify-fail",
                    verificationId: request.data.verificationId,
                    status: "failed",
                    commands: [
                        {
                            command: "npm run test",
                            status: "failed",
                            durationMs: 10,
                            tail: "tests failed",
                        },
                    ],
                    durationMs: 10,
                }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId: "run-verify-fail", pushed: false }),
            )

            const summary = await board.done
            assert.equal(summary.success, false)
            assert.equal(summary.verificationStatus, "failed")
            assert.equal(summary.verification?.commands[0]?.tail, "tests failed")
            assert.match(summary.abortReason ?? "", /verification failed: npm run test/)
        })
    })

    it("fails closed when the verifier never answers", async () => {
        await withTempDir("collective-verify-timeout-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-verify-timeout",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                verifyBeforePush: true,
                verificationTimeoutMs: 5,
            })
            const env = joinWithCapture(board)
            await integrateSingleStory(env, "run-verify-timeout")
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            await waitFor(env.events, RunPushRequested.is)
            const timeout = env.events.find(RunVerificationTimedOut.is)
            assert.equal(timeout?.data.runId, "run-verify-timeout")
            env.deliverSemanticEvent(
                source("late-verifier"),
                RunVerificationCompleted.create({
                    runId: "run-verify-timeout",
                    verificationId: timeout?.data.verificationId ?? "missing",
                    status: "passed",
                    commands: [],
                    durationMs: 20,
                }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId: "run-verify-timeout", pushed: false }),
            )

            const summary = await board.done
            assert.equal(summary.success, false)
            assert.equal(summary.verificationStatus, "failed")
            assert.equal(summary.verification?.commands[0]?.command, "baro run verifier")
            assert.match(summary.abortReason ?? "", /verification timed out/)
        })
    })

    it("marks a story passed only after integration succeeds", async () => {
        await withTempDir("collective-board-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-test",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                defaultModel: "standard",
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId: "run-test", baseSha: null }))
            await provideContext(env, "run-test", 1)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-test",
                    offerId: offer.data.offerId,
                    leaseId: "lease-1",
                    workerId: "worker",
                    generation: 1,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(source("S1"), pass("run-test", "S1", "lease-1", 1))

            await waitFor(env.events, StoryIntegrationRequested.is)
            let saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(saved.userStories[0]?.passes, false)
            assert.equal(env.events.some(RunCompleted.is), false)

            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-test",
                    leaseId: "lease-1",
                }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId: "run-test", pushed: false }),
            )

            const summary = await board.done
            saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(saved.userStories[0]?.passes, true)
            assert.equal(summary.success, true)
            assert.deepEqual(summary.completedStories, ["S1"])
        })
    })

    it("waits for an authorized acceptance verdict before integration", async () => {
        await withTempDir("collective-quality-pass-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const qualityGate = source("quality-gate")
            const board = new CollectiveBoard({
                runId: "run-quality-pass",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectQualityDecisions: true,
                qualityAuthority: qualityGate,
            })
            const env = joinWithCapture(board)
            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId: "run-quality-pass", baseSha: null }),
            )
            await provideContext(env, "run-quality-pass", 1)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-quality-pass",
                    offerId: offer.data.offerId,
                    leaseId: "lease-quality",
                    workerId: "worker",
                    generation: offer.data.generation,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("S1"),
                pass("run-quality-pass", "S1", "lease-quality", offer.data.generation),
            )
            await flush()
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 0)

            const verdict = StoryQualityCompleted.create({
                runId: "run-quality-pass",
                evaluationId: "quality-1",
                storyId: "S1",
                leaseId: "lease-quality",
                generation: offer.data.generation,
                status: "passed",
                targetTurn: 1,
                reason: "all acceptance criteria passed",
            })
            env.deliverSemanticEvent(source("forged-quality-gate"), verdict)
            await flush()
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 0)

            env.deliverSemanticEvent(qualityGate, verdict)
            const integration = await waitFor(env.events, StoryIntegrationRequested.is)
            assert.equal(integration.data.leaseId, "lease-quality")
        })
    })

    it("turns a failed acceptance verdict into a bounded recovery wave", async () => {
        await withTempDir("collective-quality-fail-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const qualityGate = source("quality-gate")
            const board = new CollectiveBoard({
                runId: "run-quality-fail",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectQualityDecisions: true,
                qualityAuthority: qualityGate,
            })
            const env = joinWithCapture(board)
            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId: "run-quality-fail", baseSha: null }),
            )
            await provideContext(env, "run-quality-fail", 1)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-quality-fail",
                    offerId: offer.data.offerId,
                    leaseId: "lease-quality",
                    workerId: "worker",
                    generation: offer.data.generation,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("S1"),
                pass("run-quality-fail", "S1", "lease-quality", offer.data.generation),
            )
            env.deliverSemanticEvent(
                qualityGate,
                StoryQualityCompleted.create({
                    runId: "run-quality-fail",
                    evaluationId: "quality-fail-1",
                    storyId: "S1",
                    leaseId: "lease-quality",
                    generation: offer.data.generation,
                    status: "failed",
                    targetTurn: 1,
                    reason: "required behavior is missing",
                }),
            )
            const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
            assert.equal(cleanup.data.preserveForRecovery, true)
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanup.data,
                    generation: (cleanup.data.generation ?? 0) + 1,
                    preservedBranch: "baro-recovery/forged/stale/1",
                }),
            )
            await flush()
            assert.equal(env.events.filter(RecoveryStarted.is).length, 0)
            const preservedBranch = "baro-recovery/run-quality-fail/S1/1"
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanup.data,
                    preservedBranch,
                }),
            )
            const recovery = await waitFor(env.events, RecoveryStarted.is)
            assert.deepEqual(recovery.data.storyIds, ["S1"])
            await provideContext(env, "run-quality-fail", 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            assert.equal(offers[1]?.data.request.recovery?.kind, "execution")
            assert.equal(offers[1]?.data.request.recovery?.branch, preservedBranch)
            assert.match(
                offers[1]?.data.request.prompt ?? "",
                /acceptance gate failed: required behavior is missing/,
            )
            assert.match(offers[1]?.data.request.prompt ?? "", /git show baro-recovery/)
            assert.doesNotMatch(
                offers[1]?.data.request.prompt ?? "",
                /baro-recovery\/forged\/stale/,
            )
        })
    })

    it("re-offers a safely preserved merge conflict from a new lease generation", async () => {
        await withTempDir("collective-merge-recovery-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-merge-recovery",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId: "run-merge-recovery", baseSha: null }),
            )
            await provideContext(env, "run-merge-recovery", 1)
            const firstOffer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-merge-recovery",
                    offerId: firstOffer.data.offerId,
                    leaseId: "lease-old",
                    workerId: "worker",
                    generation: firstOffer.data.generation,
                    request: firstOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("S1"),
                pass(
                    "run-merge-recovery",
                    "S1",
                    "lease-old",
                    firstOffer.data.generation,
                ),
            )
            await waitFor(env.events, StoryIntegrationRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                StoryMergeFailed.create({
                    storyId: "S1",
                    error: "conflict in src/protocol.ts",
                    branch: "baro-recovery/run-merge-recovery/S1/1",
                    retryable: true,
                    runId: "run-merge-recovery",
                    leaseId: "lease-old",
                }),
            )

            const recovery = await waitFor(env.events, RecoveryStarted.is)
            assert.deepEqual(recovery.data.storyIds, ["S1"])
            assert.equal(env.events.some(WorkspaceCleanupRequested.is), false)

            await provideContext(env, "run-merge-recovery", 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            const retryOffer = offers[1]!
            assert.equal(retryOffer.data.request.recovery?.kind, "integration")
            assert.equal(
                retryOffer.data.request.recovery?.branch,
                "baro-recovery/run-merge-recovery/S1/1",
            )
            assert.match(retryOffer.data.request.prompt, /Do not merge or cherry-pick/)

            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-merge-recovery",
                    offerId: retryOffer.data.offerId,
                    leaseId: "lease-new",
                    workerId: "worker",
                    generation: retryOffer.data.generation,
                    request: retryOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("S1-recovery"),
                pass(
                    "run-merge-recovery",
                    "S1",
                    "lease-new",
                    retryOffer.data.generation,
                ),
            )
            const integrations = await waitForCount(
                env.events,
                StoryIntegrationRequested.is,
                2,
            )
            assert.equal(integrations[1]?.data.leaseId, "lease-new")
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-merge-recovery",
                    leaseId: "lease-new",
                }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId: "run-merge-recovery", pushed: false }),
            )

            const summary = await board.done
            assert.equal(summary.success, true)
            assert.equal(summary.totalAttempts, 2)
            assert.deepEqual(summary.completedStories, ["S1"])
        })
    })

    it("does not start a fresh recovery when failed worktree preservation fails", async () => {
        await withTempDir("collective-retained-failure-", async (dir) => {
            const runId = "run-retained-failure"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId, baseSha: null }))
            await provideContext(env, runId, 1)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: offer.data.offerId,
                    leaseId: "lease-retained",
                    workerId: "worker",
                    generation: offer.data.generation,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                RecoveryEvaluationStarted.create({
                    runId,
                    storyId: "S1",
                    source: "surgeon:test",
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon:test",
                    reason: "queued rewire-only recovery",
                    recovery: {
                        runId,
                        storyId: "S1",
                        leaseId: "lease-retained",
                        generation: offer.data.generation,
                    },
                    removedStoryIds: [],
                    modifiedDeps: {},
                    addedStories: [
                        {
                            id: "S2",
                            priority: 1,
                            title: "Unsafe queued replacement",
                            description: "Must be cancelled if cleanup fails.",
                            dependsOn: [],
                            retries: 1,
                            acceptance: ["The queued replacement preserves the required behavior."],
                            tests: ["npm test"],
                            model: "standard",
                        },
                    ],
                }),
            )
            env.deliverSemanticEvent(
                source("worker"),
                fail(runId, "S1", "lease-retained", offer.data.generation),
            )
            const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
            assert.equal(cleanup.data.preserveForRecovery, true)
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupFailed.create({
                    runId,
                    cleanupId: cleanup.data.cleanupId,
                    storyId: "S1",
                    leaseId: "lease-retained",
                    generation: offer.data.generation,
                    retainedBranch: `baro-wt/${runId}/S1`,
                    error: "preservation commit failed; worktree retained",
                }),
            )

            await waitFor(env.events, RunPushRequested.is)
            assert.equal(env.events.filter(RecoveryStarted.is).length, 0)

            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon:test",
                    reason: "late replacement must be ignored",
                    recovery: {
                        runId,
                        storyId: "S1",
                        leaseId: "lease-retained",
                        generation: offer.data.generation,
                    },
                    removedStoryIds: [],
                    modifiedDeps: {},
                    addedStories: [
                        {
                            id: "S2",
                            priority: 1,
                            title: "Unsafe replacement",
                            description: "Must not start after retention failure.",
                            dependsOn: [],
                            retries: 1,
                            acceptance: ["The replacement preserves the required behavior."],
                            tests: ["npm test"],
                            model: "standard",
                        },
                    ],
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                RecoveryDecision.create({
                    runId,
                    storyId: "S1",
                    source: "surgeon:test",
                    action: "replan",
                    reason: "late replacement must be ignored",
                }),
            )
            await flush()
            assert.equal(env.events.filter(RecoveryStarted.is).length, 0)
            assert.deepEqual(
                JSON.parse(readFileSync(prdPath, "utf8")).userStories.map(
                    (story: { id: string }) => story.id,
                ),
                ["S1"],
            )
        })
    })

    it("waits for an autonomous recovery decision before offering replacement work", async () => {
        await withTempDir("collective-board-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-replan",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId: "run-replan", baseSha: null }))
            await provideContext(env, "run-replan", 1)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-replan",
                    offerId: offer.data.offerId,
                    leaseId: "lease-1",
                    workerId: "worker",
                    generation: 1,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                RecoveryEvaluationStarted.create({
                    runId: "run-replan",
                    storyId: "S1",
                    source: "surgeon:test",
                }),
            )
            env.deliverSemanticEvent(source("S1"), fail("run-replan", "S1", "lease-1", 1))
            const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
            env.deliverSemanticEvent(
                source("stale-repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanup.data,
                    cleanupId: "stale-cleanup",
                }),
            )
            await flush()
            assert.equal(env.events.filter(WorkContextRequested.is).length, 1)
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanup.data,
                }),
            )
            await flush()
            assert.equal(env.events.filter(WorkOffered.is).length, 1)
            assert.equal(env.events.some(RunPushRequested.is), false)

            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon:test",
                    reason: "split failed work",
                    recovery: {
                        runId: "run-replan",
                        storyId: "S1",
                        leaseId: "lease-1",
                        generation: 1,
                    },
                    removedStoryIds: ["S1"],
                    modifiedDeps: {},
                    addedStories: [
                        {
                            id: "S2",
                            priority: 1,
                            title: "Smaller replacement",
                            description: "Complete the smaller unit.",
                            dependsOn: [],
                            retries: 1,
                            acceptance: ["replacement works"],
                            tests: ["npm test"],
                        },
                    ],
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                RecoveryDecision.create({
                    runId: "run-replan",
                    storyId: "S1",
                    source: "surgeon:test",
                    action: "replan",
                    reason: "split failed work",
                }),
            )

            await provideContext(env, "run-replan", 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            assert.equal(offers[1]?.data.request.storyId, "S2")
        })
    })

    it("ignores a late terminal event from an older lease generation", async () => {
        await withTempDir("collective-late-result-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-late",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
            })
            const env = joinWithCapture(board)
            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId: "run-late", baseSha: null }))
            await provideContext(env, "run-late", 1)
            const firstOffer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-late",
                    offerId: firstOffer.data.offerId,
                    leaseId: "lease-old",
                    workerId: "worker",
                    generation: 1,
                    request: firstOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("S1"),
                fail("run-late", "S1", "lease-old", 1),
            )
            const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanup.data,
                }),
            )

            await provideContext(env, "run-late", 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-late",
                    offerId: offers[1]!.data.offerId,
                    leaseId: "lease-new",
                    workerId: "worker",
                    generation: 2,
                    request: offers[1]!.data.request,
                }),
            )

            env.deliverSemanticEvent(
                source("late-S1"),
                pass("run-late", "S1", "lease-old", 1),
            )
            await flush()
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 0)

            const current = pass("run-late", "S1", "lease-new", 2)
            env.deliverSemanticEvent(source("S1"), current)
            env.deliverSemanticEvent(source("duplicate-S1"), current)
            const integration = await waitFor(env.events, StoryIntegrationRequested.is)
            assert.equal(integration.data.leaseId, "lease-new")
            assert.equal(env.events.filter(StoryIntegrationRequested.is).length, 1)
        })
    })

    it("reoffers a capacity failure only after its checkpoint and excludes the failed market route", async () => {
        await withTempDir("collective-capacity-route-", async (dir) => {
            const runId = "run-capacity-route"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                marketRouteIds: ["route-a", "route-b", "route-c"],
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId, baseSha: null }))
            await provideContext(env, runId, 1)
            const firstOffer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: firstOffer.data.offerId,
                    leaseId: "lease-route-a",
                    workerId: "worker-a",
                    generation: firstOffer.data.generation,
                    request: firstOffer.data.request,
                    route: {
                        routeId: "route-a",
                        backend: "openai",
                        model: "deepseek",
                    },
                }),
            )
            env.deliverSemanticEvent(
                source("worker-a-agent"),
                capacityFail(
                    runId,
                    "S1",
                    "lease-route-a",
                    firstOffer.data.generation,
                ),
            )

            const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
            assert.equal(cleanup.data.preserveForRecovery, true)
            await flush()
            assert.equal(env.events.filter(RecoveryStarted.is).length, 0)
            assert.equal(env.events.filter(WorkOffered.is).length, 1)

            const checkpoint = `${runId}/recovery/S1/1`
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanup.data,
                    preservedBranch: checkpoint,
                }),
            )
            await waitFor(env.events, RecoveryStarted.is)
            await provideContext(env, runId, 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            const retry = offers[1]!
            assert.deepEqual(retry.data.excludedRouteIds, ["route-a"])
            assert.equal(retry.data.request.recovery?.branch, checkpoint)
            assert.match(retry.data.request.prompt, /provider capacity unavailable/)
            assert.equal(env.events.filter(RecoveryEvaluationStarted.is).length, 0)

            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: retry.data.offerId,
                    leaseId: "lease-route-b",
                    workerId: "worker-b",
                    generation: retry.data.generation,
                    request: retry.data.request,
                    route: {
                        routeId: "route-b",
                        backend: "openai",
                        model: "glm",
                    },
                }),
            )
            env.deliverSemanticEvent(
                source("worker-b-agent"),
                capacityFail(
                    runId,
                    "S1",
                    "lease-route-b",
                    retry.data.generation,
                ),
            )
            const cleanups = await waitForCount(
                env.events,
                WorkspaceCleanupRequested.is,
                2,
            )
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanups[1]!.data,
                    preservedBranch: `${runId}/recovery/S1/2`,
                }),
            )
            await provideContext(env, runId, 3)
            const thirdOffer = (await waitForCount(env.events, WorkOffered.is, 3))[2]!
            assert.deepEqual(thirdOffer.data.excludedRouteIds, ["route-a", "route-b"])
        })
    })

    it("fails closed after checkpointing capacity work when no alternate market route exists", async () => {
        await withTempDir("collective-capacity-single-", async (dir) => {
            const runId = "run-capacity-single"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId, baseSha: null }))
            await provideContext(env, runId, 1)
            const offered = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: offered.data.offerId,
                    leaseId: "lease-single",
                    workerId: "single-worker",
                    generation: offered.data.generation,
                    request: offered.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("single-agent"),
                capacityFail(
                    runId,
                    "S1",
                    "lease-single",
                    offered.data.generation,
                ),
            )
            const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({
                    ...cleanup.data,
                    preservedBranch: `${runId}/recovery/S1/1`,
                }),
            )

            await waitFor(env.events, RunPushRequested.is)
            assert.equal(env.events.filter(WorkOffered.is).length, 1)
            assert.equal(env.events.filter(RecoveryStarted.is).length, 0)
            assert.equal(env.events.filter(RecoveryEvaluationStarted.is).length, 0)
        })
    })

    it("cancels stale reroutes when concurrent failures exhaust the whole market", async () => {
        await withTempDir("collective-capacity-concurrent-", async (dir) => {
            const runId = "run-capacity-concurrent"
            const input = prd()
            input.userStories.push({
                ...input.userStories[0]!,
                id: "S2",
                priority: 2,
                title: "Second story",
                description: "Implement the other independent change.",
            })
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                marketRouteIds: ["route-a", "route-b"],
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId, baseSha: null }))
            await provideContext(env, runId, 1)
            await provideContext(env, runId, 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)

            for (const [index, offered] of offers.entries()) {
                const routeName = index === 0 ? "a" : "b"
                const leaseId = `lease-route-${routeName}`
                env.deliverSemanticEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId,
                        offerId: offered.data.offerId,
                        leaseId,
                        workerId: `worker-${routeName}`,
                        generation: offered.data.generation,
                        request: offered.data.request,
                        route: {
                            routeId: `route-${routeName}`,
                            backend: "openai",
                            model: routeName,
                        },
                    }),
                )
                env.deliverSemanticEvent(
                    source(`worker-${routeName}-agent`),
                    capacityFail(
                        runId,
                        offered.data.request.storyId,
                        leaseId,
                        offered.data.generation,
                    ),
                )
            }

            const cleanups = await waitForCount(
                env.events,
                WorkspaceCleanupRequested.is,
                2,
            )
            for (const cleanup of cleanups) {
                env.deliverSemanticEvent(
                    source("repo"),
                    WorkspaceCleanupCompleted.create({
                        ...cleanup.data,
                        preservedBranch: `${runId}/recovery/${cleanup.data.storyId}/1`,
                    }),
                )
            }

            await waitFor(env.events, RunPushRequested.is)
            assert.equal(env.events.filter(WorkOffered.is).length, 2)
            assert.equal(env.events.filter(RecoveryStarted.is).length, 0)
        })
    })

    it("accepts bounded work discovered by a leased worker", async () => {
        await withTempDir("collective-board-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId: "run-discovery",
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
            })
            const env = joinWithCapture(board)
            env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
            env.deliverSemanticEvent(source("repo"), RunPrepared.create({ runId: "run-discovery", baseSha: null }))
            await provideContext(env, "run-discovery", 1)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-discovery",
                    offerId: offer.data.offerId,
                    leaseId: "lease-1",
                    workerId: "worker",
                    generation: 1,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("S1"),
                WorkDiscovered.create({
                    runId: "run-discovery",
                    sourceAgentId: "S1",
                    reason: "The public API also needs documentation",
                    story: {
                        id: "S2",
                        title: "Document the API",
                        description: "Add usage documentation for the new API.",
                        dependsOn: ["S1"],
                        acceptance: ["usage is documented"],
                        tests: ["npm test"],
                    },
                }),
            )
            env.deliverSemanticEvent(source("S1"), pass("run-discovery", "S1", "lease-1", 1))
            await waitFor(env.events, StoryIntegrationRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-discovery",
                    leaseId: "lease-1",
                }),
            )

            await provideContext(env, "run-discovery", 2)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            assert.equal(offers[1]?.data.request.storyId, "S2")
            const saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(saved.userStories.some((story) => story.id === "S2"), true)
        })
    })
})

function prd(): PrdFile {
    return {
        project: "Collective test",
        branchName: "baro/collective-test",
        description: "test",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "First story",
                description: "Implement it.",
                dependsOn: [],
                retries: 1,
                acceptance: ["works"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: "standard",
            },
        ],
    }
}

function pass(runId: string, storyId: string, leaseId: string, generation: number) {
    return StoryResult.create({
        runId,
        storyId,
        leaseId,
        generation,
        success: true,
        attempts: 1,
        durationSecs: 2,
        error: null,
    })
}

function fail(runId: string, storyId: string, leaseId: string, generation: number) {
    return StoryResult.create({
        runId,
        storyId,
        leaseId,
        generation,
        success: false,
        attempts: 1,
        durationSecs: 2,
        error: "failed",
    })
}

function capacityFail(
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
) {
    return StoryResult.create({
        runId,
        storyId,
        leaseId,
        generation,
        success: false,
        attempts: 1,
        durationSecs: 2,
        error: "provider capacity unavailable: quota exhausted",
        failure: {
            kind: "provider_capacity",
            code: "quota_exhausted",
        },
    })
}

async function waitFor<T>(events: readonly unknown[], guard: (event: unknown) => event is T): Promise<T> {
    const found = await waitForCount(events, guard, 1)
    return found[0]!
}

async function waitForCount<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = events.filter(guard)
        if (found.length >= count) return found
        await flush()
    }
    assert.fail(`timed out waiting for ${count} events`)
}

async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
}

async function provideContext(
    env: ReturnType<typeof joinWithCapture>,
    runId: string,
    count: number,
): Promise<void> {
    const requests = await waitForCount(env.events, WorkContextRequested.is, count)
    const request = requests[count - 1]!
    env.deliverSemanticEvent(
        source("context"),
        WorkContextProvided.create({
            runId,
            requestId: request.data.requestId,
            storyId: request.data.storyId,
            context: null,
        }),
    )
}

async function integrateSingleStory(
    env: ReturnType<typeof joinWithCapture>,
    runId: string,
) {
    env.deliverSemanticEvent(source("operator"), RunStartRequest.create({ reason: "test" }))
    env.deliverSemanticEvent(
        source("repo"),
        RunPrepared.create({ runId, baseSha: null }),
    )
    await provideContext(env, runId, 1)
    const offer = await waitFor(env.events, WorkOffered.is)
    const leaseId = `${runId}:lease`
    env.deliverSemanticEvent(
        source("broker"),
        WorkLeaseGranted.create({
            runId,
            offerId: offer.data.offerId,
            leaseId,
            workerId: "worker",
            generation: offer.data.generation,
            request: offer.data.request,
        }),
    )
    env.deliverSemanticEvent(
        source("worker"),
        pass(runId, "S1", leaseId, offer.data.generation),
    )
    await waitFor(env.events, StoryIntegrationRequested.is)
    env.deliverSemanticEvent(
        source("repo"),
        StoryMerged.create({
            storyId: "S1",
            mode: "worktree",
            runId,
            leaseId,
        }),
    )
    return waitFor(env.events, RunVerificationRequested.is)
}
