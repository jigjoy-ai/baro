import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type { AgenticEnvironment } from "../../src/runtime/mozaik.js"

import { StoryFactory } from "../../src/market/story-factory.js"
import type {
    StoryExecution,
    StoryExecOpts,
    StoryExecutor,
} from "../../src/execution/story-executor.js"
import type { ReverifiedGateCommand } from "../../src/execution/commit-reverification.js"
import type { StoryRoute } from "../../src/market/routing.js"
import {
    AgentResult,
    StoryResult,
    StorySpawnRequest,
    WorkLeaseGranted,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import type { WorktreeManager } from "../../src/integration/worktree.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { joinWithCapture, source, withTempDir } from "../execution/helpers.js"

const PRESERVED = "baro-recovery/run/S3/1"
const RESTORED = { path: "/tmp/wt/S3", head: "f93f741" + "0".repeat(33) }
const GREEN: readonly ReverifiedGateCommand[] = [
    { command: "npm run build", passed: true, output: "[host gate: passed in 4s]\nbuilt" },
]
const RED: readonly ReverifiedGateCommand[] = [
    { command: "npm run build", passed: false, output: "[host gate: failed in 4s]\nTS2322" },
]

class CapturingExecutor implements StoryExecutor {
    public calls: Array<{ req: StorySpawnRequestData; cwd: string }> = []

    start(
        req: StorySpawnRequestData,
        _route: StoryRoute,
        cwd: string,
        _env: AgenticEnvironment,
        opts: StoryExecOpts,
    ): StoryExecution {
        this.calls.push({ req, cwd })
        opts.registerResultAuthority?.(source("agent"))
        return { dispose: () => {} }
    }
}

function worktreeDouble(restore: () => Promise<typeof RESTORED | null>) {
    const createCalls: string[] = []
    const restoreCalls: Array<[string, string]> = []
    const manager = {
        create: async (storyId: string) => {
            createCalls.push(storyId)
            return `/tmp/wt/fresh/${storyId}`
        },
        restoreAgentCommits: async (storyId: string, ref: string) => {
            restoreCalls.push([storyId, ref])
            return restore()
        },
    } as unknown as WorktreeManager
    return { manager, createCalls, restoreCalls }
}

function spawn() {
    return StorySpawnRequest.create({
        storyId: "S3",
        prompt: "Implement S3",
        model: "sonnet",
        retries: 0,
        timeoutSecs: 30,
        recovery: { kind: "infrastructure", reason: "no output for 600s", branch: PRESERVED },
        resume: { preservedBranch: PRESERVED, reverify: true },
    })
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
}

describe("StoryFactory re-verification of an unjudged attempt", () => {
    it("settles a green preserved commit without spawning an agent", async () => {
        await withTempDir("story-factory-reverify-green-", async (dir) => {
            const executor = new CapturingExecutor()
            const { manager, createCalls, restoreCalls } = worktreeDouble(
                async () => RESTORED,
            )
            const gated: string[] = []
            const factory = new StoryFactory({
                cwd: dir,
                executor,
                worktrees: manager,
                commitGate: async (cwd) => {
                    gated.push(cwd)
                    return GREEN
                },
            })
            const env = joinWithCapture(factory)

            await factory.onExternalEvent(source("conductor"), spawn())
            await settle()

            assert.deepEqual(restoreCalls, [["S3", PRESERVED]])
            assert.deepEqual(gated, [RESTORED.path])
            assert.deepEqual(createCalls, [])
            assert.equal(executor.calls.length, 0, "no agent attempt was spent")
            const terminal = env.events.find(AgentResult.is)
            assert.match(terminal?.data.resultText ?? "", /PASS {2}npm run build/)
            const result = env.events.find(StoryResult.is)
            assert.equal(result?.data.success, true)
            assert.equal(result?.data.attempts, 0)
        })
    })

    for (const [name, restore, gate] of [
        ["the gate is red", async () => RESTORED, RED],
        ["the gate is inconclusive", async () => RESTORED, null],
        ["the agent committed nothing", async () => null, GREEN],
        ["the replay conflicts", async () => { throw new Error("replay conflicted") }, GREEN],
    ] as const) {
        it(`starts a fresh attempt when ${name}`, async () => {
            await withTempDir("story-factory-reverify-fallback-", async (dir) => {
                const executor = new CapturingExecutor()
                const { manager, createCalls } = worktreeDouble(restore)
                const factory = new StoryFactory({
                    cwd: dir,
                    executor,
                    worktrees: manager,
                    commitGate: async () => gate,
                })
                const env = joinWithCapture(factory)

                await factory.onExternalEvent(source("conductor"), spawn())
                await settle()

                assert.deepEqual(createCalls, ["S3"])
                assert.equal(executor.calls.length, 1)
                assert.equal(executor.calls[0]?.cwd, "/tmp/wt/fresh/S3")
                assert.equal(env.events.some(StoryResult.is), false)
            })
        })
    }

    it("binds a re-verified collective result to the exact lease", async () => {
        await withTempDir("story-factory-reverify-collective-", async (dir) => {
            const runId = "run-reverify"
            const broker = source("broker")
            const executor = new CapturingExecutor()
            const outcomeAuthority = new StoryOutcomeAuthority(runId)
            const { manager } = worktreeDouble(async () => RESTORED)
            const factory = new StoryFactory({
                cwd: dir,
                coordinationMode: "collective",
                runId,
                workerId: "worker-a",
                leaseAuthority: broker,
                offerAuthority: source("board"),
                outcomeAuthority,
                executor,
                worktrees: manager,
                commitGate: async () => GREEN,
            })
            const env = joinWithCapture(factory)

            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S3-2",
                    leaseId: "lease-S3-2",
                    workerId: "worker-a",
                    generation: 2,
                    request: spawn().data,
                }),
            )
            await settle()

            assert.equal(executor.calls.length, 0)
            const result = env.events.find(StoryResult.is)
            assert.equal(result?.data.success, true)
            assert.equal(result?.data.runId, runId)
            assert.equal(result?.data.leaseId, "lease-S3-2")
            assert.equal(result?.data.generation, 2)
            assert.equal(
                outcomeAuthority.terminalCorrelationForSource(
                    source("agent"),
                    "S3",
                ),
                null,
                "only the re-verifying participant speaks for this lease",
            )
        })
    })
})
