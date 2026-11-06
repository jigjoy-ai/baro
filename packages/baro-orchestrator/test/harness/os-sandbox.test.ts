import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { confinedSpawn, storyCredentialEnv } from "../../src/harness/os-sandbox.js"

// Codex, OpenCode, Pi and Devin run their tools with approvals and their own
// sandboxes off; an audit found nothing but a git/gh PATH shim around them.
describe("OS confinement of a story's CLI lane", () => {
    it("strips publish credentials and makes every push URL unusable", () => {
        const env = storyCredentialEnv({
            PATH: "/usr/bin",
            GH_TOKEN: "x",
            GITHUB_TOKEN: "x",
            SSH_AUTH_SOCK: "/tmp/agent",
            OPENAI_API_KEY: "kept-for-the-cli",
        })
        assert.equal(env.GH_TOKEN, undefined)
        assert.equal(env.GITHUB_TOKEN, undefined)
        assert.equal(env.SSH_AUTH_SOCK, undefined)
        assert.equal(env.OPENAI_API_KEY, "kept-for-the-cli", "the CLI still needs its model key")
        const repo = mkdtempSync(join(tmpdir(), "baro-push-off-"))
        try {
            execFileSync("git", ["init", "-q", repo])
            execFileSync("git", ["remote", "add", "origin", "https://github.com/x/y.git"], { cwd: repo })
            const pushUrl = execFileSync("git", ["remote", "get-url", "--push", "origin"], {
                cwd: repo,
                env: env as NodeJS.ProcessEnv,
                encoding: "utf8",
            }).trim()
            assert.match(pushUrl, /^baro-push-disabled:\/\//)
        } finally {
            rmSync(repo, { recursive: true, force: true })
        }
    })

    it("holds the whole CLI process tree to the worktree on macOS", { skip: process.platform !== "darwin" }, () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "baro-confine-")))
        try {
            execFileSync("git", ["init", "-q", "-b", "main", join(root, "repo")])
            execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: join(root, "repo") })
            execFileSync("git", ["worktree", "add", "-q", "-b", "s1", join(root, "S1", "repo")], { cwd: join(root, "repo") })
            mkdirSync(join(root, "S2"))
            const worktree = join(root, "S1", "repo")
            // A stand-in for the agent CLI: it runs whatever its tools would.
            const cli = join(root, "fake-cli")
            writeFileSync(
                cli,
                [
                    "#!/bin/sh",
                    'echo in > inside.txt && echo inside-ok',
                    'git add inside.txt && git -c user.name=t -c user.email=t@t commit -q -m in && echo commit-ok',
                    `echo x > ${join(root, "S2", "stolen.txt")} 2>/dev/null && echo sibling-WRITTEN`,
                    `printf '[x]\\n' >> ${join(root, "repo", ".git", "config")} 2>/dev/null && echo config-WRITTEN`,
                    'ls "$HOME/.ssh" >/dev/null 2>&1 && echo ssh-READ',
                    'mkdir -p "$npm_config_cache" && echo c > "$npm_config_cache/probe" && echo cache-ok',
                    `P="$HOME/Library/Caches/baro-probe-$$"; touch "$P" 2>/dev/null && rm -f "$P" && echo host-cache-WRITTEN`,
                    "exit 0",
                ].join("\n"),
            )
            chmodSync(cli, 0o755)

            const { BARO_UNSAFE_NO_SANDBOX: _optOut, ...hostEnv } = process.env
            const env = { ...hostEnv, BARO_PACKAGE_CACHE: join(root, "cache") }
            const plan = confinedSpawn("codex", cli, [], worktree, env)
            assert.ok(!("refusal" in plan), JSON.stringify(plan))
            const run = spawnSync(plan.binary, plan.args, { cwd: worktree, env: plan.env, encoding: "utf8" })
            assert.match(run.stdout, /inside-ok/)
            assert.match(run.stdout, /commit-ok/, run.stderr)
            assert.doesNotMatch(run.stdout, /sibling-WRITTEN/)
            assert.doesNotMatch(run.stdout, /config-WRITTEN/)
            assert.doesNotMatch(run.stdout, /ssh-READ/)
            assert.match(run.stdout, /cache-ok/, run.stderr)
            assert.doesNotMatch(run.stdout, /host-cache-WRITTEN/)
            assert.equal(existsSync(join(root, "S2", "stolen.txt")), false)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it("refuses to start unconfined where it has no sandbox, unless the user opts out", () => {
        if (process.platform === "darwin") return
        const plan = confinedSpawn("codex", "/bin/sh", [], process.cwd(), {})
        assert.ok("refusal" in plan)
        const optedOut = confinedSpawn("codex", "/bin/sh", [], process.cwd(), { BARO_UNSAFE_NO_SANDBOX: "1" })
        assert.ok(!("refusal" in optedOut))
    })
})
