import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { CriticCommandEvidenceCollector } from "../../src/acceptance/critic-evidence.js"
import {
    ReverifiedCommitExecutor,
    commitGatePassed,
    runCommitGate,
    type ReverifiedGateCommand,
} from "../../src/execution/commit-reverification.js"
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
            assert.equal(terminal.data.isError, false)
            assert.match(terminal.data.resultText ?? "", /committing f93f741abcde/)
            const result = env.events[resultIndex]
            assert.ok(StoryResult.is(result))
            assert.deepEqual(
                {
                    success: result.data.success,
                    attempts: result.data.attempts,
                    leaseId: result.data.leaseId,
                    generation: result.data.generation,
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
