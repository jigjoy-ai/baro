import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitGate } from "../src/git.js"
import { WorktreeManager } from "../src/worktree.js"

// ── helpers ──────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** A git repo with an initial commit (a.txt, .gitignore) on branch `main`. */
function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "baro-wt-test-"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "line1\nline2\nline3\n")
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    return repo
}

/** Commit a file into an already-created worktree, as a story agent would. */
function commitInWorktree(wt: string, file: string, content: string): void {
    writeFileSync(join(wt, file), content)
    git(wt, "add", "-A")
    git(wt, "commit", "-m", `edit ${file}`)
}

let repo: string
let gate: GitGate
let logs: string[]
let mgr: WorktreeManager
let runId: string
let seq = 0

beforeEach(() => {
    repo = initRepo()
    gate = new GitGate()
    logs = []
    // Unique per test: the worktree base dir lives in the OS tmpdir keyed by
    // runId, so a shared id would collide across tests (in production the id
    // is `run-<time>-<pid>`, unique per process).
    runId = `run-test-${seq++}`
    mgr = new WorktreeManager(repo, gate, runId, {
        onLog: (l) => logs.push(l),
    })
})

afterEach(async () => {
    try { await mgr.cleanupAll() } catch { /* */ }
    try { rmSync(repo, { recursive: true, force: true }) } catch { /* */ }
})

// ── tests ────────────────────────────────────────────────────────────

describe("WorktreeManager — lifecycle", () => {
    it("create → worktree + branch off HEAD; mergeBack lands the commit; cleanup removes everything", async () => {
        const head = git(repo, "rev-parse", "HEAD")
        const path = await mgr.create("S1")
        assert.ok(path, "create returned a path")
        assert.ok(existsSync(path!), "worktree dir exists")
        assert.equal(git(path!, "rev-parse", "HEAD"), head, "worktree HEAD == repo HEAD")
        assert.ok(
            git(repo, "worktree", "list").includes(path!),
            "git worktree list shows the new worktree",
        )

        commitInWorktree(path!, "f1.txt", "from S1\n")
        await mgr.mergeBack("S1")

        assert.ok(existsSync(join(repo, "f1.txt")), "merged file present on run branch")
        assert.ok(
            git(repo, "log", "--oneline", "-1").includes("merge story S1"),
            "merge commit names the story",
        )

        await mgr.cleanup("S1")
        assert.ok(!existsSync(path!), "worktree dir removed")
        assert.ok(!git(repo, "worktree", "list").includes(path!), "worktree pruned")
        const branches = git(repo, "branch", "--list", `baro-wt/${runId}/S1`)
        assert.equal(branches, "", "branch deleted")
    })
})

describe("WorktreeManager — isolation (#50)", () => {
    it("parallel stories don't see each other's files until merge-back", async () => {
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!

        commitInWorktree(p1, "f1.txt", "S1\n")
        commitInWorktree(p2, "f2.txt", "S2\n")

        assert.ok(!existsSync(join(p1, "f2.txt")), "S1's tree does not see S2's file")
        assert.ok(!existsSync(join(p2, "f1.txt")), "S2's tree does not see S1's file")

        await mgr.mergeBack("S1")
        await mgr.mergeBack("S2")

        assert.ok(existsSync(join(repo, "f1.txt")), "run branch has S1's file")
        assert.ok(existsSync(join(repo, "f2.txt")), "run branch has S2's file")
    })

    it("same file, non-overlapping lines, merges cleanly", async () => {
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!
        commitInWorktree(p1, "a.txt", "S1edit\nline2\nline3\n")
        commitInWorktree(p2, "a.txt", "line1\nline2\nS2edit\n")

        await mgr.mergeBack("S1")
        await mgr.mergeBack("S2")

        const merged = readFileSync(join(repo, "a.txt"), "utf8")
        assert.ok(merged.includes("S1edit"), "S1's line survived")
        assert.ok(merged.includes("S2edit"), "S2's line survived")
    })
})

describe("WorktreeManager — conflict", () => {
    it("same-line conflict auto-resolves with -X theirs (merging story wins) and warns", async () => {
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!
        commitInWorktree(p1, "a.txt", "S1wins\nline2\nline3\n")
        commitInWorktree(p2, "a.txt", "S2wins\nline2\nline3\n")
        await mgr.mergeBack("S1")
        await mgr.mergeBack("S2")

        const merged = readFileSync(join(repo, "a.txt"), "utf8")
        assert.ok(merged.includes("S2wins"), "the merging story (S2) won")
        assert.ok(!merged.includes("<<<<<<<"), "no conflict markers left")
        assert.equal(git(repo, "status", "--porcelain"), "", "run branch clean")
        assert.ok(
            logs.some((l) => l.includes("conflict") && l.includes("S2")),
            "a conflict warning was surfaced",
        )
    })

    it("collective policy preserves the branch and fails instead of choosing a winner", async () => {
        mgr = new WorktreeManager(repo, gate, runId, {
            onLog: (line) => logs.push(line),
            resolveConflictsWithTheirs: false,
        })
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!
        commitInWorktree(p1, "a.txt", "S1wins\nline2\nline3\n")
        commitInWorktree(p2, "a.txt", "S2wins\nline2\nline3\n")
        await mgr.mergeBack("S1")
        await assert.rejects(() => mgr.mergeBack("S2"), /conflicts with already-merged work/)

        assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "S1wins\nline2\nline3\n")
        assert.equal(git(repo, "status", "--porcelain"), "")
        assert.notEqual(
            git(repo, "branch", "--list", `baro-wt/${runId}/S2`),
            "",
            "the conflicting story branch remains inspectable",
        )
    })

    it("backs up a conflict and retries the same logical story from latest HEAD", async () => {
        mgr = new WorktreeManager(repo, gate, runId, {
            onLog: (line) => logs.push(line),
            resolveConflictsWithTheirs: false,
        })
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!
        commitInWorktree(p1, "a.txt", "S1wins\nline2\nline3\n")
        commitInWorktree(p2, "a.txt", "S2wins\nline2\nline3\n")
        const rejectedAttemptSha = git(p2, "rev-parse", "HEAD")

        await mgr.mergeBack("S1")
        await assert.rejects(() => mgr.mergeBack("S2"), /conflicts with already-merged work/)
        const backup = await mgr.prepareConflictRetry("S2")

        assert.match(backup, new RegExp(`^baro-recovery/${runId}/S2/`))
        assert.equal(git(repo, "rev-parse", backup), rejectedAttemptSha)
        assert.equal(
            git(repo, "show", `${backup}:a.txt`),
            "S2wins\nline2\nline3",
            "the rejected attempt remains available under an immutable ref",
        )
        assert.equal(
            git(repo, "branch", "--list", `baro-wt/${runId}/S2`),
            "",
            "the reusable logical story branch was released",
        )

        const retry = (await mgr.create("S2"))!
        assert.equal(
            readFileSync(join(retry, "a.txt"), "utf8"),
            "S1wins\nline2\nline3\n",
            "recovery starts from the latest integrated run branch",
        )
        commitInWorktree(retry, "a.txt", "S1wins\nS2wins\nline2\nline3\n")
        await mgr.mergeBack("S2")
        await mgr.cleanup("S2")

        assert.equal(
            readFileSync(join(repo, "a.txt"), "utf8"),
            "S1wins\nS2wins\nline2\nline3\n",
        )
        assert.notEqual(
            git(repo, "branch", "--list", backup),
            "",
            "the exact rejected attempt remains auditable after recovery succeeds",
        )
        await mgr.cleanupAll()
        assert.notEqual(git(repo, "branch", "--list", backup), "")
    })

    it("refuses retry preparation when the preserved worktree is dirty", async () => {
        mgr = new WorktreeManager(repo, gate, runId, {
            onLog: (line) => logs.push(line),
            resolveConflictsWithTheirs: false,
        })
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!
        commitInWorktree(p1, "a.txt", "S1wins\nline2\nline3\n")
        commitInWorktree(p2, "a.txt", "S2wins\nline2\nline3\n")
        await mgr.mergeBack("S1")
        await assert.rejects(() => mgr.mergeBack("S2"), /conflicts with already-merged work/)
        writeFileSync(join(p2, "uncommitted.txt"), "must survive\n")

        await assert.rejects(
            () => mgr.prepareConflictRetry("S2"),
            /dirty; refusing to discard uncommitted work/,
        )
        assert.ok(existsSync(join(p2, "uncommitted.txt")))
        assert.notEqual(git(repo, "branch", "--list", `baro-wt/${runId}/S2`), "")
        await mgr.cleanupAll()
        assert.ok(
            existsSync(join(p2, "uncommitted.txt")),
            "shutdown preserves uncommitted recovery work for manual repair",
        )
        rmSync(p2, { recursive: true, force: true })
    })
})

describe("WorktreeManager — failed execution recovery", () => {
    it("snapshots dirty work under an immutable ref and starts recovery from fresh HEAD", async () => {
        const runHead = git(repo, "rev-parse", "HEAD")
        const failedPath = (await mgr.create("S1"))!
        writeFileSync(join(failedPath, "partial.txt"), "valuable partial work\n")

        const backup = await mgr.cleanupFailed("S1", true)

        assert.ok(backup)
        assert.match(backup!, new RegExp(`^baro-recovery/${runId}/S1/`))
        assert.equal(
            git(repo, "show", `${backup}:partial.txt`),
            "valuable partial work",
        )
        assert.equal(git(repo, "rev-parse", "HEAD"), runHead, "failed work was not merged")
        assert.equal(existsSync(failedPath), false, "failed logical worktree was released")
        assert.equal(
            git(repo, "branch", "--list", `baro-wt/${runId}/S1`),
            "",
            "reusable logical branch was released",
        )

        const recoveryPath = (await mgr.create("S1"))!
        assert.equal(
            existsSync(join(recoveryPath, "partial.txt")),
            false,
            "recovery starts from the integrated run branch, not the rejected attempt",
        )
        writeFileSync(join(recoveryPath, "second-attempt.txt"), "another partial\n")
        const secondBackup = await mgr.cleanupFailed("S1", true)
        assert.ok(secondBackup)
        assert.notEqual(secondBackup, backup, "every failed attempt gets a unique ref")
        assert.equal(
            git(repo, "show", `${secondBackup}:second-attempt.txt`),
            "another partial",
        )
        assert.notEqual(
            git(repo, "branch", "--list", backup!),
            "",
            "cleanup never deletes immutable recovery refs",
        )
    })

    it("preserves a clean failed branch when the agent already committed partial work", async () => {
        const runHead = git(repo, "rev-parse", "HEAD")
        const failedPath = (await mgr.create("S1"))!
        commitInWorktree(failedPath, "committed-partial.txt", "already committed\n")
        const failedHead = git(failedPath, "rev-parse", "HEAD")
        assert.equal(git(failedPath, "status", "--porcelain"), "")

        const backup = await mgr.cleanupFailed("S1", true)

        assert.ok(backup)
        assert.equal(git(repo, "rev-parse", backup!), failedHead)
        assert.equal(
            git(repo, "show", `${backup}:committed-partial.txt`),
            "already committed",
        )
        assert.equal(git(repo, "rev-parse", "HEAD"), runHead, "partial commit was not merged")
        assert.equal(existsSync(failedPath), false)
        assert.equal(git(repo, "branch", "--list", `baro-wt/${runId}/S1`), "")
    })

    it("preserves an advanced branch when its tracked worktree path disappeared", async () => {
        const runHead = git(repo, "rev-parse", "HEAD")
        const failedPath = (await mgr.create("S1"))!
        commitInWorktree(failedPath, "stranded-partial.txt", "stranded commit\n")
        const failedHead = git(failedPath, "rev-parse", "HEAD")
        rmSync(failedPath, { recursive: true, force: true })

        const backup = await mgr.cleanupFailed("S1", true)

        assert.ok(backup)
        assert.equal(git(repo, "rev-parse", backup!), failedHead)
        assert.equal(
            git(repo, "show", `${backup}:stranded-partial.txt`),
            "stranded commit",
        )
        assert.equal(git(repo, "rev-parse", "HEAD"), runHead)
        assert.equal(git(repo, "branch", "--list", `baro-wt/${runId}/S1`), "")
    })

    it("retains the dirty worktree when the preservation commit fails", async () => {
        const failedPath = (await mgr.create("S1"))!
        writeFileSync(join(failedPath, "partial.txt"), "must not disappear\n")
        const hook = join(repo, ".git", "hooks", "pre-commit")
        writeFileSync(hook, "#!/bin/sh\nexit 1\n")
        chmodSync(hook, 0o755)

        await assert.rejects(
            () => mgr.cleanupFailed("S1", true),
            /could not preserve failed story S1; retained worktree/,
        )

        assert.equal(readFileSync(join(failedPath, "partial.txt"), "utf8"), "must not disappear\n")
        assert.notEqual(
            git(repo, "branch", "--list", `baro-wt/${runId}/S1`),
            "",
            "logical branch remains while preservation is unresolved",
        )

        rmSync(hook, { force: true })
        await mgr.cleanup("S1")
    })
})

describe("WorktreeManager — uncommitted safety net", () => {
    it("never commits the symlinked dep dirs, even if the repo doesn't gitignore them", async () => {
        // Repo with NO node_modules ignore + a real root node_modules to link.
        writeFileSync(join(repo, ".gitignore"), "")
        git(repo, "commit", "-am", "drop gitignore")
        mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true })
        writeFileSync(join(repo, "node_modules", "pkg", "i.js"), "1\n")

        const p1 = (await mgr.create("S1"))!
        writeFileSync(join(p1, "real.txt"), "real work\n") // uncommitted → triggers safety net
        await mgr.mergeBack("S1")

        const tracked = git(repo, "ls-files").split("\n")
        assert.ok(tracked.includes("real.txt"), "real work committed")
        assert.ok(
            !tracked.some((f) => f.startsWith("node_modules")),
            "symlinked node_modules never committed",
        )
    })

    it("auto-commits tracked work the agent forgot, but never ignored files", async () => {
        const p1 = (await mgr.create("S1"))!
        // Agent edited files but never committed:
        writeFileSync(join(p1, "f.txt"), "forgot to commit\n")
        mkdirSync(join(p1, "node_modules"), { recursive: true })
        writeFileSync(join(p1, "node_modules", "x"), "junk\n")

        await mgr.mergeBack("S1")

        assert.ok(existsSync(join(repo, "f.txt")), "forgotten work was preserved")
        assert.ok(
            !git(repo, "ls-files").split("\n").some((f) => f.startsWith("node_modules")),
            "ignored node_modules not committed",
        )
        assert.ok(
            logs.some((l) => l.includes("uncommitted")),
            "a safety-net warning was surfaced",
        )
    })
})

describe("WorktreeManager — fallback", () => {
    it("mergeBack returns false for a story that never got a worktree", async () => {
        const merged = await mgr.mergeBack("never-created")
        assert.equal(merged, false, "no worktree → no merge, signals shared-tree path")
    })
})

describe("WorktreeManager — cleanup", () => {
    it("cleanupAll removes every worktree + branch", async () => {
        await mgr.create("S1")
        await mgr.create("S2")
        await mgr.create("S3")
        await mgr.cleanupAll()

        const list = git(repo, "worktree", "list")
        assert.ok(!list.includes("[baro-wt/"), "no baro worktrees remain")
        assert.equal(
            git(repo, "branch", "--list", `baro-wt/${runId}/*`),
            "",
            "no baro-wt branches remain",
        )
    })

    it("cleanupStaleOnStart removes leftover baro-wt branches under the run id", async () => {
        // Simulate a crashed prior run: a dangling branch with our run id.
        git(repo, "branch", `baro-wt/${runId}/old`)
        await mgr.cleanupStaleOnStart()
        assert.equal(
            git(repo, "branch", "--list", `baro-wt/${runId}/old`),
            "",
            "stale branch pruned",
        )
        // And create still succeeds afterwards.
        const p = await mgr.create("old")
        assert.ok(p && existsSync(p), "create works after stale cleanup")
    })
})

describe("WorktreeManager — dependency dir symlink", () => {
    it("keeps an agent's explicit git add from committing the dependency symlink", async () => {
        writeFileSync(join(repo, "package.json"), '{"scripts":{}}\n')
        git(repo, "add", "package.json")
        git(repo, "commit", "-m", "add package manifest")

        const p1 = (await mgr.create("S1"))!
        assert.ok(existsSync(join(p1, "node_modules")))
        writeFileSync(join(p1, "feature.txt"), "real work\n")
        git(p1, "add", "-A")
        git(p1, "commit", "-m", "agent commit")
        await mgr.mergeBack("S1")

        const tracked = git(repo, "ls-files").split("\n")
        assert.ok(tracked.includes("feature.txt"))
        assert.ok(!tracked.includes("node_modules"))
        assert.equal(existsSync(join(repo, "node_modules")), true)
    })

    it("symlinks root node_modules into the worktree so deps resolve", async () => {
        mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true })
        writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports=1\n")

        const p = (await mgr.create("S1"))!
        assert.ok(
            existsSync(join(p, "node_modules", "pkg", "index.js")),
            "worktree sees root node_modules via symlink",
        )
    })

    it("shares deps installed by one story with the others (fresh clone, no node_modules yet)", async () => {
        // The hosted-run bug: a fresh clone has package.json but NO node_modules, so the
        // setup story installs deps that the dependent stories then can't see.
        writeFileSync(join(repo, "package.json"), '{"name":"x"}\n')
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "add package.json")

        const p1 = (await mgr.create("S1"))!
        // S1 "installs" — writes into its node_modules (a symlink to the shared dir).
        mkdirSync(join(p1, "node_modules", "vitest"), { recursive: true })
        writeFileSync(join(p1, "node_modules", "vitest", "bin.js"), "1\n")

        const p2 = (await mgr.create("S2"))!
        assert.ok(
            existsSync(join(p2, "node_modules", "vitest", "bin.js")),
            "S2 sees deps S1 installed, via the shared node_modules",
        )
    })

    it("shares a monorepo subpackage's node_modules (e.g. frontend/)", async () => {
        mkdirSync(join(repo, "frontend"), { recursive: true })
        writeFileSync(join(repo, "frontend", "package.json"), '{"name":"f"}\n')
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "add frontend pkg")

        const p1 = (await mgr.create("S1"))!
        mkdirSync(join(p1, "frontend", "node_modules", "vitest"), { recursive: true })
        writeFileSync(join(p1, "frontend", "node_modules", "vitest", "bin.js"), "1\n")

        const p2 = (await mgr.create("S2"))!
        assert.ok(
            existsSync(join(p2, "frontend", "node_modules", "vitest", "bin.js")),
            "S2 sees frontend deps S1 installed",
        )
    })

    it("skips the symlink when disabled", async () => {
        mkdirSync(join(repo, "node_modules"), { recursive: true })
        const noLink = new WorktreeManager(repo, new GitGate(), "run-nolink", {
            linkDepDirs: false,
            onLog: () => {},
        })
        const p = (await noLink.create("S1"))!
        assert.ok(!existsSync(join(p, "node_modules")), "no symlink when disabled")
        await noLink.cleanupAll()
    })
})
