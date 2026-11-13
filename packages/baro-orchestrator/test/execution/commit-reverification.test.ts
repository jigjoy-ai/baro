import { describe, it } from "@rstest/core"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { CriticCommandEvidenceCollector } from "../../src/acceptance/critic-evidence.js"
import {
    ReverifiedCommitExecutor,
    commitGatePassed,
    runCommitGate,
    storyCommitGate,
    type ReverifiedGateCommand,
} from "../../src/execution/commit-reverification.js"
import { ContinuousGateRunner } from "../../src/verification/continuous-gate-runner.js"
import type { VerifyPlan } from "../../src/verification/verify.js"
import type { StoryRoute } from "../../src/market/routing.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { AgentResult, StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

const GREEN: readonly ReverifiedGateCommand[] = [
    { command: "npm run build", passed: true, output: "[host gate: passed in 4s]\nbuilt ok" },
    { command: "npm test -- verify", passed: true, output: "[host gate: passed in 9s]\n# pass 12" },
]

/** A committed story change, so the collector fingerprints real content. */
function committedRepo(dir: string): string {
    const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
    git("init", "-b", "main")
    git("config", "user.email", "t@t.t")
    git("config", "user.name", "t")
    writeFileSync(join(dir, "a.txt"), "base\n")
    git("add", "-A")
    git("commit", "-m", "base")
    const baseSha = git("rev-parse", "HEAD")
    writeFileSync(join(dir, "a.txt"), "green fix\n")
    git("commit", "-am", "fix")
    return baseSha
}

describe("ReverifiedCommitExecutor", () => {
    it("hands the host's gate run to the Critic as fresh evidence from the leased story", async () => {
        await withTempDir("commit-reverify-evidence-", async (dir) => {
            const baseSha = committedRepo(dir)
            const runId = "run-reverify-evidence"
            const authority = new StoryOutcomeAuthority(runId)
            const env = captureEnv()
            const collector = new CriticCommandEvidenceCollector({
                outcomeAuthority: authority,
                resolveRepositoryTarget: () => ({ cwd: dir, baseSha }),
            })
            collector.join(env)

            new ReverifiedCommitExecutor("f93f741abcdef", GREEN).start(
                {
                    storyId: "S3",
                    prompt: "Implement S3",
                    model: "sonnet",
                    retries: 0,
                    timeoutSecs: 30,
                    runId,
                    leaseId: "lease-2",
                    generation: 2,
                },
                {} as StoryRoute,
                dir,
                env,
                {
                    registerResultAuthority: (participant) =>
                        authority.registerResultAuthority(
                            { runId, storyId: "S3", leaseId: "lease-2", generation: 2 },
                            participant,
                        ),
                },
            )
            await new Promise<void>((resolve) => setImmediate(resolve))

            const snapshot = await collector.snapshotForEvaluation("S3")
            assert.deepEqual(snapshot?.commands, [
                {
                    command: "npm run build && npm test -- verify",
                    terminal: true,
                    freshness: "fresh",
                    sandboxBlocked: false,
                },
            ])
            assert.match(snapshot?.text ?? "", /built ok/)
            assert.match(snapshot?.text ?? "", /# pass 12/)

            const terminalIndex = env.events.findIndex(AgentResult.is)
            const resultIndex = env.events.findIndex(StoryResult.is)
            assert.ok(terminalIndex >= 0 && terminalIndex < resultIndex)
            const terminal = env.events[terminalIndex]
            assert.ok(AgentResult.is(terminal))
            assert.equal(terminal.payload.isError, false)
            assert.match(terminal.payload.resultText ?? "", /committing f93f741abcde/)
            const result = env.events[resultIndex]
            assert.ok(StoryResult.is(result))
            assert.deepEqual(
                {
                    success: result.payload.success,
                    attempts: result.payload.attempts,
                    leaseId: result.payload.leaseId,
                    generation: result.payload.generation,
                },
                { success: true, attempts: 0, leaseId: "lease-2", generation: 2 },
            )
        })
    })
})

describe("commit gate", () => {
    it("is green only when something ran and every command passed", () => {
        assert.equal(commitGatePassed(GREEN), true)
        assert.equal(commitGatePassed(null), false)
        assert.equal(commitGatePassed([]), false)
        assert.equal(
            commitGatePassed([...GREEN, { command: "npm run lint", passed: false, output: "" }]),
            false,
        )
    })

    it("is inconclusive when the project declares nothing to run", async () => {
        await withTempDir("commit-gate-empty-", async (dir) => {
            assert.equal(await runCommitGate(dir), null)
        })
    })
})

const PROJECT_SUITE: VerifyPlan = {
    commands: [{ label: "node -e 0", tool: "node", args: ["-e", "0"] }],
}

/** A project whose existing suite is green, and a PRD whose S3 declares a
 * test that the crashed attempt's partial commit does not yet satisfy. */
// Bare `node <file>` rather than `node --test`: a nested test runner reports
// to this one through NODE_TEST_CONTEXT instead of failing its own exit code.
function storyProject(dir: string, s3Passes: boolean, s3Tests = ["node test/s3.mjs"]): string {
    mkdirSync(join(dir, "test"), { recursive: true })
    writeFileSync(
        join(dir, "test", "s3.mjs"),
        s3Passes ? "process.exit(0)\n" : "console.error('S3 not done')\nprocess.exit(1)\n",
    )
    const prdPath = join(dir, "prd.json")
    writeFileSync(
        prdPath,
        JSON.stringify({
            project: "p",
            userStories: [
                { id: "S3", tests: s3Tests },
                { id: "S4", tests: [] },
            ],
        }),
    )
    return prdPath
}

describe("story commit gate", () => {
    it("runs the story's declared tests, so a partial commit on a green suite is not green", async () => {
        await withTempDir("story-gate-partial-", async (dir) => {
            const gate = storyCommitGate({
                basePlan: PROJECT_SUITE,
                planRoot: dir,
                prdPath: storyProject(dir, false),
            })

            const result = await gate("S3", dir, new AbortController().signal)

            assert.equal(commitGatePassed(result), false)
            assert.deepEqual(
                result?.map(({ command, passed }) => [command, passed]),
                [["node -e 0", true], ["node test/s3.mjs", false]],
            )
        })
    })

    it("is green only once the story's own tests pass too", async () => {
        await withTempDir("story-gate-done-", async (dir) => {
            const gate = storyCommitGate({
                basePlan: PROJECT_SUITE,
                planRoot: dir,
                prdPath: storyProject(dir, true),
            })

            const result = await gate("S3", dir, new AbortController().signal)

            assert.equal(commitGatePassed(result), true)
            assert.deepEqual(result?.map(({ command }) => command), [
                "node -e 0",
                "node test/s3.mjs",
            ])
        })
    })

    it("has no verdict for a story without tests or with a test it cannot run", async () => {
        await withTempDir("story-gate-untested-", async (dir) => {
            const signal = new AbortController().signal
            const untested = storyCommitGate({
                basePlan: PROJECT_SUITE,
                planRoot: dir,
                prdPath: storyProject(dir, true),
            })
            assert.equal(await untested("S4", dir, signal), null, "a green suite alone proves nothing about S4")

            const unrunnable = storyCommitGate({
                basePlan: PROJECT_SUITE,
                planRoot: dir,
                prdPath: storyProject(join(dir, "sub"), true, ["frobnicate --all"]),
            })
            assert.equal(await unrunnable("S3", dir, signal), null)
        })
    })

    it("waits for the continuous gate in flight instead of running beside it", async () => {
        await withTempDir("story-gate-queue-", async (dir) => {
            let release!: () => void
            const blocked = new Promise<void>((resolve) => { release = resolve })
            const runner = new ContinuousGateRunner({
                runId: "run-queue",
                resolveTarget: () => ({ cwd: dir }),
                settleMs: 1,
                runGates: async () => {
                    await blocked
                    return []
                },
            })
            ;(runner as unknown as { getBuses(): unknown[] }).getBuses = () => []
            runner.onExternalFunctionCall(
                { agentId: "S1" } as never,
                { name: "Write", callId: "c", arguments: "{}" } as never,
            )
            await new Promise((resolve) => setTimeout(resolve, 20))
            let queued = 0
            let started = false
            const gate = storyCommitGate({
                basePlan: PROJECT_SUITE,
                planRoot: dir,
                prdPath: storyProject(dir, true),
                exclusive: (work) => {
                    queued += 1
                    return runner.exclusive((signal) => {
                        started = true
                        return work(signal)
                    })
                },
            })

            const pending = gate("S3", dir, new AbortController().signal)
            await new Promise((resolve) => setTimeout(resolve, 50))
            assert.equal(queued, 1)
            assert.equal(started, false, "a full test run is already in flight")

            release()
            assert.equal(commitGatePassed(await pending), true)
            assert.equal(started, true)
            runner.stop()
        })
    })
})
