import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, it } from "@rstest/core"

import { materializeStoryHooks } from "../../src/harness/claude/hook-bridge.js"

const dir = mkdtempSync(join(tmpdir(), "baro-hook-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function runHook(mode: string, input: unknown): string {
    return execFileSync("node", [join(dir, "hook.mjs"), mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
    })
}

describe("hook bridge — the agent's world shows the mechanisms", () => {
    const settings = materializeStoryHooks(
        dir,
        {
            writes: ["src/mine.ts"],
            ownedElsewhere: { "src/theirs.ts": "S2" },
        },
        { command: "agent-collab", capability: "note" },
        dir,
    )

    it("materializes trusted settings wiring both hook events", () => {
        assert.ok(settings && existsSync(settings))
        const parsed = JSON.parse(readFileSync(settings!, "utf8"))
        assert.ok(parsed.hooks.PostToolUse[0].matcher === "Bash")
        assert.match(parsed.hooks.PreToolUse[0].matcher, /Write\|Edit/)
    })

    it("acknowledges evidence capture on a verification command, and only there", () => {
        const out = runHook("post-bash", {
            tool_input: { command: "npm test 2>&1 | tail -30" },
        })
        assert.match(out, /\[gate:evidence-capture\]/)
        assert.match(out, /do not re-run/i)

        assert.equal(
            runHook("post-bash", { tool_input: { command: "ls -la" } }),
            "",
            "an ordinary command gets no lecture",
        )
    })

    it("refuses a write into another story's surface at the write, with the registry's remedy", () => {
        const out = runHook("pre-write", {
            tool_input: { file_path: "src/theirs.ts" },
        })
        const parsed = JSON.parse(out)
        assert.equal(parsed.decision, "block")
        assert.equal(
            parsed.hookSpecificOutput.permissionDecision,
            "deny",
        )
        assert.match(parsed.reason, /\[gate:write-surface\]/)
        assert.match(parsed.reason, /belongs to story S2/)
        assert.match(parsed.reason, /Ask that owner/)
    })

    it("lets the story write inside its own surface without a word", () => {
        assert.equal(
            runHook("pre-write", { tool_input: { file_path: "src/mine.ts" } }),
            "",
        )
    })

    it("a guarding hook refuses input it cannot read; the advisory one stays silent", () => {
        const run = (mode: string) =>
            execFileSync("node", [join(dir, "hook.mjs"), mode], {
                input: "not json at all",
                encoding: "utf8",
            })
        assert.equal(JSON.parse(run("pre-write")).decision, "block")
        assert.equal(run("post-bash"), "")
    })

    it("a story with no surface gets no hooks at all", () => {
        assert.equal(
            materializeStoryHooks(join(dir, "none"), undefined, {
                command: "c",
                capability: "n",
            }),
            null,
        )
    })
})

describe("a story's Claude Code tool set", () => {
    it("names no command-running or writing tool the guard hooks do not match", async () => {
        const { STORY_CLI_ISOLATION } = await import("../../src/harness/claude/story-agent.js")
        const tools = STORY_CLI_ISOLATION[STORY_CLI_ISOLATION.indexOf("--tools") + 1]!.split(",")
        const hookDir = mkdtempSync(join(tmpdir(), "baro-hook-tools-"))
        try {
            const settings = JSON.parse(
                readFileSync(
                    materializeStoryHooks(
                        hookDir,
                        { writes: ["a.ts"], ownedElsewhere: {} },
                        { command: "c", capability: "n" },
                        hookDir,
                    )!,
                    "utf8",
                ),
            )
            const matchers = settings.hooks.PreToolUse.map(
                (entry: { matcher: string }) => new RegExp(`^(?:${entry.matcher})$`),
            )
            const guarded = (tool: string) => matchers.some((matcher: RegExp) => matcher.test(tool))
            for (const tool of tools) {
                if (["Read", "Glob", "Grep"].includes(tool)) continue
                assert.ok(guarded(tool), `${tool} runs commands or writes files, so a hook must match it`)
            }
            assert.equal(STORY_CLI_ISOLATION[STORY_CLI_ISOLATION.indexOf("--setting-sources") + 1], "user")
        } finally {
            rmSync(hookDir, { recursive: true, force: true })
        }
    })
})

describe("a Claude story's OS sandbox", () => {
    it("confines Bash to the worktree and the git metadata a commit needs, with no escape", async () => {
        const { claudeStorySandbox } = await import("../../src/harness/claude/hook-bridge.js")
        const repo = mkdtempSync(join(tmpdir(), "baro-sandbox-settings-"))
        try {
            execFileSync("git", ["init", "-q", "-b", "main", repo])
            execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: repo })
            // Stories always run in a linked worktree, as here.
            const worktree = join(repo, ".story")
            execFileSync("git", ["worktree", "add", "-q", "-b", "s1", worktree], { cwd: repo })
            // integration/worktree.ts links dependency dirs to the run's shared copy.
            const shared = join(repo, "shared-node_modules")
            execFileSync("mkdir", ["-p", shared, join(worktree, "web")])
            execFileSync("ln", ["-s", shared, join(worktree, "web", "node_modules")])
            const cacheRoot = join(repo, ".cache-root")
            const settings = claudeStorySandbox(worktree, "http://127.0.0.1:43123/v1", { BARO_PACKAGE_CACHE: cacheRoot }) as {
                sandbox: {
                    enabled: boolean
                    failIfUnavailable: boolean
                    allowUnsandboxedCommands: boolean
                    filesystem: { allowWrite: string[]; denyRead: string[] }
                    network: { allowedDomains: string[]; strictAllowlist: boolean }
                }
                permissions: { blockWritesOutsideWorkingDirectories: boolean }
                env: Record<string, string>
            }
            assert.equal(settings.sandbox.enabled, true)
            assert.equal(settings.sandbox.failIfUnavailable, true, "a story whose sandbox cannot start does not run")
            assert.equal(settings.sandbox.allowUnsandboxedCommands, false, "no escape hatch")
            assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true)
            const writes = settings.sandbox.filesystem.allowWrite
            assert.ok(writes.some((path) => path.endsWith("/objects")))
            assert.ok(!writes.some((path) => path.endsWith("/.git") || path.endsWith("/config")), "never the shared config")
            assert.ok(settings.sandbox.filesystem.denyRead.includes("~/.ssh"))
            assert.ok(settings.sandbox.network.allowedDomains.includes("127.0.0.1:43123"), "the lease's broker")
            assert.ok(!settings.sandbox.network.allowedDomains.some((domain) => domain.includes("github")))
            assert.equal(settings.sandbox.network.strictAllowlist, true)
            // npm refuses to install without a writable cache; the user's own
            // caches stay out of reach, so a story cannot poison them.
            const cache = realpathSync(cacheRoot)
            assert.ok(writes.includes(cache))
            assert.ok(!writes.some((path) => /\/(\.npm|\.cache|Library\/Caches)$/u.test(path)))
            assert.equal(settings.env.npm_config_cache, join(cache, "npm"))
            assert.ok(writes.includes(realpathSync(shared)), "a story's install reaches the shared node_modules")
            assert.equal(settings.env.PIP_CACHE_DIR, join(cache, "pip"))
            // pnpm 12 ignores npm_config_store_dir, and npm warns about it.
            assert.equal(settings.env.pnpm_config_store_dir, join(cache, "pnpm-store"))
            assert.equal(settings.env.npm_config_store_dir, undefined)
            // Stories share one cargo build per repository instead of a cold target/ each.
            assert.ok(settings.env.CARGO_TARGET_DIR?.startsWith(join(cache, "cargo-target")))
            assert.equal(claudeStorySandbox(repo, undefined, { BARO_UNSAFE_NO_SANDBOX: "1" }), null)
        } finally {
            rmSync(repo, { recursive: true, force: true })
        }
    })
})

describe("a Claude story's shell hook under the OS sandbox", () => {
    // Run 4: with the kernel already holding writes, reads and network, the
    // command judge refused dozens of harmless reads, heredocs and inline
    // python, and every peer message whose text held a slash.
    it("leaves the shell to the sandbox but still refuses publishing, and knows the collaboration helper", async () => {
        const { materializePublishGuardHooks } = await import("../../src/harness/claude/hook-bridge.js")
        const repo = realpathSync(mkdtempSync(join(tmpdir(), "baro-sandboxed-hook-")))
        const optOut = process.env.BARO_UNSAFE_NO_SANDBOX
        const cache = process.env.BARO_PACKAGE_CACHE
        try {
            execFileSync("git", ["init", "-q", "-b", "main", join(repo, "wt")])
            const helper = join(repo, "agent-collab.mjs")
            execFileSync("touch", [helper])
            delete process.env.BARO_UNSAFE_NO_SANDBOX
            process.env.BARO_PACKAGE_CACHE = join(repo, "cache")
            const hooks = join(repo, "hooks")
            materializePublishGuardHooks(hooks, join(repo, "wt"), "http://127.0.0.1:43123", {
                command: helper,
                capability: "note",
            })
            const containment = JSON.parse(readFileSync(join(hooks, "containment.json"), "utf8"))
            assert.equal(containment.osSandbox, true)
            assert.equal(containment.collabCommand, helper)
            const bash = (command: string) =>
                execFileSync("node", [join(hooks, "hook.mjs"), "pre-bash"], {
                    input: JSON.stringify({ tool_input: { command }, cwd: join(repo, "wt") }),
                    encoding: "utf8",
                })
            assert.equal(bash("python3 -c 'print(1)'"), "")
            assert.equal(bash("cat > .baro-scratch/a.py <<'X'\nprint(1)\nX"), "")
            assert.equal(bash(`sed -n 1,5p ${join(repo, "agent-collab.mjs")}`), "")
            assert.match(bash("git push origin HEAD"), /"decision":"block"/)
        } finally {
            if (optOut === undefined) delete process.env.BARO_UNSAFE_NO_SANDBOX
            else process.env.BARO_UNSAFE_NO_SANDBOX = optOut
            if (cache === undefined) delete process.env.BARO_PACKAGE_CACHE
            else process.env.BARO_PACKAGE_CACHE = cache
            rmSync(repo, { recursive: true, force: true })
        }
    })

    it("judges every command itself when the sandbox is opted out", async () => {
        const { materializePublishGuardHooks } = await import("../../src/harness/claude/hook-bridge.js")
        const repo = realpathSync(mkdtempSync(join(tmpdir(), "baro-unsandboxed-hook-")))
        try {
            execFileSync("git", ["init", "-q", "-b", "main", join(repo, "wt")])
            const hooks = join(repo, "hooks")
            materializePublishGuardHooks(hooks, join(repo, "wt"))
            assert.equal(JSON.parse(readFileSync(join(hooks, "containment.json"), "utf8")).osSandbox, false)
            const verdict = execFileSync("node", [join(hooks, "hook.mjs"), "pre-bash"], {
                input: JSON.stringify({ tool_input: { command: "cd .. && ls" }, cwd: join(repo, "wt") }),
                encoding: "utf8",
            })
            assert.match(verdict, /"decision":"block"/)
        } finally {
            rmSync(repo, { recursive: true, force: true })
        }
    })
})
