import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    GitGate,
    createOrCheckoutBranch,
    getCommitCount,
    gitPushWithRetry,
} from "../../src/integration/git.js"

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "baro-git-test-"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "line1\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    return repo
}

let repo: string
let remote: string | null
let logs: string[]

beforeEach(() => {
    repo = initRepo()
    remote = null
    logs = []
})

afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }) } catch { /* */ }
    if (remote) {
        try { rmSync(remote, { recursive: true, force: true }) } catch { /* */ }
    }
})

// Issue #106: three runs ended on "Rebase conflict detected" while their work
// was complete; one of them with the remote unmoved. A push failure of any
// kind fell into a pull, and a pull failing for any reason was called a
// conflict and ended the run.
describe("gitPushWithRetry", () => {
    let peer: string

    /** A bare origin holding `main`, plus a second clone that can race us. */
    function armRemote(): void {
        remote = mkdtempSync(join(tmpdir(), "baro-git-remote-"))
        git(remote!, "init", "--bare")
        git(repo, "remote", "add", "origin", remote!)
        git(repo, "push", "-u", "origin", "main")
        peer = mkdtempSync(join(tmpdir(), "baro-git-peer-"))
        git(peer, "clone", "-q", remote!, ".")
        git(peer, "config", "user.email", "p@p.p")
        git(peer, "config", "user.name", "peer")
    }

    function peerPushes(file: string, content: string): void {
        writeFileSync(join(peer, file), content)
        git(peer, "add", "-A")
        git(peer, "commit", "-m", `peer ${file}`)
        git(peer, "push", "origin", "main")
    }

    function localCommits(file: string, content: string): void {
        writeFileSync(join(repo, file), content)
        git(repo, "add", "-A")
        git(repo, "commit", "-m", `local ${file}`)
    }

    afterEach(() => {
        try { rmSync(peer, { recursive: true, force: true }) } catch { /* */ }
    })

    it("rebases onto a moved remote and pushes, naming the target sha", async () => {
        armRemote()
        peerPushes("peer.txt", "peer\n")
        localCommits("local.txt", "local\n")

        await gitPushWithRetry(new GitGate(), { cwd: repo, onLog: (l) => logs.push(l) })

        const remoteHead = git(remote!, "rev-parse", "main")
        assert.equal(git(repo, "rev-parse", "HEAD"), remoteHead)
        assert.equal(git(repo, "log", "--format=%s", "-3"), "local local.txt\npeer peer.txt\ninit")
        const peerSha = git(peer, "rev-parse", "HEAD").slice(0, 8)
        assert.ok(
            logs.some((l) => l.includes(`onto origin/main@${peerSha}`)),
            `rebase target missing from log: ${logs.join(" | ")}`,
        )
        assert.ok(logs.includes("[git] push ok"))
    })

    it("reports a real conflict with the target sha and the conflicting paths, leaving the tree clean", async () => {
        armRemote()
        peerPushes("a.txt", "peer version\n")
        localCommits("a.txt", "local version\n")
        const localHead = git(repo, "rev-parse", "HEAD")
        const peerSha = git(peer, "rev-parse", "HEAD").slice(0, 8)

        await assert.rejects(
            gitPushWithRetry(new GitGate(), { cwd: repo, onLog: (l) => logs.push(l) }),
            (error: unknown) => {
                assert.equal(
                    (error as Error).message,
                    `Rebase conflict against origin/main@${peerSha} (local HEAD ${localHead.slice(0, 8)}): a.txt; push skipped`,
                )
                return true
            },
        )
        assert.equal(git(repo, "rev-parse", "HEAD"), localHead, "aborted rebase restores HEAD")
        assert.equal(git(repo, "status", "--porcelain"), "", "no rebase leftovers")
        assert.ok(logs.some((l) => l.includes("rebase conflict against origin/main@") && l.includes("a.txt")))
    })

    it("does not mistake a dirty working tree for a rebase conflict", async () => {
        armRemote()
        peerPushes("peer.txt", "peer\n")
        localCommits("local.txt", "local\n")
        // Tracked, uncommitted edit — what a timed-out verification step leaves behind.
        writeFileSync(join(repo, "a.txt"), "edited but not committed\n")

        await gitPushWithRetry(new GitGate(), { cwd: repo, onLog: (l) => logs.push(l) })

        assert.equal(git(repo, "rev-parse", "HEAD"), git(remote!, "rev-parse", "main"))
        // The helper trims the porcelain line's leading space.
        assert.equal(git(repo, "status", "--porcelain"), "M a.txt", "the edit survives the rebase")
        assert.ok(!logs.some((l) => /conflict/i.test(l)), logs.join(" | "))
    })
})

describe("createOrCheckoutBranch - branch name handling", () => {
    it("strips repeated baro prefixes before checkout and push logging", async () => {
        remote = mkdtempSync(join(tmpdir(), "baro-git-remote-"))
        git(remote, "init", "--bare")
        git(repo, "remote", "add", "origin", remote)

        await createOrCheckoutBranch(repo, "baro/baro/baro/S4", (line) => {
            logs.push(line)
        })

        assert.equal(git(repo, "branch", "--show-current"), "baro/S4")
        assert.equal(git(repo, "branch", "--list", "baro/baro/*"), "")
        assert.ok(
            logs.some((line) => line === "[git] pushed -u origin baro/S4"),
            "push log uses the canonical branch name",
        )
        assert.ok(
            logs.every((line) => !line.includes("baro/baro/")),
            "logs never include the repeated prefix",
        )
    })

    it("checks out an existing canonical branch from a repeated-prefix input", async () => {
        git(repo, "branch", "baro/S4")

        await createOrCheckoutBranch(repo, "baro/baro/S4")

        assert.equal(git(repo, "branch", "--show-current"), "baro/S4")
        assert.equal(git(repo, "branch", "--list", "baro/baro/S4"), "")
    })

    it("creates a local branch without touching origin when push is disabled", async () => {
        remote = mkdtempSync(join(tmpdir(), "baro-git-remote-"))
        git(remote, "init", "--bare")
        git(repo, "remote", "add", "origin", remote)

        await createOrCheckoutBranch(
            repo,
            "baro/local-only",
            (line) => logs.push(line),
            false,
        )

        assert.equal(git(repo, "branch", "--show-current"), "baro/local-only")
        assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), "")
        assert.ok(logs.includes("[git] local-only; not pushing baro/local-only"))
    })
})

describe("getCommitCount", () => {
    it("counts every story and merge commit after the run base", async () => {
        const baseSha = git(repo, "rev-parse", "HEAD")
        git(repo, "checkout", "-b", "story/S1")
        writeFileSync(join(repo, "b.txt"), "second\n")
        git(repo, "add", "b.txt")
        git(repo, "commit", "-m", "story change")
        git(repo, "checkout", "main")
        git(repo, "merge", "--no-ff", "story/S1", "-m", "merge story S1")

        assert.equal(await getCommitCount(repo, baseSha), 2)
    })

    it("returns zero when the range cannot be read", async () => {
        assert.equal(await getCommitCount(repo, "missing-base"), 0)
    })
})

describe("ensureGreenfieldRepo", () => {
    it("initializes only a truly empty directory", async () => {
        const { ensureGreenfieldRepo, isInsideGitRepo } = await import(
            "../../src/integration/git.js"
        )
        const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
        const { tmpdir } = await import("node:os")
        const { join } = await import("node:path")

        const empty = mkdtempSync(join(tmpdir(), "baro-greenfield-"))
        try {
            assert.equal(await ensureGreenfieldRepo(empty), true)
            assert.equal(await isInsideGitRepo(empty), true)
            // Root commit exists so branches have a base.
            const { execFileSync } = await import("node:child_process")
            const head = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: empty,
            })
                .toString()
                .trim()
            assert.ok(head.length >= 7)
            // Idempotent: an existing repo is untouched.
            assert.equal(await ensureGreenfieldRepo(empty), false)
        } finally {
            rmSync(empty, { recursive: true, force: true })
        }

        const occupied = mkdtempSync(join(tmpdir(), "baro-occupied-"))
        try {
            writeFileSync(join(occupied, "notes.txt"), "x")
            assert.equal(await ensureGreenfieldRepo(occupied), false)
            assert.equal(await isInsideGitRepo(occupied), false)
        } finally {
            rmSync(occupied, { recursive: true, force: true })
        }
    })
})
