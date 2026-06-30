import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

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
})
