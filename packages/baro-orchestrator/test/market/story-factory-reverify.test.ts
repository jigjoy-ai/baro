import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type { CoordinationBus } from "../../src/runtime/coordination.js"

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
    WorkLeaseGranted,
    WorkLeaseReleased,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import type { WorktreeManager } from "../../src/integration/worktree.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { joinWithCapture, source, withTempDir } from "../execution/helpers.js"
import { RUN_ID, WORKER_ID, leasedFactory } from "./lease-fixture.js"

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
        _env: CoordinationBus,
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

function spawnRequest() {
    return {
        prompt: "Implement S3",
        recovery: { kind: "infrastructure", reason: "no output for 600s", branch: PRESERVED },
        resume: { preservedBranch: PRESERVED, reverify: true },
    } as const
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
            const gated: Array<[string, string]> = []
            const { env, lease } = leasedFactory({
                cwd: dir,
                executor,
                worktrees: manager,
                commitGate: async (storyId, cwd) => {
                    gated.push([storyId, cwd])
                    return GREEN
                },
            })

            await lease("S3", spawnRequest())
            await settle()

            assert.deepEqual(restoreCalls, [["S3", PRESERVED]])
            assert.deepEqual(gated, [["S3", RESTORED.path]], "the gate is the story's")
            assert.deepEqual(createCalls, [])
            assert.equal(executor.calls.length, 0, "no agent attempt was spent")
            const terminal = env.events.find(AgentResult.is)
            const told = terminal?.payload.resultText ?? ""
            assert.doesNotMatch(told, /PASS/, "the Critic is not handed a verdict")
            assert.match(told, /may have stopped partway/)
            assert.match(told, /does not show the change is complete/)
            const result = env.events.find(StoryResult.is)
            assert.equal(result?.payload.success, true)
            assert.equal(result?.payload.attempts, 0)
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
                const { env, lease } = leasedFactory({
                    cwd: dir,
                    executor,
                    worktrees: manager,
                    commitGate: async () => gate,
                })

                await lease("S3", spawnRequest())
                await settle()

                assert.deepEqual(createCalls, ["S3"])
                assert.equal(executor.calls.length, 1)
                assert.equal(executor.calls[0]?.cwd, "/tmp/wt/fresh/S3")
                assert.equal(env.events.some(StoryResult.is), false)
            })
        })
    }

    it("aborts the gate when its lease is released and starts nothing for it", async () => {
        await withTempDir("story-factory-reverify-released-", async (dir) => {
            const executor = new CapturingExecutor()
            const { manager, createCalls } = worktreeDouble(async () => RESTORED)
            let gateSignal: AbortSignal | null = null
            const { factory, broker, env, lease } = leasedFactory({
                cwd: dir,
                executor,
                worktrees: manager,
                commitGate: (_storyId, _cwd, signal) => {
                    gateSignal = signal
                    return new Promise((resolve) =>
                        signal.addEventListener("abort", () => resolve(null), { once: true }),
                    )
                },
            })

            await lease("S3", spawnRequest())
            await settle()
            assert.ok(gateSignal, "the gate is running")
            assert.equal((gateSignal as AbortSignal).aborted, false)

            await factory.onExternalEvent(
                broker,
                WorkLeaseReleased.create({
                    runId: RUN_ID,
                    offerId: "offer-S3",
                    leaseId: "lease-S3",
                    storyId: "S3",
                    workerId: WORKER_ID,
                    reason: "aborted",
                }),
            )
            await settle()

            assert.equal((gateSignal as AbortSignal).aborted, true)
            assert.deepEqual(createCalls, [])
            assert.equal(executor.calls.length, 0)
            assert.equal(env.events.some(StoryResult.is), false)
        })
    })

    it("binds a re-verified collective result to the exact lease", async () => {
        await withTempDir("story-factory-reverify-collective-", async (dir) => {
            const runId = "run-reverify"
            const broker = source("broker")
            const executor = new CapturingExecutor()
            const outcomeAuthority = new StoryOutcomeAuthority(runId)
            const { manager } = worktreeDouble(async () => RESTORED)
            const factory = new StoryFactory({
                cwd: dir,
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
                    request: {
                        storyId: "S3",
                        model: "sonnet",
                        retries: 0,
                        timeoutSecs: 30,
                        ...spawnRequest(),
                    },
                }),
            )
            await settle()

            assert.equal(executor.calls.length, 0)
            const result = env.events.find(StoryResult.is)
            assert.equal(result?.payload.success, true)
            assert.equal(result?.payload.runId, runId)
            assert.equal(result?.payload.leaseId, "lease-S3-2")
            assert.equal(result?.payload.generation, 2)
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
