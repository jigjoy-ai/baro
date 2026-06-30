import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { OpenAIStoryAgent } from "../../src/participants/openai-story-agent.js"
import { StoryResult } from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("OpenAIStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake OpenAI-compatible backend", async () => {
        await withTempDir("openai-story-agent-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const server = await startFakeOpenAIServer()

            try {
                const address = server.address()
                assert.notEqual(address, null)
                assert.notEqual(typeof address, "string")
                const port = typeof address === "object" ? address.port : 0
                const env = captureEnv()
                const agent = new OpenAIStoryAgent(
                    {
                        id: "story-openai",
                        prompt: "finish the story",
                        cwd,
                        retries: 0,
                        quietTimeoutMs: 5,
                        maxTurns: 1,
                    },
                    {
                        model: "fake-model",
                        baseUrl: `http://127.0.0.1:${port}/v1`,
                        apiKey: "test-key",
                        maxRoundsPerTurn: 1,
                        perRoundTimeoutSecs: 1,
                    },
                )

                const outcome = await agent.run(env)
                const event = env.events.find(StoryResult.is)

                assert.equal(outcome.success, true)
                assert.equal(outcome.storyId, "story-openai")
                assert.equal(outcome.attempts, 1)
                assert.ok(event)
                assert.equal(event.data.storyId, "story-openai")
                assert.equal(event.data.success, true)
                assert.equal(event.data.attempts, 1)
                assert.equal(event.data.error, null)
            } finally {
                await closeServer(server)
            }
        })
    })

    it("emits a failed terminal StoryResult after exhausting OpenAI retries", async () => {
        await withTempDir("openai-story-agent-retry-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const env = captureEnv()
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-openai-retry",
                    prompt: "finish the story",
                    cwd,
                    retries: 1,
                    retryDelayMs: 0,
                    quietTimeoutMs: 5,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 0,
                    perRoundTimeoutSecs: 1,
                },
            )

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-openai-retry")
            assert.equal(outcome.attempts, 2)
            assert.equal(outcome.error, "attempt did not reach a terminal state")
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-openai-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, "attempt did not reach a terminal state")
        })
    })
})

async function startFakeOpenAIServer(): Promise<Server> {
    const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
            JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: "story complete",
                        },
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 2,
                    total_tokens: 3,
                },
            }),
        )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return server
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
}
