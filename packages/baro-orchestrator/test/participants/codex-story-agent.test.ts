import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { describe, it } from "node:test"

import { CodexStoryAgent } from "../../src/participants/codex-story-agent.js"
import { StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("CodexStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Codex backend", async () => {
        await withTempDir("codex-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                join(binDir, "codex"),
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "codex-thread" }))
process.exit(0)
`,
            )
            chmodSync(join(binDir, "codex"), 0o755)

            await withFakePath(binDir, async () => {
                const env = captureEnv()
                const agent = new CodexStoryAgent({
                    id: "story-codex",
                    prompt: "finish the story",
                    cwd,
                    retries: 0,
                    timeoutSecs: 5,
                    skipGitRepoCheck: true,
                })

                const outcome = await agent.run(env)
                const event = env.events.find(StoryResult.is)

                assert.equal(outcome.success, true)
                assert.equal(outcome.storyId, "story-codex")
                assert.equal(outcome.attempts, 1)
                assert.equal(outcome.finalSummary?.threadId, "codex-thread")
                assert.ok(event)
                assert.equal(event.data.storyId, "story-codex")
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
