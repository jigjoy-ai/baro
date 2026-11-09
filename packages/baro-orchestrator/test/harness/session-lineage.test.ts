import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { StoryAgent } from "../../src/harness/claude/story-agent.js"
import { mainThreadRequestTokens } from "../../src/harness/claude/cli-participant.js"
import { OpenAIStoryAgent } from "../../src/harness/openai/story-agent.js"
import {
    SessionLedger,
    delegationEnabled,
    delegationInstructions,
    inheritancePreamble,
    resolveInheritance,
    type SessionInheritance,
} from "../../src/harness/session-lineage.js"
import { isReadOnlyTool } from "../../src/harness/tool-classification.js"
import { captureEnv, FIXTURE_TIMEOUT_SECS, withTempDir } from "../execution/helpers.js"
import { streamRequested, streamedCompletion } from "./openai/fake-completion.js"

const claudeRecord = (contextTokens: number | null = 40_000) =>
    ({ backend: "claude", sessionId: "parent-session", contextTokens, cwd: "/wt/S1" }) as const

describe("which session a story starts from", () => {
    // A bench story spent 2.3M input tokens and six minutes re-reading what
    // its prerequisite had just studied.
    it("forks the source story's session when its lane can resume it", () => {
        const ledger = new SessionLedger()
        ledger.record("S1", claudeRecord())
        const decision = resolveInheritance({ storyId: "S1", mode: "fork" }, "claude", ledger, {})
        assert.ok(decision && "inherit" in decision)
        assert.deepEqual(decision.inherit, {
            mode: "fork",
            fromStoryId: "S1",
            parentCwd: "/wt/S1",
            contextTokens: 40_000,
            claudeSessionId: "parent-session",
        })
        assert.equal(resolveInheritance(undefined, "claude", ledger, {}), null)
    })

    it("starts cold, and says why, whenever inheriting would not help", () => {
        const ledger = new SessionLedger()
        ledger.record("S1", claudeRecord())
        ledger.record("BIG", claudeRecord(500_000))
        ledger.record("UNKNOWN", claudeRecord(null))
        const skipped = (storyId: string, backend = "claude", env: NodeJS.ProcessEnv = {}) => {
            const decision = resolveInheritance({ storyId, mode: "fork" }, backend, ledger, env)
            assert.ok(decision && "skipped" in decision, storyId)
            return decision.skipped
        }
        assert.match(skipped("S9"), /no recorded session/)
        assert.match(skipped("S1", "codex"), /ran on claude, this story runs on codex/)
        // A fork that starts near the window compacts at once and loses what it inherited.
        assert.match(skipped("BIG"), /500000 tokens, over the 120000 limit/)
        assert.match(skipped("UNKNOWN"), /size .* is unknown/)
        assert.match(skipped("S1", "claude", { BARO_SESSION_FORK: "0" }), /is off/)
        assert.ok("inherit" in resolveInheritance(
            { storyId: "BIG", mode: "fork" }, "claude", ledger, { BARO_SESSION_FORK_MAX_TOKENS: "600000" },
        )!)
    })

    it("reads a tracked session lazily, so a running story can be forked", () => {
        const ledger = new SessionLedger()
        let sessionId: string | null = null
        ledger.track("S1", () => (sessionId ? { ...claudeRecord(), sessionId } : null))
        assert.equal(ledger.get("S1"), undefined)
        sessionId = "live"
        assert.equal(ledger.get("S1")?.sessionId, "live")
    })

    it("tells a fork who it is and where it works", () => {
        const fork = inheritancePreamble({ mode: "fork", fromStoryId: "S1", parentCwd: "/wt/S1" }, "S2", "/wt/S2")
        assert.match(fork, /You are a fork of story S1's session/)
        assert.match(fork, /You are now story S2/)
        assert.match(fork, /Your worktree is \/wt\/S2\. S1 worked in \/wt\/S1/)
        assert.match(fork, /never\s+write outside it/)
        const resumed = inheritancePreamble({ mode: "continue", fromStoryId: "S2", parentCwd: "/wt/S2" }, "S2", "/wt/S2")
        assert.match(resumed, /You are resuming story S2/)
        assert.match(resumed, /re-based onto the run branch/)
    })

    it("tells a lone story how to hand parts to forks and wait for them", () => {
        const text = delegationInstructions("S1", 3)
        assert.match(text, /split it if it has independent parts/)
        // One replan both adds the parts and suspends the lead on them.
        assert.match(text, /"modifiedDeps":\{"S1":\["S2"\]\}/)
        assert.match(text, /at most 3; ids S2, S3/)
        assert.match(text, /resumed in this same session/)
        assert.match(text, /starts as a fork of your session/)
        assert.match(text, /Do not split a small task/)
        assert.equal(delegationEnabled({}), true)
        assert.equal(delegationEnabled({ BARO_LEAD_SPLIT: "0" }), false)
        assert.equal(delegationEnabled({ BARO_SESSION_FORK: "0" }), false)
    })

    it("measures a session by its main thread's last request", () => {
        const usage = { input_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_200, output_tokens: 700 }
        assert.equal(mainThreadRequestTokens({ type: "assistant", message: { usage } }), 91_205)
        assert.equal(mainThreadRequestTokens({ type: "assistant", parent_tool_use_id: "toolu_1", message: { usage } }), null)
        assert.equal(mainThreadRequestTokens({ type: "result", usage }), null)
    })
})

/** Records its arguments and first stdin message; fails at once on `--resume gone`. */
function fakeClaude(dir: string, sessionId: string): string {
    const bin = join(dir, "claude")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path")
const args = process.argv.slice(2)
const log = path.join(${JSON.stringify(dir)}, "calls.jsonl")
if (args[args.indexOf("--resume") + 1] === "gone" && args.includes("--resume")) {
  fs.appendFileSync(log, JSON.stringify({ args, failed: true }) + "\\n")
  console.error("No conversation found with session ID: gone")
  process.exit(1)
}
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  const line = buffer.split("\\n")[0]
  if (!buffer.includes("\\n") || !line) return
  buffer = ""
  fs.appendFileSync(log, JSON.stringify({ args, prompt: JSON.parse(line).message.content }) + "\\n")
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(sessionId)} }))
  console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 4, cache_read_input_tokens: 30000, cache_creation_input_tokens: 996, output_tokens: 10 } } }))
  console.log(JSON.stringify({ type: "result", subtype: "success", session_id: ${JSON.stringify(sessionId)}, is_error: false, result: "done" }))
  setTimeout(() => process.exit(0), 20)
})
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

const calls = (dir: string): Array<{ args: string[]; prompt?: string; failed?: true }> =>
    existsSync(join(dir, "calls.jsonl"))
        ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
        : []

describe("a Claude story that inherits a session", () => {
    const run = async (dir: string, id: string, extra: { sessions?: SessionLedger; inherit?: SessionInheritance }) => {
        const cwd = join(dir, id)
        mkdirSync(cwd, { recursive: true })
        return await new StoryAgent({
            id,
            prompt: `task of ${id}`,
            cwd,
            claudeBin: join(dir, "claude"),
            retries: 0,
            timeoutSecs: FIXTURE_TIMEOUT_SECS,
            quietTimeoutMs: 5,
            ...extra,
        }).run(captureEnv())
    }

    it("records its session, and a fork resumes it with --fork-session and is told it is a fork", async () => {
        await withTempDir("session-fork-", async (dir) => {
            fakeClaude(dir, "session-of-S1")
            const sessions = new SessionLedger()
            assert.equal((await run(dir, "S1", { sessions })).success, true)

            const recorded = sessions.get("S1")
            assert.equal(recorded?.sessionId, "session-of-S1")
            assert.equal(recorded?.contextTokens, 31_000)
            assert.ok(!calls(dir)[0]!.args.includes("--resume"), "the first story starts cold")

            const decision = resolveInheritance({ storyId: "S1", mode: "fork" }, "claude", sessions, {})
            assert.ok(decision && "inherit" in decision)
            assert.equal((await run(dir, "S2", { sessions, inherit: decision.inherit })).success, true)

            const fork = calls(dir)[1]!
            const resume = fork.args.indexOf("--resume")
            assert.deepEqual(fork.args.slice(resume, resume + 3), ["--resume", "session-of-S1", "--fork-session"])
            assert.match(fork.prompt!, /^## You are a fork of story S1's session/)
            assert.match(fork.prompt!, /task of S2$/)
            assert.ok(fork.prompt!.includes(join(dir, "S2")), "it is told its own worktree")
        })
    })

    it("continues its own session without forking after a suspension", async () => {
        await withTempDir("session-continue-", async (dir) => {
            fakeClaude(dir, "own-session")
            const inherit: SessionInheritance = {
                mode: "continue", fromStoryId: "S2", parentCwd: join(dir, "S2"), contextTokens: 10, claudeSessionId: "own-session",
            }
            assert.equal((await run(dir, "S2", { inherit })).success, true)
            const { args, prompt } = calls(dir)[0]!
            assert.ok(args.includes("--resume") && !args.includes("--fork-session"))
            assert.match(prompt!, /^## You are resuming story S2/)
        })
    })

    it("starts cold in the same attempt when the session to resume is gone", async () => {
        await withTempDir("session-fallback-", async (dir) => {
            fakeClaude(dir, "fresh")
            const inherit: SessionInheritance = {
                mode: "fork", fromStoryId: "S1", parentCwd: "/wt/S1", contextTokens: 10, claudeSessionId: "gone",
            }
            const outcome = await run(dir, "S2", { inherit })
            assert.equal(outcome.success, true)
            assert.equal(outcome.attempts, 1, "a failed resume does not use up a retry")
            const [failed, cold] = calls(dir)
            assert.equal(failed!.failed, true)
            assert.ok(!cold!.args.includes("--resume"))
            assert.equal(cold!.prompt, "task of S2")
        })
    })
})

describe("a native story that inherits a session", () => {
    it("starts from the parent's context items, then its own task", async () => {
        await withTempDir("native-fork-", async (dir) => {
            const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
            const server = await recordingServer(bodies)
            try {
                const address = server.address()
                const port = typeof address === "object" && address ? address.port : 0
                const sessions = new SessionLedger()
                const run = async (id: string, inherit?: SessionInheritance) => {
                    const cwd = join(dir, id)
                    mkdirSync(cwd)
                    return await new OpenAIStoryAgent(
                        { id, prompt: `task of ${id}`, cwd, retries: 0, quietTimeoutMs: 5, maxTurns: 1, sessions, ...(inherit ? { inherit } : {}) },
                        { model: "fake-model", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", maxRoundsPerTurn: 1, perRoundTimeoutSecs: 5 },
                    ).run(captureEnv())
                }
                assert.equal((await run("S1")).success, true)
                const parent = sessions.get("S1")
                assert.equal(parent?.backend, "openai")
                assert.equal(parent?.contextTokens, 1200)
                // System prompt, task, and the parent's final answer.
                assert.equal(parent?.items?.length, 3)

                const decision = resolveInheritance({ storyId: "S1", mode: "fork" }, "openai", sessions, {})
                assert.ok(decision && "inherit" in decision)
                assert.equal((await run("S2", decision.inherit)).success, true)

                const text = (message: { content: unknown }) =>
                    typeof message.content === "string" ? message.content : JSON.stringify(message.content)
                const [first, forked] = bodies as [typeof bodies[number], typeof bodies[number]]
                // Same prefix as the parent's request, so the provider's prompt cache serves it.
                assert.deepEqual(forked.messages.slice(0, first.messages.length), first.messages)
                assert.match(text(forked.messages[first.messages.length]!), /story complete/)
                const last = text(forked.messages.at(-1)!)
                assert.match(last, /You are a fork of story S1's session/)
                assert.match(last, /task of S2/)
            } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()))
            }
        })
    })
})

describe("a native round that asks for several reads", () => {
    it("runs them together and returns each output to its own call, in the provider's order", async () => {
        await withTempDir("native-reads-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            writeFileSync(join(cwd, "a.txt"), "ALPHA")
            writeFileSync(join(cwd, "b.txt"), "BRAVO")
            const bodies: Array<{ messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> }> = []
            const toolRound = [
                { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
                    { index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
                    { index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
                ] }, finish_reason: null }] },
                { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
                { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
            ]
            const server = await recordingServer(bodies, (index) => (index === 0 ? toolRound : null))
            try {
                const address = server.address()
                const port = typeof address === "object" && address ? address.port : 0
                const outcome = await new OpenAIStoryAgent(
                    { id: "S1", prompt: "read both", cwd, retries: 0, quietTimeoutMs: 5, maxTurns: 1 },
                    { model: "fake-model", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", maxRoundsPerTurn: 3, perRoundTimeoutSecs: 5 },
                ).run(captureEnv())
                assert.equal(outcome.success, true, outcome.error ?? "")
                const outputs = bodies[1]!.messages.filter((message) => message.role === "tool")
                assert.deepEqual(outputs.map((message) => message.tool_call_id), ["call_a", "call_b"])
                assert.match(JSON.stringify(outputs[0]!.content), /ALPHA/)
                assert.match(JSON.stringify(outputs[1]!.content), /BRAVO/)
            } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()))
            }
        })
    })

    it("treats only tools that change nothing as safe to run together", () => {
        for (const name of ["read_file", "read_files", "grep", "glob", "list_files", "file_tree", "Read", "Grep"]) {
            assert.equal(isReadOnlyTool(name), true, name)
        }
        for (const name of ["bash", "write_file", "edit_file", "Write", "batch", "propose_replan"]) {
            assert.equal(isReadOnlyTool(name), false, name)
        }
    })
})

async function recordingServer(
    bodies: unknown[],
    scripted: (index: number) => unknown[] | null = () => null,
): Promise<Server> {
    const usage = { prompt_tokens: 1200, completion_tokens: 2, total_tokens: 1202 }
    const server = createServer((req, res) => {
        let body = ""
        req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
        req.on("end", () => {
            bodies.push(JSON.parse(body))
            const chunks = scripted(bodies.length - 1)
            if (streamRequested(body)) {
                res.writeHead(200, { "content-type": "text/event-stream" })
                for (const chunk of chunks ?? streamedCompletion("story complete", usage)) {
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                }
                res.end("data: [DONE]\n\n")
                return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({
                id: "c", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "story complete" }, finish_reason: "stop" }],
                usage,
            }))
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return server
}
