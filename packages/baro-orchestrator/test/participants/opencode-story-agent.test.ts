import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { describe, it } from "node:test"

import { OpenCodeStoryAgent } from "../../src/participants/opencode-story-agent.js"
import { StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("OpenCodeStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake OpenCode backend", async () => {
        await withTempDir("opencode-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                join(binDir, "opencode"),
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "step_start", sessionID: "opencode-session", timestamp: 1 }))
console.log(JSON.stringify({
  type: "tool_use",
  sessionID: "opencode-session",
  timestamp: 2,
  part: {
    type: "tool",
    tool: "write",
    callID: "tool-1",
    state: { status: "completed", input: { file: "done.txt" }, output: "ok" }
  }
}))
console.log(JSON.stringify({ type: "step_finish", sessionID: "opencode-session", timestamp: 3 }))
process.exit(0)
`,
            )
            chmodSync(join(binDir, "opencode"), 0o755)

            await withFakePath(binDir, async () => {
                const env = captureEnv()
                const agent = new OpenCodeStoryAgent({
                    id: "story-opencode",
                    prompt: "finish the story",
                    cwd,
                    retries: 0,
                    timeoutSecs: 15,
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
