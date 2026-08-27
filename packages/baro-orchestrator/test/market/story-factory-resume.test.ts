import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type { AgenticEnvironment } from "../../src/runtime/mozaik.js"

import { StoryFactory } from "../../src/market/story-factory.js"
import type {
    StoryExecution,
    StoryExecOpts,
    StoryExecutor,
} from "../../src/execution/story-executor.js"
import type { StoryRoute } from "../../src/market/routing.js"
import {
    StorySpawnFailed,
    StorySpawnRequest,
    WorkLeaseGranted,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import type { WorktreeManager } from "../../src/integration/worktree.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { joinWithCapture, source, withTempDir } from "../execution/helpers.js"

const PRESERVED = "baro-recovery/run/S1/1"
const RESUMED_PATH = "/tmp/wt/S1"

class CapturingExecutor implements StoryExecutor {
    public readonly resultSource = source("capturing-result-source")
    public calls: Array<{ req: StorySpawnRequestData; cwd: string }> = []

    start(
        req: StorySpawnRequestData,
        _route: StoryRoute,
        cwd: string,
        _env: AgenticEnvironment,
        opts: StoryExecOpts,
    ): StoryExecution {
        this.calls.push({ req, cwd })
        opts.registerResultAuthority?.(this.resultSource)
        return { dispose: () => {} }
    }
}

function worktreeDouble(opts: { resumeError?: Error } = {}): {
    manager: WorktreeManager
    createCalls: string[]
    resumeCalls: Array<{ storyId: string; opts: { restoreFrom?: string } }>
} {
    const createCalls: string[] = []
    const resumeCalls: Array<{
        storyId: string
        opts: { restoreFrom?: string }
    }> = []
    const manager = {
        create: async (storyId: string) => {
            createCalls.push(storyId)
            return `/tmp/wt/created/${storyId}`
        },
        resumeFromSuspension: async (
            storyId: string,
            resumeOpts: { restoreFrom?: string } = {},
        ) => {
            resumeCalls.push({ storyId, opts: resumeOpts })
            if (opts.resumeError) throw opts.resumeError
            return {
                mode: "rebased",
                baseSha: "0".repeat(40),
                previousBaseSha: null,
                restoredFrom: resumeOpts.restoreFrom ?? null,
            }
        },
        activePath: (storyId: string) =>
            storyId === "S1" && resumeCalls.length > 0 ? RESUMED_PATH : null,
    } as unknown as WorktreeManager
    return { manager, createCalls, resumeCalls }
}

function spawn(resume?: { preservedBranch: string | null }) {
    return StorySpawnRequest.create({
        storyId: "S1",
        prompt: "Implement S1",
        model: "sonnet",
        retries: 0,
        timeoutSecs: 30,
        ...(resume ? { resume } : {}),
    })
}

describe("StoryFactory suspension resume routing", () => {
    it("routes a resume with preserved material through the host-owned resume step", async () => {
        await withTempDir("story-factory-resume-", async (dir) => {
            const executor = new CapturingExecutor()
            const { manager, createCalls, resumeCalls } = worktreeDouble()
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "claude",
                worktrees: manager,
            })
            joinWithCapture(factory)

            await factory.onExternalEvent(
                source("conductor"),
                spawn({ preservedBranch: PRESERVED }),
            )

            assert.deepEqual(resumeCalls, [
                { storyId: "S1", opts: { restoreFrom: PRESERVED } },
            ])
            assert.deepEqual(createCalls, [])
            assert.equal(executor.calls.length, 1)
            assert.equal(executor.calls[0]?.cwd, RESUMED_PATH)
        })
    })

    it("treats a resume with no surviving material as a resume, not a fresh create", async () => {
        await withTempDir("story-factory-resume-empty-", async (dir) => {
            const executor = new CapturingExecutor()
            const { manager, createCalls, resumeCalls } = worktreeDouble()
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "claude",
                worktrees: manager,
            })
            joinWithCapture(factory)

            await factory.onExternalEvent(
                source("conductor"),
                spawn({ preservedBranch: null }),
            )

            assert.deepEqual(resumeCalls, [{ storyId: "S1", opts: {} }])
            assert.deepEqual(createCalls, [])
            assert.equal(executor.calls[0]?.cwd, RESUMED_PATH)
        })
    })

    it("leaves a first spawn on the unchanged create path", async () => {
        await withTempDir("story-factory-resume-absent-", async (dir) => {
            const executor = new CapturingExecutor()
            const { manager, createCalls, resumeCalls } = worktreeDouble()
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "claude",
                worktrees: manager,
            })
            joinWithCapture(factory)

            await factory.onExternalEvent(source("conductor"), spawn())

            assert.deepEqual(createCalls, ["S1"])
            assert.deepEqual(resumeCalls, [])
            assert.equal(executor.calls[0]?.cwd, "/tmp/wt/created/S1")
        })
    })

    it("refuses the spawn fail-closed when the host-owned resume rejects", async () => {
        await withTempDir("story-factory-resume-refused-", async (dir) => {
            const executor = new CapturingExecutor()
            const { manager, createCalls, resumeCalls } = worktreeDouble({
                resumeError: new Error("replay conflicted"),
            })
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                llm: "claude",
                worktrees: manager,
                requireWorktree: true,
            })
            const env = joinWithCapture(factory)

            await factory.onExternalEvent(
                source("conductor"),
                spawn({ preservedBranch: PRESERVED }),
            )

            assert.equal(resumeCalls.length, 1)
            assert.deepEqual(createCalls, [])
            assert.equal(executor.calls.length, 0)
            const failure = env.events.find(StorySpawnFailed.is)
            assert.match(
                failure?.data.error ?? "",
                /isolated worktree unavailable for S1/,
            )
        })
    })

    it("propagates the resume directive from the lease grant into the spawn request", async () => {
        await withTempDir("story-factory-resume-propagate-", async (dir) => {
            const broker = source("broker")
            const board = source("board")
            const executor = new CapturingExecutor()
            const { manager, resumeCalls } = worktreeDouble()
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId: "run-resume-propagate",
                workerId: "worker-a",
                leaseAuthority: broker,
                offerAuthority: board,
                outcomeAuthority: new StoryOutcomeAuthority(
                    "run-resume-propagate",
                ),
                executor,
                worktrees: manager,
            })
            const env = joinWithCapture(factory)

            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-resume-propagate",
                    offerId: "offer-S1",
                    leaseId: "lease-S1-2",
                    workerId: "worker-a",
                    generation: 2,
                    request: {
                        storyId: "S1",
                        prompt: "Implement S1",
                        model: "sonnet",
                        retries: 0,
                        timeoutSecs: 30,
                        resume: { preservedBranch: PRESERVED },
                    },
                }),
            )
            await new Promise<void>((resolve) => setImmediate(resolve))
            await new Promise<void>((resolve) => setImmediate(resolve))

            const requested = env.events.find(StorySpawnRequest.is)
            assert.deepEqual(requested?.data.resume, {
                preservedBranch: PRESERVED,
            })
            assert.deepEqual(resumeCalls, [
                { storyId: "S1", opts: { restoreFrom: PRESERVED } },
            ])
        })
    })
})
