import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { describe, it } from "node:test"

import { StoryResult } from "../../src/semantic-events.js"
import { StoryAgent } from "../../src/participants/story-agent.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("StoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Claude backend", async () => {
        await withTempDir("story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                join(binDir, "claude"),
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
            chmodSync(join(binDir, "claude"), 0o755)

            await withFakePath(binDir, async () => {
                const env = captureEnv()
                const agent = new StoryAgent({
                    id: "story-claude",
                    prompt: "finish the story",
                    cwd,
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
