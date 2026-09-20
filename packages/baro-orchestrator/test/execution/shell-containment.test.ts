import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    BASE_GATES,
    SHELL_SCRATCH_DIRNAME,
    announceGates,
    shellContainmentRemedyLine,
} from "../../src/execution/gate-registry.js"
import {
    hookShellAccessContext,
    shellContainmentRefusal,
} from "../../src/execution/shell-containment.js"
import {
    materializePublishGuardHooks,
    materializeStoryHooks,
} from "../../src/harness/claude/hook-bridge.js"
import { StoryAgent } from "../../src/harness/claude/story-agent.js"
import { StoryCommandRefused } from "../../src/semantic-events.js"
import { captureEnv, FIXTURE_TIMEOUT_SECS, withTempDir } from "./helpers.js"

const ROOT = join(import.meta.dirname, "..", "..")
const GATE = "[gate:shell-containment]"
const ESCAPING = "mktemp -d && git worktree add /tmp/baro-scratch-wt main"
const CONTAINED = `mkdir -p ${SHELL_SCRATCH_DIRNAME} && git worktree add ${SHELL_SCRATCH_DIRNAME}/wt main`

function runPreBash(hooks: string, command: string, cwd?: string): string {
    return execFileSync("node", [join(hooks, "hook.mjs"), "pre-bash"], {
        input: JSON.stringify({
            tool_name: "Bash",
            tool_input: { command },
            ...(cwd === undefined ? {} : { cwd }),
        }),
        encoding: "utf8",
    })
}

function installStoryHooks(dir: string, worktreeRoot: string): string {
    const hooks = join(dir, "hooks")
    materializeStoryHooks(
        hooks,
        { writes: ["src/mine.ts"], ownedElsewhere: { "src/theirs.ts": "S2" } },
        { command: "agent-collab", capability: "note" },
        worktreeRoot,
    )
    return hooks
}

describe("shell containment — one rule, the native lane and the Claude hook", () => {
    it("refuses a scratch checkout that leaves the worktree, and records it for the story", async () => {
        await withTempDir("shell-containment-deny-", async (dir) => {
            const worktree = join(dir, "wt")
            mkdirSync(worktree)
            const hooks = installStoryHooks(dir, worktree)

            const parsed = JSON.parse(runPreBash(hooks, ESCAPING))
            assert.equal(parsed.decision, "block")
            assert.equal(
                parsed.hookSpecificOutput.hookEventName,
                "PreToolUse",
            )
            assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny")
            const reason = parsed.hookSpecificOutput.permissionDecisionReason
            assert.ok(reason.startsWith(GATE), reason)
            assert.match(reason, /\/tmp\/baro-scratch-wt.*escapes the project root/)
            assert.match(reason, /\.baro-scratch\//)

            // Command substitution hides the same escape behind a subshell.
            const substituted = JSON.parse(
                runPreBash(hooks, "git worktree add $(mktemp -d) main"),
            )
            assert.equal(
                substituted.hookSpecificOutput.permissionDecision,
                "deny",
            )

            assert.deepEqual(
                readFileSync(join(hooks, "refusals.jsonl"), "utf8")
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line).command),
                [ESCAPING, "git worktree add $(mktemp -d) main"],
            )
        })
    })

    it("permits a command that writes only under the worktree, .baro-scratch included", async () => {
        await withTempDir("shell-containment-allow-", async (dir) => {
            const worktree = join(dir, "wt")
            mkdirSync(worktree)
            const hooks = installStoryHooks(dir, worktree)

            assert.equal(runPreBash(hooks, CONTAINED), "")
            assert.equal(runPreBash(hooks, "npm test -- test/a.test.ts"), "")
            assert.equal(
                existsSync(join(hooks, "refusals.jsonl")),
                false,
                "an allowed command leaves no refusal behind",
            )
        })
    })

    it("the hook's verdict is the native lane's verdict, from the one implementation", async () => {
        await withTempDir("shell-containment-parity-", async (dir) => {
            const worktree = join(dir, "wt")
            mkdirSync(worktree)
            const hooks = installStoryHooks(dir, worktree)
            const access = hookShellAccessContext(worktree, null)

            const native = shellContainmentRefusal(worktree, ESCAPING, access)
            assert.ok(native)
            const hook = JSON.parse(runPreBash(hooks, ESCAPING))
                .hookSpecificOutput.permissionDecisionReason
            assert.ok(
                hook.startsWith(native!),
                `${hook} begins with the native refusal ${native}`,
            )
            assert.equal(
                shellContainmentRefusal(worktree, CONTAINED, access),
                null,
            )
        })
    })

    it("a story with no write surface is contained too", async () => {
        await withTempDir("shell-containment-guard-only-", async (dir) => {
            const worktree = join(dir, "wt")
            mkdirSync(worktree)
            const hooks = join(dir, "hooks")
            materializePublishGuardHooks(hooks, worktree)

            assert.equal(existsSync(join(hooks, "surface.json")), false)
            const parsed = JSON.parse(runPreBash(hooks, ESCAPING))
            assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny")
        })
    })

    it("a hook must never break the agent: missing or unparseable containment never blocks", async () => {
        await withTempDir("shell-containment-degraded-", async (dir) => {
            const worktree = join(dir, "wt")
            mkdirSync(worktree)
            const hooks = installStoryHooks(dir, worktree)

            writeFileSync(join(hooks, "containment.json"), "{not json")
            assert.equal(runPreBash(hooks, ESCAPING), "")
            rmSync(join(hooks, "containment.json"))
            assert.equal(runPreBash(hooks, ESCAPING), "")
            // Publishing stays denied: its guard never reads containment.json.
            assert.match(
                runPreBash(hooks, "git push origin HEAD"),
                /publish commands are denied/,
            )
        })
    })

    it("without a recorded worktree the hook judges the directory Claude reports", async () => {
        await withTempDir("shell-containment-cwd-", async (dir) => {
            const worktree = join(dir, "wt")
            mkdirSync(worktree)
            const hooks = join(dir, "hooks")
            materializePublishGuardHooks(hooks)

            assert.equal(
                JSON.parse(readFileSync(join(hooks, "containment.json"), "utf8"))
                    .worktreeRoot,
                null,
            )
            assert.equal(runPreBash(hooks, ESCAPING), "", "no root, no verdict")
            const parsed = JSON.parse(runPreBash(hooks, ESCAPING, worktree))
            assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny")
        })
    })

    it("the rule is announced to every story and joins its refusal on one id", () => {
        const announced = announceGates(BASE_GATES, {})
        const text = announced.find((entry) => entry.includes(GATE))
        assert.ok(text, "every story, in every lane, is told about the rule")
        assert.ok(
            text!.split("\n")[0]!.includes(GATE),
            "the disclosure opens with its marker",
        )
        for (const shape of [
            "cd",
            "absolute paths outside it",
            "parent",
            "home",
            "nested shell evaluation",
            "redirection through a symlink",
        ]) {
            assert.ok(text!.includes(shape), `refused shape disclosed: ${shape}`)
        }
        assert.ok(
            text!.includes(
                "create scratch checkouts under `<worktree>/.baro-scratch/`, " +
                    "which is inside the worktree and is not part of your write " +
                    "surface for the merge gate.",
            ),
            "the remedy is stated verbatim",
        )
        assert.equal(
            shellContainmentRemedyLine(SHELL_SCRATCH_DIRNAME).includes(
                "<worktree>/.baro-scratch/",
            ),
            true,
        )
    })

    it("the rule has one owner: the planning adapter holds no second copy", () => {
        const source = readFileSync(
            join(ROOT, "src/planning/adapters/codebase-tools.ts"),
            "utf8",
        )
        assert.ok(
            source.includes('from "../../execution/shell-containment.js"'),
            "the native lane imports the rule instead of defining it",
        )
        for (const moved of [
            "function bashContainmentRejection",
            "function shellContainmentRefusal",
            "function tokenizeShell",
            "function rejectPathOperand",
            "function hasMacosWriteSandbox",
            "function shellAccessContext",
        ]) {
            assert.ok(
                !source.includes(moved),
                `${moved} moved out of codebase-tools.ts rather than being copied`,
            )
        }
    })
})

describe("Claude story lane", () => {
    it("a contained refusal surfaces as StoryCommandRefused with harness claude", async () => {
        await withTempDir("shell-containment-claude-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const settingsPath = join(installStoryHooks(dir, cwd), "settings.json")
            const claudeBin = join(dir, "claude")
            // Plays Claude Code: runs the configured Bash PreToolUse hook the
            // way the real CLI would before executing the scratch checkout.
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs")
const { execSync } = require("node:child_process")
const settings = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"))
const bash = settings.hooks.PreToolUse.find((h) => h.matcher === "Bash")
const out = execSync(bash.hooks[0].command, {
  input: JSON.stringify({ tool_name: "Bash", tool_input: { command: ${JSON.stringify(ESCAPING)} } }),
}).toString()
writeFileSync("hook-output.json", out)
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }))
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "s", is_error: false, result: "ok" }))
setTimeout(() => process.exit(0), 20)
process.stdin.resume()
`,
            )
            chmodSync(claudeBin, 0o755)
            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-containment",
                prompt: "make a scratch checkout",
                cwd,
                claudeBin,
                cliSettingsPath: settingsPath,
                retries: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })

            await agent.run(env)

            const hook = JSON.parse(
                readFileSync(join(cwd, "hook-output.json"), "utf8"),
            )
            assert.equal(hook.hookSpecificOutput.permissionDecision, "deny")
            const refused = env.events.filter(StoryCommandRefused.is)
            assert.equal(refused.length, 1)
            assert.equal(refused[0]!.data.storyId, "story-containment")
            assert.equal(refused[0]!.data.command, ESCAPING)
            assert.equal(refused[0]!.data.harness, "claude")
            assert.ok(refused[0]!.data.reason.startsWith(GATE))
        })
    })
})
