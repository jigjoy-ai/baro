import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Participant } from "@mozaik-ai/core"

import { PiStoryAgent } from "../../src/participants/pi-story-agent.js"
import { StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("PiStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Pi backend", async () => {
        await withTempDir("pi-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const piBin = join(binDir, "pi")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                piBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "session", id: "pi-session" }))
console.log(JSON.stringify({ type: "agent_start" }))
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "write" }))
console.log(JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "write",
  isError: false,
  result: { content: [{ type: "text", text: "ok" }] }
}))
console.log(JSON.stringify({ type: "agent_end", willRetry: false }))
process.exit(0)
`,
            )
            chmodSync(piBin, 0o755)

            const env = captureEnv()
            const agent = new PiStoryAgent({
                id: "story-pi",
                prompt: "finish the story",
                cwd,
                piBin,
                retries: 0,
                timeoutSecs: 5,
            })
            const terminalSources: Participant[] = []
            agent.setTerminalSourceRegistrar((source) => terminalSources.push(source))

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, true)
            assert.equal(outcome.storyId, "story-pi")
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.finalSummary?.sessionId, "pi-session")
            assert.equal(outcome.finalSummary?.sawAgentEnd, true)
            assert.equal(outcome.finalSummary?.toolCallCount, 1)
            assert.equal(outcome.finalSummary?.toolSuccessCount, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-pi")
            assert.equal(event.data.success, true)
            assert.equal(event.data.attempts, 1)
            assert.equal(event.data.error, null)
            assert.equal(terminalSources.length, 1)
            assert.equal(terminalSources[0]?.agentId, "story-pi")
        })
    })

    it("emits a failed terminal StoryResult after exhausting Pi retries", async () => {
        await withTempDir("pi-story-agent-retry-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const piBin = join(binDir, "pi")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                piBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "session", id: "pi-session" }))
console.log(JSON.stringify({ type: "agent_start" }))
console.log(JSON.stringify({ type: "agent_end", willRetry: false }))
process.exit(0)
`,
            )
            chmodSync(piBin, 0o755)

            const env = captureEnv()
            const agent = new PiStoryAgent({
                id: "story-pi-retry",
                prompt: "finish the story",
                cwd,
                piBin,
                retries: 1,
                retryDelayMs: 0,
                timeoutSecs: 5,
            })

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-pi-retry")
            assert.equal(outcome.attempts, 2)
            assert.match(outcome.error ?? "", /pi exited 0 but invoked no tools/)
            assert.equal(outcome.finalSummary?.sawAgentEnd, true)
            assert.equal(outcome.finalSummary?.toolCallCount, 0)
            assert.equal(outcome.finalSummary?.toolSuccessCount, 0)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-pi-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, outcome.error)
        })
    })
})
