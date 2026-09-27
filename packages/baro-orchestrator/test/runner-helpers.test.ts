import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInstallServiceArgs, buildReexec, gitCredentialHelper, parseDoneSuccess, semverLt, unpublishedWorkDiff, writeGithubCredentials } from "../scripts/runner-helpers.js"

describe("semverLt", () => {
    it("orders plain semvers", () => {
        assert.equal(semverLt("0.58.0", "0.72.1"), true)
        assert.equal(semverLt("0.72.1", "0.72.1"), false)
        assert.equal(semverLt("0.72.2", "0.72.1"), false)
        assert.equal(semverLt("0.9.9", "0.10.0"), true)
    })
})

describe("buildReexec", () => {
    it("re-runs the same script + args under the same node, with the loop guard set", () => {
        const r = buildReexec("/usr/bin/node", ["/usr/bin/node", "/g/runner.mjs", "--flag"], { RUNNER_TOKEN: "rt_x", PATH: "/bin" })
        assert.equal(r.cmd, "/usr/bin/node")
        assert.deepEqual(r.args, ["/g/runner.mjs", "--flag"])
        assert.equal(r.env.BARO_UPDATED, "1")
        assert.equal(r.env.RUNNER_TOKEN, "rt_x") // same credentials → same runnerId pairing
    })

    it("does not mutate the caller's env", () => {
        const env = { PATH: "/bin" }
        buildReexec("/usr/bin/node", ["/usr/bin/node", "s.mjs"], env)
        assert.equal("BARO_UPDATED" in env, false)
    })
})

describe("buildInstallServiceArgs", () => {
    it("builds the install-service invocation with the paired token + workspace", () => {
        assert.deepEqual(buildInstallServiceArgs({ token: "rt_abc", workspace: "/w" }), ["connect", "--install-service", "--token", "rt_abc", "--workspace", "/w"])
    })

    it("passes the control-plane override through when set", () => {
        const args = buildInstallServiceArgs({ token: "rt_abc", workspace: "/w", controlUrl: "wss://staging" })
        assert.deepEqual(args.slice(-2), ["--control-url", "wss://staging"])
    })
})

describe("parseDoneSuccess", () => {
    it("preserves explicit outcomes and treats a legacy missing field as success", () => {
        assert.equal(parseDoneSuccess(true), true)
        assert.equal(parseDoneSuccess(false), false)
        assert.equal(parseDoneSuccess(undefined), true)
        assert.equal(parseDoneSuccess("false"), null)
        assert.equal(parseDoneSuccess(null), null)
    })
})

const git = (cwd: string, args: string[], input?: string) =>
    execFileSync("git", args, {
        cwd,
        input,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).toString()

describe("GitHub credentials that outlive the dispatch token (#191)", () => {
    it("git and gh read the latest token written for the run", () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-gh-test-"))
        const repo = mkdtempSync(join(tmpdir(), "baro-repo-test-"))
        git(repo, ["init", "-q"])
        git(repo, ["config", "credential.helper", ""])
        git(repo, ["config", "--add", "credential.helper", gitCredentialHelper(join(dir, "token"))])
        const fill = () => git(repo, ["credential", "fill"], "protocol=https\nhost=github.com\npath=me/project-newname.git\n\n")

        writeGithubCredentials(dir, "ghs_first")
        assert.match(fill(), /username=x-access-token\npassword=ghs_first\n/)
        writeGithubCredentials(dir, "ghs_refreshed")
        assert.match(fill(), /password=ghs_refreshed\n/)
        assert.match(readFileSync(join(dir, "gh", "hosts.yml"), "utf8"), /^    oauth_token: ghs_refreshed$/m)
        assert.equal(readFileSync(join(dir, "gh", "config.yml"), "utf8"), 'version: "1"\n')
    })
})

describe("unpublishedWorkDiff (#191)", () => {
    it("returns the goal branch's work since the run's base", () => {
        const repo = mkdtempSync(join(tmpdir(), "baro-repo-test-"))
        git(repo, ["init", "-q", "-b", "main"])
        writeFileSync(join(repo, "a.txt"), "a\n")
        git(repo, ["add", "a.txt"])
        git(repo, ["commit", "-qm", "base"])
        const base = git(repo, ["rev-parse", "HEAD"]).trim()
        assert.equal(unpublishedWorkDiff(repo, base), undefined, "no prd.json yet")

        git(repo, ["checkout", "-qb", "baro/feat"])
        writeFileSync(join(repo, "b.txt"), "built\n")
        git(repo, ["add", "b.txt"])
        git(repo, ["commit", "-qm", "story"])
        git(repo, ["checkout", "-q", "main"])
        writeFileSync(join(repo, "prd.json"), JSON.stringify({ branchName: "baro/baro/feat" }))

        const diff = unpublishedWorkDiff(repo, base)
        assert.match(diff ?? "", /^diff --git a\/b.txt b\/b.txt$/m)
        assert.match(diff ?? "", /^\+built$/m)

        writeFileSync(join(repo, "prd.json"), JSON.stringify({ branchName: "baro/gone" }))
        assert.equal(unpublishedWorkDiff(repo, base), undefined)
    })
})
