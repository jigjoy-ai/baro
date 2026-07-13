import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Participant } from "@mozaik-ai/core"

import { StoryResult } from "../../src/semantic-events.js"
import { StoryAgent } from "../../src/participants/story-agent.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("StoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Claude backend", async () => {
        await withTempDir("story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }))
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "claude-session",
    is_error: false,
    result: "story complete"
  }))
}, 20)
setTimeout(() => process.exit(0), 40)
process.stdin.resume()
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 0,
                timeoutSecs: 5,
                quietTimeoutMs: 5,
            })
            const terminalSources: Participant[] = []
            agent.setTerminalSourceRegistrar((source) => terminalSources.push(source))

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, true)
            assert.equal(outcome.storyId, "story-claude")
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.finalSummary?.lastResult?.resultText, "story complete")
            assert.ok(event)
            assert.equal(event.data.storyId, "story-claude")
            assert.equal(event.data.success, true)
            assert.equal(event.data.attempts, 1)
            assert.equal(event.data.error, null)
            assert.equal(terminalSources.length, 1)
            assert.equal(terminalSources[0]?.agentId, "story-claude")
        })
    })

    it("emits a failed terminal StoryResult after exhausting Claude retries", async () => {
        await withTempDir("story-agent-retry-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }))
console.log(JSON.stringify({
  type: "result",
  subtype: "error",
  session_id: "claude-session",
  is_error: true,
  result: "backend failed"
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-retry",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 1,
                retryDelayMs: 0,
                timeoutSecs: 5,
                quietTimeoutMs: 5,
            })

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-claude-retry")
            assert.equal(outcome.attempts, 2)
            assert.equal(outcome.error, "claude reported isError on result:error")
            assert.equal(outcome.finalSummary?.lastResult?.isError, true)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-claude-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, "claude reported isError on result:error")
        })
    })

    it("preserves compact provider-capacity diagnostics from an error result", async () => {
        await withTempDir("story-agent-capacity-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session",
  is_error: true,
  result: "  You've hit your session limit   ·   resets 3:30pm  "
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-capacity",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 30,
                quietTimeoutMs: 5,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)
            const expected =
                "claude provider capacity unavailable (result:success): You've hit your session limit · resets 3:30pm"

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "provider_capacity",
                code: "session_limit",
            })
            assert.equal(outcome.error, expected)
            assert.ok(event)
            assert.equal(event.data.error, expected)
            assert.equal(event.data.attempts, 1)
            assert.deepEqual(event.data.failure, {
                kind: "provider_capacity",
                code: "session_limit",
            })
        })
    })

    it("uses a rejected Claude limit frame when terminal text is generic", async () => {
        await withTempDir("story-agent-limit-frame-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "rate_limit_event",
  session_id: "claude-limit-session",
  rate_limit_info: {
    status: "rejected",
    rateLimitType: "five_hour",
    overageDisabledReason: "out_of_credits"
  }
}))
console.log(JSON.stringify({
  type: "result",
  subtype: "error",
  session_id: "claude-limit-session",
  is_error: true,
  result: "request could not be completed"
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-limit-frame",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 30,
                quietTimeoutMs: 5,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            agent.leave(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.failure?.kind, "provider_capacity")
            assert.equal(outcome.failure?.code, "session_limit")
            assert.equal(event?.data.failure?.code, "session_limit")
        })
    })

    it("ignores an allowed Claude limit frame with disabled overage", async () => {
        await withTempDir("story-agent-allowed-frame-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "rate_limit_event",
  session_id: "claude-allowed-session",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits"
  }
}))
console.log(JSON.stringify({
  type: "result",
  subtype: "error",
  session_id: "claude-allowed-session",
  is_error: true,
  result: "ordinary execution failure"
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-allowed-frame",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 0,
                timeoutSecs: 30,
                quietTimeoutMs: 5,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            agent.leave(env)

            assert.equal(outcome.failure, undefined)
            assert.equal(
                outcome.error,
                "claude reported isError on result:error",
            )
        })
    })

    it("bounds verbose quota diagnostics before publishing them", async () => {
        await withTempDir("story-agent-quota-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "Error 429 rate_limit: quota exceeded: " + "diagnostic ".repeat(100)
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-quota",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 0,
                timeoutSecs: 5,
                quietTimeoutMs: 5,
            })

            const outcome = await agent.run(env)
            const prefix =
                "claude provider capacity unavailable (result:error_during_execution): "

            assert.ok(
                outcome.error?.startsWith(
                    `${prefix}Error 429 rate_limit: quota exceeded:`,
                ),
            )
            assert.ok(outcome.error?.endsWith("…"))
            assert.equal(outcome.error?.length, prefix.length + 240)
        })
    })
})
