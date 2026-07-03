import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createOrCheckoutBranch } from "../src/git.js"

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
})
