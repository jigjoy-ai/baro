import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { OpenCodeStoryAgent } from "../../src/participants/opencode-story-agent.js"
import { StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("OpenCodeStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake OpenCode backend", async () => {
        await withTempDir("opencode-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const opencodeBin = join(binDir, "opencode")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                opencodeBin,
                `#!/bin/sh
printf '%s\n' \
  '{"type":"step_start","sessionID":"opencode-session","timestamp":1}' \
  '{"type":"tool_use","sessionID":"opencode-session","timestamp":2,"part":{"type":"tool","tool":"write","callID":"tool-1","state":{"status":"completed","input":{"file":"done.txt"},"output":"ok"}}}' \
  '{"type":"step_finish","sessionID":"opencode-session","timestamp":3}'
`,
            )
            chmodSync(opencodeBin, 0o755)

            const env = captureEnv()
            const agent = new OpenCodeStoryAgent({
                id: "story-opencode",
                prompt: "finish the story",
                cwd,
                opencodeBin,
                retries: 0,
                // Corporate endpoint scanners can delay first execution of a
                // freshly-created temp binary; this is not the behavior under test.
                timeoutSecs: 60,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, true)
            assert.equal(outcome.storyId, "story-opencode")
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.finalSummary?.sessionId, "opencode-session")
            assert.equal(outcome.finalSummary?.sawStepFinish, true)
            assert.equal(outcome.finalSummary?.toolCallCount, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-opencode")
            assert.equal(event.data.success, true)
            assert.equal(event.data.attempts, 1)
            assert.equal(event.data.error, null)
        })
    })

    it("emits a failed terminal StoryResult after exhausting OpenCode retries", async () => {
        await withTempDir("opencode-story-agent-retry-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const opencodeBin = join(binDir, "opencode")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                opencodeBin,
                `#!/bin/sh
printf '%s\n' \
  '{"type":"step_start","sessionID":"opencode-session","timestamp":1}' \
  '{"type":"step_finish","sessionID":"opencode-session","timestamp":2}'
`,
            )
            chmodSync(opencodeBin, 0o755)

            const env = captureEnv()
            const agent = new OpenCodeStoryAgent({
                id: "story-opencode-retry",
                prompt: "finish the story",
                cwd,
                opencodeBin,
                retries: 1,
                retryDelayMs: 0,
                timeoutSecs: 30,
            })

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-opencode-retry")
            assert.equal(outcome.attempts, 2)
            assert.match(outcome.error ?? "", /opencode exited 0 but invoked no tools/)
            assert.equal(outcome.finalSummary?.sawStepFinish, true)
            assert.equal(outcome.finalSummary?.toolCallCount, 0)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-opencode-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, outcome.error)
        })
    })
})
