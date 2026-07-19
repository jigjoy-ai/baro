import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { GitGate } from "../../src/git.js"
import { GitCoordinator } from "../../src/participants/git-coordinator.js"
import type { WorktreeManager } from "../../src/worktree.js"
import {
    RunPushFailed,
    RunPushed,
    RunPushRequested,
    StoryIntegrationRequested,
    StoryMergeFailed,
    WorkLeaseGranted,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupFailed,
    WorkspaceCleanupRequested,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

const BOARD = source("board")
const BROKER = source("broker")

describe("GitCoordinator", () => {
    it("fails closed before merge when a reviewed lease omits its candidate seal", async () => {
        await withTempDir("git-missing-candidate-seal-", async (dir) => {
            let mergeCalls = 0
            const worktrees = {
                mergeBack: async () => {
                    mergeCalls += 1
                    return true
                },
            } as unknown as WorktreeManager
            const coordinator = new GitCoordinator({
                cwd: dir,
                gitGate: new GitGate(),
                worktrees,
                emitTui: false,
                eventDriven: true,
                runId: "run-missing-seal",
                push: false,
            })
            coordinator.setEventAuthority(BOARD)
            coordinator.setLeaseAuthority(BROKER)
            const env = joinWithCapture(coordinator)

            env.deliverSemanticEvent(
                BROKER,
                WorkLeaseGranted.create({
                    runId: "run-missing-seal",
                    offerId: "offer-1",
                    leaseId: "lease-1",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "implement reviewed work",
                        retries: 0,
                        timeoutSecs: 60,
                        requiresQualityReview: true,
                    },
                }),
            )
            env.deliverSemanticEvent(
                BOARD,
                StoryIntegrationRequested.create({
                    runId: "run-missing-seal",
                    leaseId: "lease-1",
                    storyId: "S1",
                    attempts: 1,
                    durationSecs: 1,
                }),
            )
            await coordinator.idle()

            assert.equal(mergeCalls, 0)
            const failure = env.events.find(StoryMergeFailed.is)
            assert.ok(failure)
            assert.match(failure.data.error, /candidate seal marker is missing/)
        })
    })

    it("fails closed while collective repository authorities are unbound", async () => {
        await withTempDir("git-unbound-authority-", async (dir) => {
            const cleaned: string[] = []
            const worktrees = {
                cleanup: async (storyId: string) => {
                    cleaned.push(storyId)
                },
            } as unknown as WorktreeManager
            const coordinator = new GitCoordinator({
                cwd: dir,
                gitGate: new GitGate(),
                worktrees,
                emitTui: false,
                eventDriven: true,
                runId: "run-unbound",
                push: false,
            })
            const env = joinWithCapture(coordinator)
            env.deliverSemanticEvent(
                source("ambient-broker"),
                WorkLeaseGranted.create({
                    runId: "run-unbound",
                    offerId: "offer-1",
                    leaseId: "lease-1",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "work",
                        retries: 0,
                        timeoutSecs: 60,
                    },
                }),
            )
            env.deliverSemanticEvent(
                source("ambient-board"),
                WorkspaceCleanupRequested.create({
                    runId: "run-unbound",
                    cleanupId: "cleanup-1",
                    storyId: "S1",
                    leaseId: "lease-1",
                    generation: 1,
                }),
            )
            await coordinator.idle()

            assert.deepEqual(cleaned, [])
            assert.equal(
                env.events.filter(WorkspaceCleanupCompleted.is).length,
                0,
            )
        })
    })

    it("rejects forged Board requests and forged lease updates when authorities are bound", async () => {
        await withTempDir("git-authority-", async (dir) => {
            const cleaned: string[] = []
            const worktrees = {
                cleanup: async (storyId: string) => {
                    cleaned.push(storyId)
                },
            } as unknown as WorktreeManager
            const coordinator = new GitCoordinator({
                cwd: dir,
                gitGate: new GitGate(),
                worktrees,
                emitTui: false,
                eventDriven: true,
                runId: "run-authority",
                push: false,
            })
            const board = source("board")
            const broker = source("broker")
            const observer = source("observer")
            coordinator.setEventAuthority(board)
            coordinator.setLeaseAuthority(broker)
            const env = joinWithCapture(coordinator)
            const request = {
                storyId: "S1",
                prompt: "test",
                model: "standard",
                retries: 1,
                timeoutSecs: 60,
            }

            env.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-authority",
                    offerId: "offer-old",
                    leaseId: "lease-old",
                    workerId: "worker",
                    generation: 1,
                    request,
                }),
            )
            env.deliverSemanticEvent(
                observer,
                WorkLeaseGranted.create({
                    runId: "run-authority",
                    offerId: "offer-forged",
                    leaseId: "lease-forged",
                    workerId: "forged-worker",
                    generation: 2,
                    request,
                }),
            )
            const cleanup = WorkspaceCleanupRequested.create({
                runId: "run-authority",
                cleanupId: "cleanup-authority",
                storyId: "S1",
                leaseId: "lease-old",
                generation: 1,
            })

            env.deliverSemanticEvent(observer, cleanup)
            await coordinator.idle()
            assert.deepEqual(cleaned, [])
            assert.equal(env.events.filter(WorkspaceCleanupCompleted.is).length, 0)

            env.deliverSemanticEvent(board, cleanup)
            await coordinator.idle()
            assert.deepEqual(cleaned, ["S1"])
            assert.equal(env.events.filter(WorkspaceCleanupCompleted.is).length, 1)
        })
    })

    it("keeps an earlier story push failure through final push evaluation", async () => {
        await withTempDir("git-coordinator-", async (dir) => {
            git(dir, ["init", "-b", "main"])
            git(dir, ["config", "user.name", "Git Coordinator Test"])
            git(dir, ["config", "user.email", "git@test.invalid"])
            writeFileSync(join(dir, "README.md"), "base\n")
            git(dir, ["add", "README.md"])
            git(dir, ["commit", "-m", "base"])
            git(dir, ["remote", "add", "origin", join(dir, "missing-origin.git")])

            const coordinator = new GitCoordinator({
                cwd: dir,
                gitGate: new GitGate(),
                worktrees: null,
                emitTui: false,
                eventDriven: true,
                runId: "run-push-failure",
                push: true,
            })
            coordinator.setEventAuthority(BOARD)
            coordinator.setLeaseAuthority(BROKER)
            const env = joinWithCapture(coordinator)
            env.deliverSemanticEvent(
                BOARD,
                StoryIntegrationRequested.create({
                    runId: "run-push-failure",
                    leaseId: "lease-1",
                    storyId: "S1",
                    attempts: 1,
                    durationSecs: 1,
                }),
            )
            env.deliverSemanticEvent(
                BOARD,
                RunPushRequested.create({ runId: "run-push-failure" }),
            )
            await coordinator.idle()

            assert.equal(env.events.filter(RunPushFailed.is).length, 1)
            assert.equal(env.events.some(RunPushed.is), false)
        })
    })

    it("does not let a replayed old cleanup delete a newer lease generation", async () => {
        await withTempDir("git-cleanup-correlation-", async (dir) => {
            const cleaned: string[] = []
            const worktrees = {
                cleanup: async (storyId: string) => {
                    cleaned.push(storyId)
                },
            } as unknown as WorktreeManager
            const coordinator = new GitCoordinator({
                cwd: dir,
                gitGate: new GitGate(),
                worktrees,
                emitTui: false,
                eventDriven: true,
                runId: "run-cleanup",
                push: false,
            })
            coordinator.setEventAuthority(BOARD)
            coordinator.setLeaseAuthority(BROKER)
            const env = joinWithCapture(coordinator)
            const request = {
                storyId: "S1",
                prompt: "test",
                model: "standard",
                retries: 1,
                timeoutSecs: 60,
            }

            env.deliverSemanticEvent(
                BROKER,
                WorkLeaseGranted.create({
                    runId: "run-cleanup",
                    offerId: "offer-old",
                    leaseId: "lease-old",
                    workerId: "worker",
                    generation: 1,
                    request,
                }),
            )
            const oldCleanup = WorkspaceCleanupRequested.create({
                runId: "run-cleanup",
                cleanupId: "cleanup-old",
                storyId: "S1",
                leaseId: "lease-old",
                generation: 1,
            })
            env.deliverSemanticEvent(BOARD, oldCleanup)
            await coordinator.idle()
            assert.deepEqual(cleaned, ["S1"])

            env.deliverSemanticEvent(
                BROKER,
                WorkLeaseGranted.create({
                    runId: "run-cleanup",
                    offerId: "offer-new",
                    leaseId: "lease-new",
                    workerId: "worker",
                    generation: 2,
                    request,
                }),
            )
            env.deliverSemanticEvent(BOARD, oldCleanup)
            await coordinator.idle()

            assert.deepEqual(cleaned, ["S1"])
            const completions = env.events.filter(WorkspaceCleanupCompleted.is)
            assert.equal(completions.length, 2)
            assert.equal(completions[1]?.data.cleanupId, "cleanup-old")
        })
    })

    it("preserves a recoverable failed execution and surfaces its correlated branch", async () => {
        await withTempDir("git-preserved-cleanup-", async (dir) => {
            const preserved: string[] = []
            const worktrees = {
                cleanupFailed: async (storyId: string, preserve: boolean) => {
                    assert.equal(preserve, true)
                    preserved.push(storyId)
                    return "baro-recovery/run-preserve/S1/1"
                },
                cleanup: async () => undefined,
                branchName: (storyId: string) => `baro-wt/run-preserve/${storyId}`,
            } as unknown as WorktreeManager
            const coordinator = new GitCoordinator({
                cwd: dir,
                gitGate: new GitGate(),
                worktrees,
                emitTui: false,
                eventDriven: true,
                runId: "run-preserve",
                push: false,
            })
            coordinator.setEventAuthority(BOARD)
            coordinator.setLeaseAuthority(BROKER)
            const env = joinWithCapture(coordinator)
            const request = {
                storyId: "S1",
                prompt: "test",
                model: "standard",
                retries: 1,
                timeoutSecs: 60,
            }
            env.deliverSemanticEvent(
                BROKER,
                WorkLeaseGranted.create({
                    runId: "run-preserve",
                    offerId: "offer-1",
                    leaseId: "lease-1",
                    workerId: "worker",
                    generation: 3,
                    request,
                }),
            )
            const cleanup = WorkspaceCleanupRequested.create({
                runId: "run-preserve",
                cleanupId: "cleanup-1",
                storyId: "S1",
                leaseId: "lease-1",
                generation: 3,
                preserveForRecovery: true,
            })
            env.deliverSemanticEvent(BOARD, cleanup)
            await coordinator.idle()

            assert.deepEqual(preserved, ["S1"])
            const completed = env.events.filter(WorkspaceCleanupCompleted.is)
            assert.equal(completed.length, 1)
            assert.equal(completed[0]?.data.runId, "run-preserve")
            assert.equal(completed[0]?.data.leaseId, "lease-1")
            assert.equal(completed[0]?.data.generation, 3)
            assert.equal(
                completed[0]?.data.preservedBranch,
                "baro-recovery/run-preserve/S1/1",
            )

            env.deliverSemanticEvent(BOARD, cleanup)
            await coordinator.idle()
            assert.deepEqual(preserved, ["S1"], "replay does not snapshot twice")
            const replayed = env.events.filter(WorkspaceCleanupCompleted.is)
            assert.equal(replayed.length, 2)
            assert.equal(
                replayed[1]?.data.preservedBranch,
                "baro-recovery/run-preserve/S1/1",
                "replay retains the original preservation result",
            )
        })
    })

    it("reports preservation failure without claiming cleanup completed", async () => {
        await withTempDir("git-preservation-failure-", async (dir) => {
            const worktrees = {
                cleanupFailed: async () => {
                    throw new Error("commit hook rejected snapshot")
                },
                cleanup: async () => undefined,
                branchName: (storyId: string) => `baro-wt/run-retained/${storyId}`,
            } as unknown as WorktreeManager
            const coordinator = new GitCoordinator({
                cwd: dir,
                gitGate: new GitGate(),
                worktrees,
                emitTui: false,
                eventDriven: true,
                runId: "run-retained",
                push: false,
            })
            coordinator.setEventAuthority(BOARD)
            coordinator.setLeaseAuthority(BROKER)
            const env = joinWithCapture(coordinator)
            env.deliverSemanticEvent(
                BOARD,
                WorkspaceCleanupRequested.create({
                    runId: "run-retained",
                    cleanupId: "cleanup-retained",
                    storyId: "S1",
                    leaseId: "lease-1",
                    generation: 1,
                    preserveForRecovery: true,
                }),
            )
            await coordinator.idle()

            assert.equal(env.events.filter(WorkspaceCleanupCompleted.is).length, 0)
            const failed = env.events.filter(WorkspaceCleanupFailed.is)
            assert.equal(failed.length, 1)
            assert.equal(failed[0]?.data.leaseId, "lease-1")
            assert.equal(failed[0]?.data.generation, 1)
            assert.equal(failed[0]?.data.retainedBranch, "baro-wt/run-retained/S1")
            assert.match(failed[0]?.data.error ?? "", /commit hook rejected snapshot/)
        })
    })
})

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}
