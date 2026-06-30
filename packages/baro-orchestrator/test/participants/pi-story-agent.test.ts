import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { describe, it } from "node:test"

import { PiStoryAgent } from "../../src/participants/pi-story-agent.js"
import { StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("PiStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Pi backend", async () => {
        await withTempDir("pi-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                join(binDir, "pi"),
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
            chmodSync(join(binDir, "pi"), 0o755)

            await withFakePath(binDir, async () => {
                const env = captureEnv()
                const agent = new PiStoryAgent({
                    id: "story-pi",
                    prompt: "finish the story",
                    cwd,
                    retries: 0,
                    timeoutSecs: 5,
                })

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
            })
        })
    })
})

type FakePathGlobal = typeof globalThis & {
    __baroFakePathTail?: Promise<void>
}

async function withFakePath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
    const g = globalThis as FakePathGlobal
    const previous = g.__baroFakePathTail ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
        release = resolve
    })
    g.__baroFakePathTail = previous.then(() => current)
    await previous

    const oldPath = process.env.PATH
    process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`
    try {
        return await fn()
    } finally {
        process.env.PATH = oldPath
        release()
        if (g.__baroFakePathTail === current) {
            g.__baroFakePathTail = undefined
        }
    }
}
