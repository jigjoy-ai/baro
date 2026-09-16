import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
import { GitGate } from "../../src/integration/git.js"
import {
    IntegrationWorktree,
    integrationWorktreePath,
} from "../../src/integration/integration-worktree.js"
import { WorktreeManager, WorktreeRefusalError } from "../../src/integration/worktree.js"
import { removeWorktreeRun, uniqueRunId } from "./worktree-fixture.js"

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** A git repo with an initial commit (a.txt) on branch `main`. */
function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "baro-iwt-test-"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "line1\nline2\nline3\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    return repo
}

function commitInWorktree(wt: string, file: string, content: string): void {
    writeFileSync(join(wt, file), content)
    git(wt, "add", "-A")
    git(wt, "commit", "-m", `edit ${file}`)
}

function countHostCheckoutLogs(logs: string[]): number {
    return logs.filter((l) => l.startsWith("[integration] host checkout ")).length
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

function setupRun(): {
    repo: string
    runId: string
    gate: GitGate
    logs: string[]
    goalBranch: string
} {
    const repo = initRepo()
    const runId = uniqueRunId("iwt-test")
    const gate = new GitGate()
    const logs: string[] = []
    cleanups.push({ repo, runId })
    return { repo, runId, gate, logs, goalBranch: "goal" }
}

/** goal branch is one merged story ahead of the host's clean `main` checkout. */
async function goalAheadOfHost() {
    const { repo, runId, gate, logs, goalBranch } = setupRun()
    const iw = new IntegrationWorktree({
        repoRoot: repo,
        gitGate: gate,
        runId,
        goalBranch,
        push: false,
        onLog: (l) => logs.push(l),
    })
    const prepared = await iw.prepare()
    const mgr = new WorktreeManager(repo, gate, runId, {
        integrationRoot: prepared.integrationRoot,
        allowSharedFallback: false,
        linkDepDirs: false,
        onLog: (l) => logs.push(l),
    })
    const path = (await mgr.create("S-base"))!
    commitInWorktree(path, "a.txt", "goal advance\nline2\nline3\n")
    await mgr.mergeBack("S-base")
    await mgr.cleanup("S-base")
    return { repo, runId, gate, logs, goalBranch, iw, prepared, mgr }
}

describe("IntegrationWorktree — prepare + WorktreeManager merge", () => {
    it("stories branch from and merge into the integration worktree without touching the host checkout", async () => {
        const { repo, runId, gate, logs, goalBranch } = setupRun()
        const iw = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: gate,
            runId,
            goalBranch,
            push: false,
            onLog: (l) => logs.push(l),
        })
        const hostBranchBefore = git(repo, "branch", "--show-current")
        const hostHeadBefore = git(repo, "rev-parse", "HEAD")

        const prepared = await iw.prepare()
        assert.equal(prepared.integrationRoot, integrationWorktreePath(runId))
        assert.equal(prepared.reused, false)
        assert.equal(prepared.hostBranchAtStart, hostBranchBefore)
        assert.equal(prepared.hostHeadAtStart, hostHeadBefore)
        assert.equal(prepared.baseSha, hostHeadBefore)
        assert.equal(git(prepared.integrationRoot, "branch", "--show-current"), goalBranch)
        assert.ok(
            git(repo, "worktree", "list").includes(prepared.integrationRoot),
            "integration worktree registered in repoRoot",
        )

        const mgr = new WorktreeManager(repo, gate, runId, {
            integrationRoot: prepared.integrationRoot,
            allowSharedFallback: false,
            linkDepDirs: false,
            onLog: (l) => logs.push(l),
        })
        const path = (await mgr.create("S1"))!
        assert.equal(
            git(path, "rev-parse", "HEAD"),
            prepared.baseSha,
            "story bases off the integration tree HEAD",
        )
        commitInWorktree(path, "f1.txt", "from S1\n")
        const merged = await mgr.mergeBack("S1")
        assert.equal(merged, true)

        assert.equal(git(repo, "branch", "--show-current"), hostBranchBefore, "host branch unchanged")
        assert.equal(git(repo, "rev-parse", "HEAD"), hostHeadBefore, "host HEAD unchanged")
        assert.equal(existsSync(join(repo, "f1.txt")), false, "host checkout does not see the merged file")
        assert.ok(existsSync(join(prepared.integrationRoot, "f1.txt")), "integration tree has the merged file")
        assert.ok(
            git(repo, "log", "--oneline", goalBranch).includes("merge story S1"),
            "goal branch contains the story merge",
        )

        await mgr.cleanup("S1")
    })
})

describe("IntegrationWorktree — pre-created goal branch", () => {
    it("checks out an existing goal ref in __run and fast-forwards the host only at the end", async () => {
        const { repo, runId, gate, logs } = setupRun()
        const goalBranch = "baro/goal-1"
        git(repo, "branch", goalBranch, "HEAD")
        const mainSha = git(repo, "rev-parse", "main")
        const iw = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: gate,
            runId,
            goalBranch,
            push: false,
            onLog: (l) => logs.push(l),
        })

        const prepared = await iw.prepare()

        assert.equal(git(prepared.integrationRoot, "branch", "--show-current"), goalBranch)
        assert.equal(prepared.baseSha, mainSha)
        assert.equal(prepared.hostBranchAtStart, "main")
        assert.equal(git(repo, "branch", "--show-current"), "main")
        assert.equal(git(repo, "rev-parse", "HEAD"), mainSha)

        commitInWorktree(prepared.integrationRoot, "goal.txt", "goal\n")
        const goalSha = git(repo, "rev-parse", `refs/heads/${goalBranch}`)
        assert.equal(git(repo, "rev-parse", "HEAD"), mainSha, "host untouched until sync")

        const result = await iw.syncHostCheckout()

        assert.equal(result.kind, "fast_forwarded")
        assert.equal(git(repo, "rev-parse", "HEAD"), goalSha)
        assert.equal(git(repo, "branch", "--show-current"), "main")
    })
})

class WritingExecutor implements StoryExecutor {
    readonly cwds: string[] = []

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.cwds.push(cwd)
        writeFileSync(join(cwd, `${request.storyId}.txt`), `${request.storyId}\n`)
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

function goalPrd(branchName: string): PrdFile {
    return {
        project: "Integration gate",
        branchName,
        description: "exercise the integration worktree gate",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "S1",
                description: "Implement S1",
                dependsOn: [],
                retries: 1,
                acceptance: ["S1 works"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: "standard",
            },
        ],
    }
}

describe("orchestrate — integration worktree gate", () => {
    const goalBranch = "baro/goal-1"

    function orchestrateRepo(): { repo: string; runId: string; prdPath: string; baseSha: string } {
        const { repo, runId } = setupRun()
        writeFileSync(
            join(repo, "package.json"),
            JSON.stringify({ name: "gate-fixture", private: true, scripts: { test: "node -e \"process.exit(0)\"" } }) + "\n",
        )
        git(repo, "add", "package.json")
        git(repo, "commit", "-m", "manifest")
        git(repo, "branch", goalBranch, "HEAD")
        const prdPath = join(repo, "prd.json")
        writeFileSync(prdPath, JSON.stringify(goalPrd(goalBranch), null, 2) + "\n")
        return { repo, runId, prdPath, baseSha: git(repo, "rev-parse", "HEAD") }
    }

    function run(repo: string, runId: string, prdPath: string, continueRun: boolean, executor = new WritingExecutor()) {
        return orchestrate({
            prdPath,
            cwd: repo,
            runId,
            continueRun,
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

    for (const continueRun of [false, true]) {
        it(`integrates in __run while the host stays on main (continueRun=${continueRun})`, async () => {
            const { repo, runId, prdPath, baseSha } = orchestrateRepo()
            const executor = new WritingExecutor()
            const hostBranches: string[] = []
            const start = executor.start.bind(executor)
            executor.start = (...args) => {
                hostBranches.push(git(repo, "branch", "--show-current"))
                return start(...args)
            }

            const result = await run(repo, runId, prdPath, continueRun, executor)

            assert.equal(result.summary.success, true)
            assert.deepEqual(hostBranches, ["main"])
            assert.equal(git(repo, "branch", "--show-current"), "main")
            assert.equal(JSON.parse(readFileSync(prdPath, "utf8")).branchName, goalBranch)
            assert.ok(git(repo, "ls-tree", "-r", "--name-only", goalBranch).split("\n").includes("S1.txt"))
            assert.ok(
                [baseSha, git(repo, "rev-parse", goalBranch)].includes(git(repo, "rev-parse", "HEAD")),
            )
        })
    }

    it("refuses a plain run while the host checkout is on the goal branch", async () => {
        const { repo, runId, prdPath, baseSha } = orchestrateRepo()
        git(repo, "checkout", goalBranch)
        const executor = new WritingExecutor()

        await assert.rejects(
            () => run(repo, runId, prdPath, false, executor),
            /goal branch baro\/goal-1 is checked out in .*; switch the checkout back to its base branch or run with --continue/,
        )

        assert.deepEqual(executor.cwds, [])
        assert.equal(git(repo, "branch", "--show-current"), goalBranch)
        assert.equal(git(repo, "rev-parse", "HEAD"), baseSha)
    })

    it("integrates in place when --continue runs on the goal branch", async () => {
        const { repo, runId, prdPath } = orchestrateRepo()
        git(repo, "checkout", goalBranch)

        const result = await run(repo, runId, prdPath, true)

        assert.equal(result.summary.success, true)
        assert.equal(git(repo, "branch", "--show-current"), goalBranch)
        assert.ok(git(repo, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes("S1.txt"))
    })
})

describe("IntegrationWorktree — host edit doesn't block merge", () => {
    it("an uncommitted host edit to the same file the story changes does not block mergeBack", async () => {
        const { repo, runId, gate, logs, goalBranch } = setupRun()
        const iw = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: gate,
            runId,
            goalBranch,
            push: false,
            onLog: (l) => logs.push(l),
        })
        const prepared = await iw.prepare()
        const mgr = new WorktreeManager(repo, gate, runId, {
            integrationRoot: prepared.integrationRoot,
            allowSharedFallback: false,
            linkDepDirs: false,
            onLog: (l) => logs.push(l),
        })

        writeFileSync(join(repo, "a.txt"), "host uncommitted edit\nline2\nline3\n")
        assert.notEqual(git(repo, "status", "--porcelain"), "", "host checkout is dirty before merge")

        const path = (await mgr.create("S-host-edit"))!
        commitInWorktree(path, "a.txt", "story edit\nline2\nline3\n")
        const merged = await mgr.mergeBack("S-host-edit")
        assert.equal(merged, true, "mergeBack succeeds despite the dirty host checkout")

        assert.equal(
            readFileSync(join(repo, "a.txt"), "utf8"),
            "host uncommitted edit\nline2\nline3\n",
            "the uncommitted host edit survives untouched",
        )
        assert.notEqual(git(repo, "status", "--porcelain"), "", "host checkout is still dirty")
        assert.equal(
            readFileSync(join(prepared.integrationRoot, "a.txt"), "utf8"),
            "story edit\nline2\nline3\n",
            "the story's change landed on the integration tree",
        )

        await mgr.cleanup("S-host-edit")
    })
})

describe("IntegrationWorktree — syncHostCheckout", () => {
    it("fast-forwards a clean host checkout on the base branch", async () => {
        const { repo, logs, goalBranch, iw } = await goalAheadOfHost()
        const goalSha = git(repo, "rev-parse", `refs/heads/${goalBranch}`)
        const hostHeadBefore = git(repo, "rev-parse", "HEAD")
        const before = countHostCheckoutLogs(logs)

        const result = await iw.syncHostCheckout()

        assert.equal(result.kind, "fast_forwarded")
        if (result.kind !== "fast_forwarded") throw new Error("unreachable")
        assert.equal(result.from, hostHeadBefore)
        assert.equal(result.to, goalSha)
        assert.equal(git(repo, "rev-parse", "HEAD"), goalSha, "host HEAD now equals goal HEAD")
        assert.equal(git(repo, "branch", "--show-current"), "main")
        assert.equal(
            readFileSync(join(repo, "a.txt"), "utf8"),
            "goal advance\nline2\nline3\n",
            "host working tree fast-forwarded too",
        )
        assert.equal(countHostCheckoutLogs(logs) - before, 1, "exactly one host-checkout log line")
    })

    it("leaves a dirty host checkout untouched", async () => {
        const { repo, logs, iw } = await goalAheadOfHost()
        const headBefore = git(repo, "rev-parse", "HEAD")
        writeFileSync(join(repo, "a.txt"), "dirty host edit\n")
        const before = countHostCheckoutLogs(logs)

        const result = await iw.syncHostCheckout()

        assert.equal(result.kind, "untouched")
        if (result.kind !== "untouched") throw new Error("unreachable")
        assert.equal(result.reason, "host_checkout_dirty")
        assert.equal(git(repo, "rev-parse", "HEAD"), headBefore, "host HEAD unchanged")
        assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "dirty host edit\n", "host edit unchanged")
        assert.equal(countHostCheckoutLogs(logs) - before, 1)
    })

    it("leaves a host checkout on another branch untouched", async () => {
        const { repo, logs, iw } = await goalAheadOfHost()
        const headBefore = git(repo, "rev-parse", "HEAD")
        git(repo, "checkout", "-b", "other")
        const before = countHostCheckoutLogs(logs)

        const result = await iw.syncHostCheckout()

        assert.equal(result.kind, "untouched")
        if (result.kind !== "untouched") throw new Error("unreachable")
        assert.equal(result.reason, "not_on_base_branch")
        assert.equal(git(repo, "branch", "--show-current"), "other")
        assert.equal(git(repo, "rev-parse", "HEAD"), headBefore)
        assert.equal(countHostCheckoutLogs(logs) - before, 1)
    })
})

describe("IntegrationWorktree — remove", () => {
    it("removes the integration worktree after a successful run", async () => {
        const { repo, iw, prepared } = await goalAheadOfHost()
        assert.ok(existsSync(prepared.integrationRoot))

        await iw.remove()

        assert.equal(existsSync(prepared.integrationRoot), false)
        assert.ok(
            !git(repo, "worktree", "list", "--porcelain").includes(prepared.integrationRoot),
            "integration worktree no longer registered",
        )
    })

    it("removes the integration worktree after a simulated merge_conflict failure", async () => {
        const { repo, runId, gate, logs, goalBranch } = setupRun()
        const iw = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: gate,
            runId,
            goalBranch,
            push: false,
            onLog: (l) => logs.push(l),
        })
        const prepared = await iw.prepare()
        const mgr = new WorktreeManager(repo, gate, runId, {
            integrationRoot: prepared.integrationRoot,
            allowSharedFallback: false,
            linkDepDirs: false,
            resolveConflictsWithTheirs: false,
            onLog: (l) => logs.push(l),
        })
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!
        commitInWorktree(p1, "a.txt", "S1wins\nline2\nline3\n")
        commitInWorktree(p2, "a.txt", "S2wins\nline2\nline3\n")
        await mgr.mergeBack("S1")

        let caught: unknown = null
        try {
            await mgr.mergeBack("S2")
        } catch (error) {
            caught = error
        }
        assert.ok(caught instanceof WorktreeRefusalError, "mergeBack rejects the conflicting story")
        assert.equal((caught as WorktreeRefusalError).invariant, "merge_conflict")

        await iw.remove()

        assert.equal(existsSync(prepared.integrationRoot), false)
        assert.ok(
            !git(repo, "worktree", "list", "--porcelain").includes(prepared.integrationRoot),
            "integration worktree no longer registered",
        )
    })
})

describe("IntegrationWorktree — prepare reuse", () => {
    it("memoizes prepare() on the same instance", async () => {
        const { repo, runId, gate, logs, goalBranch } = setupRun()
        const iw = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: gate,
            runId,
            goalBranch,
            push: false,
            onLog: (l) => logs.push(l),
        })
        const p1 = iw.prepare()
        const p2 = iw.prepare()
        assert.equal(p1, p2, "prepare() returns the same in-flight/settled promise")
        await p1
    })

    it("a new instance with the same runId reuses the registered worktree", async () => {
        const { repo, runId, gate, logs, goalBranch } = setupRun()
        const iw1 = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: gate,
            runId,
            goalBranch,
            push: false,
            onLog: (l) => logs.push(l),
        })
        const prepared1 = await iw1.prepare()
        const goalShaBefore = git(repo, "rev-parse", `refs/heads/${goalBranch}`)

        const iw2 = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: gate,
            runId,
            goalBranch,
            push: false,
            onLog: (l) => logs.push(l),
        })
        const prepared2 = await iw2.prepare()

        assert.equal(prepared2.reused, true)
        assert.equal(prepared2.integrationRoot, prepared1.integrationRoot)
        assert.equal(prepared2.integrationRoot, integrationWorktreePath(runId))
        assert.equal(
            git(repo, "rev-parse", `refs/heads/${goalBranch}`),
            goalShaBefore,
            "the goal branch was not reset",
        )
    })
})
