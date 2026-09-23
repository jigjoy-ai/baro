import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    FunctionCallItem,
    ModelMessageItem,
} from "../../src/runtime/mozaik.js"
import {
    drainGuardRefusals,
    materializePublishGuardBin,
    publishCommandRefusal,
} from "../../src/execution/publish-guard.js"
import { createCodebaseTools } from "../../src/planning/adapters/codebase-tools.js"
import { OpenAIStoryAgent } from "../../src/harness/openai/story-agent.js"
import { StoryAgent } from "../../src/harness/claude/story-agent.js"
import { StoryCommandRefused } from "../../src/semantic-events.js"
import { captureEnv, FIXTURE_TIMEOUT_SECS, withTempDir } from "./helpers.js"
import {
    ArchitectureObligationContractError,
    bindArchitectureObligationContract,
    validateArchitectureObligationCoverage,
    type ArchitectureObligationContractV1,
} from "../../src/planning/domain/architecture-obligation-contract.js"
import { deriveGoalContract } from "../../src/goal/goal-contract.js"

describe("publishCommandRefusal", () => {
    for (const command of [
        "git push origin HEAD",
        "git -C dir push",
        "git -c user.name=x push --force",
        "gh pr create",
        "curl https://api.github.com/repos",
        "npm test && git push",
        "echo ok | /usr/local/bin/gh auth status",
    ]) {
        it(`refuses ${command}`, () => {
            const reason = publishCommandRefusal(command)
            assert.ok(reason)
            assert.match(reason, /^publish commands are denied in story lanes: /)
        })
    }

    it("names the offending segment", () => {
        assert.equal(
            publishCommandRefusal("npm test && git push origin HEAD"),
            "publish commands are denied in story lanes: git push origin HEAD",
        )
    })

    for (const command of [
        "git pull",
        "git log --grep push",
        "git commit -m 'push the fix'",
        "ls push",
    ]) {
        it(`allows ${command}`, () => {
            assert.equal(publishCommandRefusal(command), null)
        })
    }
})

describe("OpenAI story lane", () => {
    it("runBash without denyPublish runs the command as before", async () => {
        await withTempDir("publish-guard-plain-", async (dir) => {
            const bash = createCodebaseTools(dir).find((t) => t.name === "bash")!
            const output = await bash.invoke!({
                command: "echo 'git log --grep push' > seen.txt; cat seen.txt",
            })
            assert.match(String(output), /git log --grep push/)
        })
    })

    it("refuses git push and gh without executing them and emits StoryCommandRefused", async () => {
        await withTempDir("publish-guard-openai-", async (dir) => {
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-publish",
                    prompt: "try to publish",
                    cwd: dir,
                    retries: 0,
                    timeoutSecs: 60,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                { model: "fake-model", maxRoundsPerTurn: 2, perRoundTimeoutSecs: 60 },
            )
            let round = 0
            const rounds = [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-push",
                        name: "bash",
                        args: JSON.stringify({
                            command: "touch pushed && git push origin HEAD",
                        }),
                    }),
                    FunctionCallItem.rehydrate({
                        callId: "call-gh",
                        name: "bash",
                        args: JSON.stringify({ command: "touch gh-ran; gh pr create" }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "done" })],
            ]
            Object.defineProperty(agent, "runRound", {
                value: async () => ({ items: rounds[round++]!, usage: undefined }),
            })
            const env = captureEnv()

            await agent.run(env)

            assert.equal(existsSync(join(dir, "pushed")), false)
            assert.equal(existsSync(join(dir, "gh-ran")), false)
            const refused = env.events.filter(StoryCommandRefused.is)
            assert.deepEqual(
                refused.map((e) => e.data),
                [
                    {
                        storyId: "story-publish",
                        command: "touch pushed && git push origin HEAD",
                        reason: "publish commands are denied in story lanes: git push origin HEAD",
                        harness: "openai",
                    },
                    {
                        storyId: "story-publish",
                        command: "touch gh-ran; gh pr create",
                        reason: "publish commands are denied in story lanes: gh pr create",
                        harness: "openai",
                    },
                ],
            )
        })
    })
})

describe("Claude story lane", () => {
    it("the Bash PreToolUse hook denies gh and the agent emits StoryCommandRefused", async () => {
        await withTempDir("publish-guard-claude-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const claudeBin = join(dir, "claude")
            // Plays Claude Code: runs the configured Bash PreToolUse hook the
            // way the real CLI would before executing `gh pr create`.
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs")
const { execSync } = require("node:child_process")
const settingsPath = process.argv[process.argv.indexOf("--settings") + 1]
const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
const bash = settings.hooks.PreToolUse.find((h) => h.matcher === "Bash")
const out = execSync(bash.hooks[0].command, {
  input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr create" } }),
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
                id: "story-claude-publish",
                prompt: "try to publish",
                cwd,
                claudeBin,
                retries: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })

            await agent.run(env)

            const hook = JSON.parse(readFileSync(join(cwd, "hook-output.json"), "utf8"))
            assert.equal(hook.hookSpecificOutput.permissionDecision, "deny")
            assert.equal(
                hook.hookSpecificOutput.permissionDecisionReason,
                "publish commands are denied in story lanes: gh pr create",
            )
            assert.deepEqual(
                env.events.filter(StoryCommandRefused.is).map((e) => e.data),
                [
                    {
                        storyId: "story-claude-publish",
                        command: "gh pr create",
                        reason: "publish commands are denied in story lanes: gh pr create",
                        harness: "claude",
                    },
                ],
            )
        })
    })
})

describe("one-shot lane guard bin", { skip: process.platform === "win32" }, () => {
    it("refuses gh and git push, forwards other git commands, and records refusals", async () => {
        await withTempDir("publish-guard-bin-", async (dir) => {
            const guard = join(dir, "guard")
            materializePublishGuardBin(guard)
            const env = { ...process.env, PATH: `${guard}:${process.env.PATH}` }
            const run = (command: string) =>
                spawnSync("sh", ["-c", command], { cwd: dir, env, encoding: "utf8" })

            execFileSync("git", ["init", "-q"], { cwd: dir })
            assert.equal(run("git status --short").status, 0)
            assert.equal(run('gh pr create --title "a \\"b\\""').status, 1)
            const push = run("git -C . push origin HEAD")
            assert.equal(push.status, 1)
            assert.match(push.stderr, /publish commands are denied in story lanes/)

            assert.deepEqual(drainGuardRefusals(guard), [
                {
                    command: 'gh pr create --title a "b"',
                    reason: 'publish commands are denied in story lanes: gh pr create --title a "b"',
                },
                {
                    command: "git -C . push origin HEAD",
                    reason: "publish commands are denied in story lanes: git -C . push origin HEAD",
                },
            ])
            assert.deepEqual(drainGuardRefusals(guard), [])
        })
    })
})

describe("obligation admission rejects delivery", () => {
    function deliveryContract(): ArchitectureObligationContractV1 {
        return {
            schemaVersion: 1,
            obligations: [
                {
                    id: "O-001",
                    invariantIds: ["G-A1"],
                    subject: "the story lane",
                    scenario: "a story finishes its change",
                    expectedOutcome: "Push the branch and publish a PR",
                    evidence: ["a delivery regression test"],
                },
            ],
        }
    }

    function negatedConstraintContract(): ArchitectureObligationContractV1 {
        return {
            schemaVersion: 1,
            obligations: [
                {
                    id: "O-001",
                    invariantIds: ["G-A1"],
                    subject: "story lanes",
                    scenario: "a story issues a shell command",
                    expectedOutcome: "stories do not run git push",
                    evidence: ["the publish-guard regression test"],
                },
            ],
        }
    }

    const deliveryGoal = deriveGoalContract({
        objective: "Close the delivery obligation defect.",
        acceptanceCriteria: ["Delivery never happens inside a story."],
        constraints: [],
        nonGoals: [],
        assumptions: [],
    })!

    const negatedGoal = deriveGoalContract({
        objective: "Close the delivery obligation defect.",
        acceptanceCriteria: ["stories do not run git push"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
    })!

    it("bindArchitectureObligationContract rejects a delivery obligation with code delivery_obligation", () => {
        assert.throws(
            () => bindArchitectureObligationContract(deliveryContract(), deliveryGoal),
            (error: unknown) => {
                assert.ok(error instanceof ArchitectureObligationContractError)
                assert.equal(error.violations[0]?.kind, "delivery_obligation")
                return true
            },
        )
    })

    it("validateArchitectureObligationCoverage rejects a delivery obligation with code delivery_obligation", () => {
        assert.throws(
            () =>
                validateArchitectureObligationCoverage(deliveryContract(), [], "partial"),
            (error: unknown) => {
                assert.ok(error instanceof ArchitectureObligationContractError)
                assert.equal(error.violations[0]?.kind, "delivery_obligation")
                return true
            },
        )
    })

    it("both admission paths admit a negated delivery constraint", () => {
        assert.doesNotThrow(() =>
            bindArchitectureObligationContract(negatedConstraintContract(), negatedGoal),
        )
        assert.doesNotThrow(() =>
            validateArchitectureObligationCoverage(
                negatedConstraintContract(),
                [],
                "partial",
            ),
        )
    })

    it("admits an obligation asserting nothing is pushed, tagged, or published (#183)", () => {
        // The architect encodes the no-delivery rule as its own obligation; the
        // negation is "nothing", which the guard must read as a constraint, not
        // a delivery requirement.
        const noDelivery = (): ArchitectureObligationContractV1 => ({
            schemaVersion: 1,
            obligations: [
                {
                    id: "O-001",
                    invariantIds: ["G-A1"],
                    subject: "the worktree after the change",
                    scenario: "the change is committed",
                    expectedOutcome:
                        "The change exists as at least one commit in the worktree, the working tree is clean, and nothing is pushed, tagged, or published",
                    evidence: ["git status --porcelain is empty and git log shows the commit"],
                },
            ],
        })
        assert.doesNotThrow(() =>
            bindArchitectureObligationContract(noDelivery(), negatedGoal),
        )
        assert.doesNotThrow(() =>
            validateArchitectureObligationCoverage(noDelivery(), [], "partial"),
        )
    })
})
