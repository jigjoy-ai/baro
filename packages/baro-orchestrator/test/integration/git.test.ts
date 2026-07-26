import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createOrCheckoutBranch, getCommitCount } from "../../src/integration/git.js"

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
