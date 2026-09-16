import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgenticEnvironment } from "../../src/runtime/mozaik.js"
import type {
    StoryExecOpts,
    StoryExecution,
    StoryExecutor,
} from "../../src/execution/story-executor.js"
import type { StoryRoute } from "../../src/market/routing.js"
import { orchestrate } from "../../src/orchestrate.js"
import type { PrdFile } from "../../src/prd.js"
import { StoryResult, type StorySpawnRequestData } from "../../src/semantic-events.js"
import { removeWorktreeRun, uniqueRunId } from "./worktree-fixture.js"

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

const GOAL_BRANCH = "baro/regression-1"

function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "baro-host-untouched-test-"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "line1\n")
    writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "regression-fixture", private: true, scripts: { test: "node -e \"process.exit(0)\"" } }) + "\n",
    )
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    return repo
}

/** Each story's stub agent writes and commits exactly one file in its own worktree. */
class TwoFileWritingExecutor implements StoryExecutor {
    readonly hostBranchesDuringRun: string[] = []

    constructor(private readonly repo: string) {}

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.hostBranchesDuringRun.push(git(this.repo, "branch", "--show-current"))
        writeFileSync(join(cwd, `${request.storyId}.txt`), `${request.storyId}\n`)
        git(cwd, "add", "-A")
        git(cwd, "commit", "-m", `${request.storyId} work`)
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)
        setImmediate(() => {
            environment.deliverSemanticEvent(
                resultSource,
                StoryResult.create({
                    storyId: request.storyId,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

function regressionPrd(): PrdFile {
    return {
        project: "Host checkout untouched regression",
        branchName: GOAL_BRANCH,
        description: "Regression coverage for issue #153",
        userStories: [story("S1"), story("S2")],
    }
}

function story(id: string): PrdFile["userStories"][number] {
    return {
        id,
        priority: Number(id.slice(1)),
        title: id,
        description: `Implement ${id}`,
        dependsOn: [],
        retries: 1,
        acceptance: [`${id} works`],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
    }
}

let cleanups: Array<{ repo: string; runId: string }> = []

afterEach(async () => {
    for (const { repo, runId } of cleanups) {
        await removeWorktreeRun(repo, runId)
        try {
            rmSync(repo, { recursive: true, force: true })
        } catch { /* best-effort */ }
    }
    cleanups = []
})

function setupRegressionRepo(): { repo: string; runId: string; prdPath: string; baseSha: string } {
    const repo = initRepo()
    const runId = uniqueRunId("host-untouched")
    cleanups.push({ repo, runId })
    git(repo, "branch", GOAL_BRANCH, "HEAD")
    const prdPath = join(repo, "prd.json")
    writeFileSync(prdPath, JSON.stringify(regressionPrd(), null, 2) + "\n")
    return { repo, runId, prdPath, baseSha: git(repo, "rev-parse", "HEAD") }
}

function runOrchestrate(repo: string, runId: string, prdPath: string, executor: StoryExecutor) {
    return orchestrate({
        prdPath,
        cwd: repo,
        runId,
        continueRun: false,
        coordinationMode: "legacy",
        publishRemote: false,
        withGit: true,
        withWorktrees: true,
        emitTuiEvents: false,
        withLibrarian: false,
        withMemory: false,
        withSentry: false,
        withCritic: false,
        withSurgeon: false,
        withSupervisor: false,
        intraLevelDelaySecs: 0,
        executor,
    })
}

function assertGoalBranchHasBothStoryFiles(repo: string): void {
    const files = git(repo, "ls-tree", "-r", "--name-only", GOAL_BRANCH).split("\n")
    assert.ok(files.includes("S1.txt"), "goal branch is missing S1.txt")
    assert.ok(files.includes("S2.txt"), "goal branch is missing S2.txt")
}

describe("regression: real orchestrate() run leaves the host checkout untouched", () => {
    it("keeps a clean host on its base branch, fast-forwarding it only at the end", async () => {
        const { repo, runId, prdPath, baseSha } = setupRegressionRepo()
        const executor = new TwoFileWritingExecutor(repo)

        const result = await runOrchestrate(repo, runId, prdPath, executor)

        assert.equal(result.summary.success, true)
        assert.deepEqual(executor.hostBranchesDuringRun, ["main", "main"])
        assert.equal(git(repo, "branch", "--show-current"), "main")
        assertGoalBranchHasBothStoryFiles(repo)
        const goalSha = git(repo, "rev-parse", GOAL_BRANCH)
        assert.ok(
            [baseSha, goalSha].includes(git(repo, "rev-parse", "HEAD")),
            "host HEAD should be the base commit or fast-forwarded to the goal branch",
        )
    })

    it("leaves a dirty host exactly on the base commit", async () => {
        const { repo, runId, prdPath, baseSha } = setupRegressionRepo()
        writeFileSync(join(repo, "a.txt"), "dirty host edit\n")
        assert.notEqual(git(repo, "status", "--porcelain"), "", "host checkout is dirty before the run")
        const executor = new TwoFileWritingExecutor(repo)

        const result = await runOrchestrate(repo, runId, prdPath, executor)

        assert.equal(result.summary.success, true)
        assert.deepEqual(executor.hostBranchesDuringRun, ["main", "main"])
        assert.equal(git(repo, "branch", "--show-current"), "main")
        assert.equal(git(repo, "rev-parse", "HEAD"), baseSha, "dirty host must never be fast-forwarded")
        assertGoalBranchHasBothStoryFiles(repo)
    })
})
