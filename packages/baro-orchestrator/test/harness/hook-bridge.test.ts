import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { materializeStoryHooks } from "../../src/harness/claude/hook-bridge.js"

const dir = mkdtempSync(join(tmpdir(), "baro-hook-test-"))
after(() => rmSync(dir, { recursive: true, force: true }))

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
            const settings = claudeStorySandbox(worktree, "http://127.0.0.1:43123/v1", {}) as {
                sandbox: {
                    enabled: boolean
                    failIfUnavailable: boolean
                    allowUnsandboxedCommands: boolean
                    filesystem: { allowWrite: string[]; denyRead: string[] }
                    network: { allowedDomains: string[]; strictAllowlist: boolean }
                }
                permissions: { blockWritesOutsideWorkingDirectories: boolean }
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
            assert.equal(claudeStorySandbox(repo, undefined, { BARO_UNSAFE_NO_SANDBOX: "1" }), null)
        } finally {
            rmSync(repo, { recursive: true, force: true })
        }
    })
})
