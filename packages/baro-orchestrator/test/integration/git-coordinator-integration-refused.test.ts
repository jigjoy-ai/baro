import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { GitGate } from "../../src/integration/git.js"
import { GitCoordinator } from "../../src/integration/git-coordinator.js"
import {
    WorktreeRefusalError,
    type WorktreeManager,
} from "../../src/integration/worktree.js"
import {
    IntegrationRefused,
    StoryIntegrationRequested,
    StoryMergeFailed,
    WorkLeaseGranted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "../execution/helpers.js"

const BOARD = source("board")
const BROKER = source("broker")

function coordinatorFor(dir: string, worktrees: WorktreeManager) {
    const coordinator = new GitCoordinator({
        cwd: dir,
        gitGate: new GitGate(),
        worktrees,
        emitTui: false,
        eventDriven: true,
        runId: "run-refused",
        push: false,
    })
    coordinator.setEventAuthority(BOARD)
    coordinator.setLeaseAuthority(BROKER)
    return coordinator
}

function requestIntegration(
    env: ReturnType<typeof joinWithCapture>,
    extra: Record<string, unknown> = {},
) {
    env.deliverSemanticEvent(
        BOARD,
        StoryIntegrationRequested.create({
            runId: "run-refused",
            leaseId: "lease-1",
            storyId: "S1",
            attempts: 1,
            durationSecs: 1,
            ...extra,
        }),
    )
}

describe("GitCoordinator integration_refused", () => {
    it("names the refusing invariant and the preserved recovery ref", async () => {
        await withTempDir("git-refused-recoverable-", async (dir) => {
            const worktrees = {
                mergeBack: async () => {
                    throw new WorktreeRefusalError(
                        "sealed_merge_lineage",
                        "run branch moved outside the host-owned resume",
                    )
                },
                branchName: () => "baro/S1",
                prepareConflictRetry: async () => "baro-recovery/run/S1/1",
                activePath: () => "/tmp/wt/S1",
                recoveryRef: () => null,
            } as unknown as WorktreeManager
            const coordinator = coordinatorFor(dir, worktrees)
            const env = joinWithCapture(coordinator)

            requestIntegration(env)
            await coordinator.idle()

            const refused = env.events.filter(IntegrationRefused.is)
            assert.equal(refused.length, 1)
            assert.deepEqual(refused[0]!.data, {
                runId: "run-refused",
                storyId: "S1",
                leaseId: "lease-1",
                invariant: "sealed_merge_lineage",
                detail: "run branch moved outside the host-owned resume",
                recoveryRef: "baro-recovery/run/S1/1",
                worktreeRetained: true,
                recoverable: true,
                retryable: true,
                branch: "baro-recovery/run/S1/1",
            })

            // The refusal itself is unchanged: the Board still keys on this.
            const failure = env.events.find(StoryMergeFailed.is)
            assert.ok(failure)
            assert.equal(failure.data.branch, "baro-recovery/run/S1/1")
            assert.equal(failure.data.retryable, true)
        })
    })

    it("reports a refusal whose work no material survived as unrecoverable", async () => {
        await withTempDir("git-refused-lost-", async (dir) => {
            const worktrees = {
                mergeBack: async () => {
                    throw new WorktreeRefusalError(
                        "merge_conflict",
                        "merge-back conflicted",
                    )
                },
                branchName: () => "baro/S1",
                prepareConflictRetry: async () => {
                    throw new Error("recovery ref could not be written")
                },
                activePath: () => null,
                recoveryRef: () => null,
            } as unknown as WorktreeManager
            const coordinator = coordinatorFor(dir, worktrees)
            const env = joinWithCapture(coordinator)

            requestIntegration(env)
            await coordinator.idle()

            const refused = env.events.filter(IntegrationRefused.is)
            assert.equal(refused.length, 1)
            assert.equal(refused[0]!.data.invariant, "merge_conflict")
            assert.equal(refused[0]!.data.recoveryRef, null)
            assert.equal(refused[0]!.data.worktreeRetained, false)
            assert.equal(refused[0]!.data.recoverable, false)
            assert.equal(refused[0]!.data.retryable, false)
            assert.equal(refused[0]!.data.branch, "baro/S1")

            const failure = env.events.find(StoryMergeFailed.is)
            assert.ok(failure)
            assert.match(failure.data.error, /recovery preparation failed/)
        })
    })

    it("refuses a story whose isolated worktree is gone", async () => {
        await withTempDir("git-refused-missing-worktree-", async (dir) => {
            const worktrees = {
                mergeBack: async () => false,
                branchName: () => "baro/S1",
                activePath: () => null,
                recoveryRef: () => null,
            } as unknown as WorktreeManager
            const coordinator = coordinatorFor(dir, worktrees)
            const env = joinWithCapture(coordinator)

            requestIntegration(env)
            await coordinator.idle()

            const refused = env.events.filter(IntegrationRefused.is)
            assert.equal(refused.length, 1)
            assert.deepEqual(refused[0]!.data, {
                runId: "run-refused",
                storyId: "S1",
                leaseId: "lease-1",
                invariant: "worktree_missing",
                detail: "isolated worktree state missing for S1",
                recoveryRef: null,
                worktreeRetained: false,
                recoverable: false,
                retryable: false,
                branch: null,
            })
            assert.ok(env.events.find(StoryMergeFailed.is))
        })
    })

    it("classifies a missing seal marker instead of reporting an unknown refusal", async () => {
        await withTempDir("git-refused-seal-", async (dir) => {
            const worktrees = {
                mergeBack: async () => true,
                activePath: () => "/tmp/wt/S1",
                recoveryRef: () => "baro-recovery/run/S1/2",
            } as unknown as WorktreeManager
            const coordinator = coordinatorFor(dir, worktrees)
            const env = joinWithCapture(coordinator)

            env.deliverSemanticEvent(
                BROKER,
                WorkLeaseGranted.create({
                    runId: "run-refused",
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
            requestIntegration(env)
            await coordinator.idle()

            const refused = env.events.filter(IntegrationRefused.is)
            assert.equal(refused.length, 1)
            assert.equal(refused[0]!.data.invariant, "seal_missing")
            assert.equal(
                refused[0]!.data.detail,
                "reviewed candidate seal marker is missing for story S1",
            )
            // Nothing merged, so the accepted work is still recoverable.
            assert.equal(refused[0]!.data.recoveryRef, "baro-recovery/run/S1/2")
            assert.equal(refused[0]!.data.recoverable, true)
            assert.equal(refused[0]!.data.retryable, false)

            const failure = env.events.find(StoryMergeFailed.is)
            assert.ok(failure)
            assert.match(failure.data.error, /candidate seal marker is missing/)
        })
    })

    it("classifies a missing candidate fingerprint", async () => {
        await withTempDir("git-refused-fingerprint-", async (dir) => {
            const worktrees = {
                mergeBack: async () => true,
                activePath: () => "/tmp/wt/S1",
                recoveryRef: () => null,
            } as unknown as WorktreeManager
            const coordinator = coordinatorFor(dir, worktrees)
            const env = joinWithCapture(coordinator)

            requestIntegration(env, { candidateFingerprintRequired: true })
            await coordinator.idle()

            const refused = env.events.filter(IntegrationRefused.is)
            assert.equal(refused.length, 1)
            assert.equal(refused[0]!.data.invariant, "fingerprint_missing")
            assert.equal(
                refused[0]!.data.detail,
                "reviewed candidate fingerprint is missing or invalid for story S1",
            )
            assert.equal(refused[0]!.data.worktreeRetained, true)
            assert.equal(refused[0]!.data.recoverable, true)
        })
    })

    it("keeps a refusal a refusal when a worktree accessor itself misbehaves", async () => {
        await withTempDir("git-refused-best-effort-", async (dir) => {
            const worktrees = {
                mergeBack: async () => false,
                branchName: () => "baro/S1",
                activePath: () => {
                    throw new Error("worktree registry is unreadable")
                },
                recoveryRef: () => {
                    throw new Error("worktree registry is unreadable")
                },
            } as unknown as WorktreeManager
            const coordinator = coordinatorFor(dir, worktrees)
            const env = joinWithCapture(coordinator)

            requestIntegration(env)
            await coordinator.idle()

            const refused = env.events.filter(IntegrationRefused.is)
            assert.equal(refused.length, 1)
            assert.equal(refused[0]!.data.invariant, "worktree_missing")
            assert.equal(refused[0]!.data.worktreeRetained, false)
            assert.equal(refused[0]!.data.recoverable, false)

            // The unreadable accessor must not have upgraded the refusal into
            // a crash, nor suppressed the failure the Board acts on.
            const failure = env.events.find(StoryMergeFailed.is)
            assert.ok(failure)
            assert.equal(
                failure.data.error,
                "isolated worktree state missing for S1",
            )
        })
    })
})
