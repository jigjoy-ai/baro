import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitGate } from "../../src/integration/git.js"
import { IntegrationWorktree } from "../../src/integration/integration-worktree.js"
import { WorktreeManager } from "../../src/integration/worktree.js"
import { removeWorktreeRun, uniqueRunId } from "./worktree-fixture.js"

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "baro-wt-restore-agent-"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "base\n")
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    return repo
}

function commitIn(cwd: string, file: string, content: string): void {
    writeFileSync(join(cwd, file), content)
    git(cwd, "add", "-A")
    git(cwd, "commit", "-m", `edit ${file}`)
}

let repo: string
let mgr: WorktreeManager
let runId: string
let integrationRoot: string

beforeEach(async () => {
    repo = initRepo()
    const gate = new GitGate()
    runId = uniqueRunId("run-restore-agent")
    ;({ integrationRoot } = await new IntegrationWorktree({
        repoRoot: repo,
        gitGate: gate,
        runId,
        goalBranch: "baro/goal",
        push: false,
        onLog: () => {},
    }).prepare())
    mgr = new WorktreeManager(repo, gate, runId, {
        onLog: () => {},
        resolveConflictsWithTheirs: false,
        integrationRoot,
    })
})

afterEach(async () => {
    try { await mgr.cleanupAll() } catch { /* */ }
    await removeWorktreeRun(repo, runId)
    try { rmSync(repo, { recursive: true, force: true }) } catch { /* */ }
})

describe("WorktreeManager.restoreAgentCommits", () => {
    it("replays the agent's commits onto the moved run branch without the host's leftover commit", async () => {
        const path = (await mgr.create("S3"))!
        commitIn(path, "fix.txt", "green fix\n")
        writeFileSync(join(path, "half-written.txt"), "mid-build leftover\n")
        const preserved = (await mgr.cleanupFailed("S3", true))!
        assert.match(
            git(repo, "log", "-1", "--format=%s", preserved),
            /preserve failed work for story S3/,
            "fixture: the preserved tip is the host's leftover commit",
        )
        commitIn(integrationRoot, "sibling.txt", "merged meanwhile\n")
        const moved = git(integrationRoot, "rev-parse", "HEAD")

        const restored = await mgr.restoreAgentCommits("S3", preserved)

        assert.ok(restored)
        assert.equal(restored.path, mgr.activePath("S3"))
        assert.equal(mgr.creationSha("S3"), moved)
        assert.equal(git(restored.path, "rev-parse", "HEAD"), restored.head)
        assert.notEqual(restored.head, moved)
        assert.equal(readFileSync(join(restored.path, "fix.txt"), "utf8"), "green fix\n")
        assert.equal(readFileSync(join(restored.path, "sibling.txt"), "utf8"), "merged meanwhile\n")
        assert.equal(existsSync(join(restored.path, "half-written.txt")), false)
    })

    it("restores every commit when the attempt left nothing uncommitted", async () => {
        const path = (await mgr.create("S3"))!
        commitIn(path, "one.txt", "1\n")
        commitIn(path, "two.txt", "2\n")
        const preserved = (await mgr.cleanupFailed("S3", true))!

        const restored = await mgr.restoreAgentCommits("S3", preserved)

        assert.ok(restored)
        assert.equal(git(restored.path, "rev-list", "--count", `${mgr.creationSha("S3")}..HEAD`), "2")
    })

    it("returns null when the agent committed nothing of its own", async () => {
        const path = (await mgr.create("S3"))!
        writeFileSync(join(path, "draft.txt"), "never committed\n")
        const preserved = (await mgr.cleanupFailed("S3", true))!

        assert.equal(await mgr.restoreAgentCommits("S3", preserved), null)
    })
})
