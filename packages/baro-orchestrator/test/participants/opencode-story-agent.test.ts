import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Participant } from "@mozaik-ai/core"

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
            const terminalSources: Participant[] = []
            agent.setTerminalSourceRegistrar((source) => terminalSources.push(source))

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
            assert.equal(terminalSources.length, 1)
            assert.equal(terminalSources[0]?.agentId, "story-opencode")
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
            assert.deepEqual(outcome.failure, {
                kind: "execution",
                code: "no_work_product",
            })
            assert.equal(outcome.finalSummary?.sawStepFinish, true)
            assert.equal(outcome.finalSummary?.toolCallCount, 0)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-opencode-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, outcome.error)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("returns structured transport failure to Board without spending local retries", async () => {
        await withTempDir("opencode-story-agent-transport-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const opencodeBin = join(binDir, "opencode")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                opencodeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "error",
  error: { code: "ECONNRESET", message: "socket reset by peer" }
}))
process.exit(1)
`,
            )
            chmodSync(opencodeBin, 0o755)

            const env = captureEnv()
            const agent = new OpenCodeStoryAgent({
                id: "story-opencode-transport",
                prompt: "finish the story",
                cwd,
                opencodeBin,
                retries: 2,
                retryDelayMs: 0,
                // Corporate endpoint scanners can delay fresh temp binaries.
                timeoutSecs: 60,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "transport",
                code: "connection_reset",
            })
            assert.ok(event)
            assert.equal(event.data.attempts, 1)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("settles a missing OpenCode binary as infrastructure after one attempt", async () => {
        await withTempDir("opencode-story-agent-spawn-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const env = captureEnv()
            const agent = new OpenCodeStoryAgent({
                id: "story-opencode-spawn",
                prompt: "finish the story",
                cwd,
                opencodeBin: join(dir, "missing-opencode"),
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 2,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.match(outcome.error ?? "", /ENOENT/)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "process_spawn_failed",
            })
            assert.ok(event)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })
})
