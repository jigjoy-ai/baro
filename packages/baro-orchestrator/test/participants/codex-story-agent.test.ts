import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Participant } from "@mozaik-ai/core"

import { CodexStoryAgent } from "../../src/participants/codex-story-agent.js"
import { StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("CodexStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Codex backend", async () => {
        await withTempDir("codex-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "codex-thread" }))
process.exit(0)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 0,
                timeoutSecs: 5,
                skipGitRepoCheck: true,
            })
            const terminalSources: Participant[] = []
            agent.setTerminalSourceRegistrar((source) => terminalSources.push(source))

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
            assert.equal(terminalSources.length, 1)
            assert.equal(terminalSources[0]?.agentId, "story-codex")
        })
    })

    it("emits a failed terminal StoryResult after exhausting Codex retries", async () => {
        await withTempDir("codex-story-agent-retry-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
process.exit(1)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-retry",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 1,
                retryDelayMs: 0,
                timeoutSecs: 5,
                skipGitRepoCheck: true,
            })

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-codex-retry")
            assert.equal(outcome.attempts, 2)
            assert.equal(outcome.error, "non-zero exit 1")
            assert.deepEqual(outcome.failure, {
                kind: "execution",
                code: "model_error",
            })
            assert.equal(outcome.finalSummary?.exitCode, 1)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-codex-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, "non-zero exit 1")
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("returns structured provider capacity to Board without spending local retries", async () => {
        await withTempDir("codex-story-agent-capacity-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "capacity-thread" }))
console.log(JSON.stringify({
  type: "error",
  error: { status: 429, code: "rate_limit_exceeded", message: "rate limited" }
}))
process.exit(1)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-capacity",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 5,
                skipGitRepoCheck: true,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "provider_capacity",
                code: "rate_limited",
            })
            assert.ok(event)
            assert.equal(event.data.attempts, 1)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("settles a missing Codex binary as infrastructure after one attempt", async () => {
        await withTempDir("codex-story-agent-spawn-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-spawn",
                prompt: "finish the story",
                cwd,
                codexBin: join(dir, "missing-codex"),
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 2,
                skipGitRepoCheck: true,
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

    it("returns an attempt timeout to Board without retrying locally", async () => {
        await withTempDir("codex-story-agent-timeout-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
setInterval(() => {}, 1_000)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-timeout",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 0.05,
                skipGitRepoCheck: true,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.match(outcome.error ?? "", /attempt 1 timeout/)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "command_timeout",
            })
            assert.ok(event)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })
})
