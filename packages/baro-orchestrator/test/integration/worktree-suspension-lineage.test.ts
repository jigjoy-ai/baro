import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitGate } from "../../src/integration/git.js"
import { captureCriticRepositoryFingerprint } from "../../src/acceptance/critic-evidence.js"
import {
    WorktreeManager,
    WorktreeRefusalError,
} from "../../src/integration/worktree.js"

// ── helpers ──────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** A git repo with an initial commit (a.txt, .gitignore) on branch `main`. */
function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "baro-wt-resume-test-"))
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

/** Integrate unrelated work directly on the run branch — the base move a
 * dependency's merge performs while a story is suspended. */
function integrateOnRunBranch(repo: string, file: string, content: string): string {
    writeFileSync(join(repo, file), content)
    git(repo, "add", "-A")
    git(repo, "commit", "-m", `dependency work ${file}`)
    return git(repo, "rev-parse", "HEAD")
}

const RECOVERY_REF = /^baro-recovery\/[^/]+\/[^/]+\/\d+$/

async function sealFor(path: string, baseSha: string | null) {
    return {
        expectedFingerprint: await captureCriticRepositoryFingerprint({
            cwd: path,
            baseSha,
        }),
        capture: captureCriticRepositoryFingerprint,
    }
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
    runId = `run-resume-test-${seq++}`
    mgr = new WorktreeManager(repo, gate, runId, {
        onLog: (l) => logs.push(l),
        resolveConflictsWithTheirs: false,
    })
})

afterEach(async () => {
    try { await mgr.cleanupAll() } catch { /* */ }
    try { rmSync(repo, { recursive: true, force: true }) } catch { /* */ }
})

// ── tests ────────────────────────────────────────────────────────────

describe("WorktreeManager — host-owned suspension resume", () => {
    it("recreates the worktree on the moved run branch and records that base", async () => {
        await mgr.create("S1")
        const moved = integrateOnRunBranch(repo, "dep.txt", "integrated\n")

        const update = await mgr.resumeFromSuspension("S1")

        assert.equal(update.mode, "recreated")
        assert.equal(update.baseSha, moved)
        assert.equal(mgr.creationSha("S1"), moved)

        const path = mgr.activePath("S1")!
        commitInWorktree(path, "story.txt", "honest post-resume work\n")
        const seal = await sealFor(path, mgr.creationSha("S1"))

        assert.equal(await mgr.mergeBack("S1", seal), true)
        assert.equal(
            readFileSync(join(repo, "story.txt"), "utf8"),
            "honest post-resume work\n",
        )
    })

    it("replays work preserved at the suspension boundary onto the new base and merges", async () => {
        const path = (await mgr.create("S1"))!
        commitInWorktree(path, "story.txt", "work before suspension\n")
        // The suspension boundary: the host preserves the attempt and frees
        // the logical story (WorkspaceCleanupRequested{preserveForRecovery}).
        const preserved = await mgr.cleanupFailed("S1", true)
        assert.ok(preserved)
        assert.match(preserved!, RECOVERY_REF)
        const preservedSha = git(repo, "rev-parse", preserved!)

        const moved = integrateOnRunBranch(repo, "dep.txt", "integrated\n")

        const update = await mgr.resumeFromSuspension("S1", {
            restoreFrom: preserved!,
        })

        assert.equal(update.mode, "rebased")
        assert.equal(update.baseSha, moved)
        assert.equal(update.restoredFrom, preserved)
        assert.equal(mgr.creationSha("S1"), moved)
        assert.equal(
            git(repo, "rev-parse", preserved!),
            preservedSha,
            "the host replay must not move the immutable recovery ref",
        )

        const resumed = mgr.activePath("S1")!
        assert.equal(
            readFileSync(join(resumed, "story.txt"), "utf8"),
            "work before suspension\n",
            "pre-suspension work was replayed by the host",
        )
        assert.equal(
            readFileSync(join(resumed, "dep.txt"), "utf8"),
            "integrated\n",
            "the replay sits on top of the integrated dependency work",
        )
        assert.equal(
            git(repo, "merge-base", "--is-ancestor", moved, git(resumed, "rev-parse", "HEAD")),
            "",
            "candidate descends from the recorded creation SHA",
        )

        commitInWorktree(resumed, "story.txt", "work before suspension\nand after\n")
        const seal = await sealFor(resumed, mgr.creationSha("S1"))

        assert.equal(await mgr.mergeBack("S1", seal), true)
        assert.equal(
            readFileSync(join(repo, "story.txt"), "utf8"),
            "work before suspension\nand after\n",
        )
        assert.equal(readFileSync(join(repo, "dep.txt"), "utf8"), "integrated\n")
    })

    it("still refuses a candidate whose history a non-host actor rewrote", async () => {
        const path = (await mgr.create("S1"))!
        commitInWorktree(path, "story.txt", "work before suspension\n")
        const preserved = (await mgr.cleanupFailed("S1", true))!
        integrateOnRunBranch(repo, "dep.txt", "integrated\n")

        await mgr.resumeFromSuspension("S1")
        const resumed = mgr.activePath("S1")!
        const seal = await sealFor(resumed, mgr.creationSha("S1"))

        // Not the host: the agent grafts its pre-suspension history back in
        // rather than building on the base the host recorded for it.
        git(resumed, "reset", "--hard", preserved)

        await assert.rejects(
            () => mgr.mergeBack("S1", seal),
            (error: unknown) => {
                assert.ok(error instanceof WorktreeRefusalError)
                assert.equal(error.invariant, "sealed_merge_lineage")
                assert.equal(
                    error.message,
                    "reviewed candidate history no longer descends from its creation SHA for story S1",
                )
                return true
            },
        )
        assert.equal(existsSync(join(repo, "story.txt")), false)
    })

    it("leaves recovery material for prepareConflictRetry when integration fails post-suspension", async () => {
        const path = (await mgr.create("S1"))!
        commitInWorktree(path, "story.txt", "work before suspension\n")
        const preserved = (await mgr.cleanupFailed("S1", true))!
        integrateOnRunBranch(repo, "dep.txt", "integrated\n")

        await mgr.resumeFromSuspension("S1", { restoreFrom: preserved })
        const resumed = mgr.activePath("S1")!
        const seal = await sealFor(resumed, mgr.creationSha("S1"))
        git(resumed, "reset", "--hard", preserved)

        await assert.rejects(() => mgr.mergeBack("S1", seal))

        const recovered = await mgr.prepareConflictRetry("S1")
        assert.match(recovered, RECOVERY_REF)
        assert.equal(git(repo, "rev-parse", "--verify", recovered), git(repo, "rev-parse", preserved))
        assert.equal(mgr.recoveryRef("S1"), recovered)
        assert.equal(
            git(repo, "show", `${recovered}:story.txt`),
            "work before suspension",
            "the preserved attempt is still readable from the recovery ref",
        )
    })

    it("aborts a conflicting replay, keeps recovery material and never records the old base", async () => {
        const path = (await mgr.create("S1"))!
        const preSuspensionBase = mgr.creationSha("S1")
        commitInWorktree(path, "a.txt", "story rewrite\nline2\nline3\n")
        const preserved = (await mgr.cleanupFailed("S1", true))!
        const preservedSha = git(repo, "rev-parse", preserved)
        // The dependency touched the same line, so the replay cannot apply.
        const moved = integrateOnRunBranch(repo, "a.txt", "dependency rewrite\nline2\nline3\n")

        await assert.rejects(
            () => mgr.resumeFromSuspension("S1", { restoreFrom: preserved }),
            /could not replay preserved work for story S1/,
        )

        assert.notEqual(mgr.creationSha("S1"), preSuspensionBase)
        assert.equal(mgr.creationSha("S1"), null, "no base is recorded for a failed resume")
        assert.equal(mgr.activePath("S1"), null)
        assert.equal(mgr.recoveryRef("S1"), preserved)
        assert.equal(git(repo, "rev-parse", "--verify", preserved), preservedSha)
        assert.equal(git(repo, "rev-parse", "HEAD"), moved, "the run branch is untouched")

        const recovered = await mgr.prepareConflictRetry("S1")
        assert.equal(recovered, preserved)
    })

    it("refuses a restore point that does not resolve", async () => {
        await mgr.create("S1")
        await assert.rejects(
            () => mgr.resumeFromSuspension("S1", { restoreFrom: "baro-recovery/absent/S1/1" }),
            /preserved work baro-recovery\/absent\/S1\/1 is unavailable for resuming story S1/,
        )
        assert.equal(mgr.creationSha("S1"), null)
    })
})

describe("WorktreeManager — recovery material survives teardown", () => {
    it("cleanupAll mints and keeps a resolvable ref for a preserved story", async () => {
        const p1 = (await mgr.create("S1"))!
        const p2 = (await mgr.create("S2"))!
        commitInWorktree(p1, "a.txt", "S1wins\nline2\nline3\n")
        commitInWorktree(p2, "a.txt", "S2wins\nline2\nline3\n")
        await mgr.mergeBack("S1")
        await assert.rejects(() => mgr.mergeBack("S2"), /conflicts with already-merged work/)
        const rejectedAttempt = git(p2, "rev-parse", "HEAD")

        await mgr.cleanupAll()

        const ref = mgr.recoveryRef("S2")
        assert.ok(ref, "cleanupAll secured the preserved attempt before removing it")
        assert.match(ref!, RECOVERY_REF)
        assert.equal(git(repo, "rev-parse", "--verify", ref!), rejectedAttempt)
    })
})

describe("WorktreeManager — recovery refusal wording", () => {
    it("names 'never preserved' when the story never had preserved material", async () => {
        await assert.rejects(
            () => mgr.prepareConflictRetry("S-unknown"),
            (error: unknown) => {
                assert.equal(
                    (error as Error).message,
                    "story S-unknown has no preserved worktree to recover: never preserved",
                )
                return true
            },
        )
    })

    it("names the disposition when material was preserved and later cleaned", async () => {
        const path = (await mgr.create("S1"))!
        commitInWorktree(path, "story.txt", "work before suspension\n")
        const preserved = (await mgr.cleanupFailed("S1", true))!
        // Recovery material lost outside the manager (operator pruning refs).
        git(repo, "branch", "-D", preserved)

        await assert.rejects(
            () => mgr.prepareConflictRetry("S1"),
            (error: unknown) => {
                assert.equal(
                    (error as Error).message,
                    "story S1 has no preserved worktree to recover: preserved and later " +
                        `cleaned (reason=release_logical_story, recoveryRef=${preserved})`,
                )
                return true
            },
        )
    })
})
