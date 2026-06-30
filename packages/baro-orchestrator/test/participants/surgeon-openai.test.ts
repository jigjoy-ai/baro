import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { after, before, describe, it } from "node:test"

import { Replan, StoryResult, type ReplanStoryAdd } from "../../src/semantic-events.js"
import { SurgeonOpenAI } from "../../src/participants/surgeon-openai.js"
import type { PrdSnapshot } from "../../src/participants/surgeon.js"
import { joinWithCapture, source } from "./helpers.js"

const snapshot = (): PrdSnapshot => ({
    project: "participant-tests",
    description: "Exercise surgeon provider behavior.",
    stories: [
        {
            id: "S1",
            title: "Failing story",
            description: "This story fails terminally.",
            dependsOn: [],
            passes: false,
            model: "sonnet",
        },
        {
            id: "S2",
            title: "Dependent story",
            description: "This story depends on S1.",
            dependsOn: ["S1"],
            passes: false,
            model: "haiku",
        },
    ],
})

const failure = StoryResult.create({
    storyId: "S1",
    success: false,
    attempts: 3,
    durationSecs: 12,
    error: "implementation failed",
})

let server: Server
let baseUrl = ""
let responseMode: "error" | "json" = "json"
let assistantText = ""
const originalApiKey = process.env.OPENAI_API_KEY
const originalBaseUrl = process.env.OPENAI_BASE_URL

describe("SurgeonOpenAI", () => {
    before(async () => {
        server = createServer((req, res) => {
            req.resume()
            if (responseMode === "error") {
                res.writeHead(500, { "content-type": "application/json" })
                res.end(JSON.stringify({ error: { message: "fake openai failure" } }))
                return
            }

            assert.equal(req.url, "/chat/completions")
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
                JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: assistantText },
                            finish_reason: "stop",
                        },
                    ],
                    usage: {
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        total_tokens: 2,
                    },
                }),
            )
        })
        server.listen(0, "127.0.0.1")
        await once(server, "listening")
        const address = server.address()
        assert(address && typeof address === "object")
        baseUrl = `http://127.0.0.1:${address.port}`
        process.env.OPENAI_API_KEY = "test-key"
        process.env.OPENAI_BASE_URL = baseUrl
    })

    after(async () => {
        if (originalApiKey === undefined) {
            delete process.env.OPENAI_API_KEY
        } else {
            process.env.OPENAI_API_KEY = originalApiKey
        }
        if (originalBaseUrl === undefined) {
            delete process.env.OPENAI_BASE_URL
        } else {
            process.env.OPENAI_BASE_URL = originalBaseUrl
        }
        server.close()
        await once(server, "close")
    })

    it("falls back to a deterministic Replan when OpenAI IO fails", async () => {
        responseMode = "error"
        const surgeon = new SurgeonOpenAI({
            snapshot,
            model: "baro-test-model",
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(source("story-agent"), failure)
        await surgeon.idle()

        const replans = env.events.filter(Replan.is)
        assert.equal(replans.length, 1)
        assert.deepEqual(replans[0]!.data.addedStories, [])
        assert.deepEqual(replans[0]!.data.removedStoryIds, ["S1"])
        assert.deepEqual(replans[0]!.data.modifiedDeps, {})
        assert.match(replans[0]!.data.reason, /deterministic skip: S1 exhausted 3 attempts/)
        assert.match(replans[0]!.data.reason, /openai-llm fallback after error:/)
    })

    it("parses structured Replan JSON from OpenAI assistant text", async () => {
        const added: ReplanStoryAdd = {
            id: "S1a",
            priority: 7,
            title: "Prepare failing path",
            description: "Add the prerequisite before retrying S1.",
            dependsOn: [],
            acceptance: ["The retry has setup in place."],
            model: "haiku",
        }
        const verdict = {
            action: "prereq",
            reason: "missing setup",
            added: [added],
            removed: ["S1"],
            modifiedDeps: [{ id: "S2", newDependsOn: ["S1a"] }],
        }
        responseMode = "json"
        assistantText = `analysis\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``
        const surgeon = new SurgeonOpenAI({
            snapshot,
            model: "baro-test-model",
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(source("story-agent"), failure)
        await surgeon.idle()

        const replans = env.events.filter(Replan.is)
        assert.equal(replans.length, 1)
        assert.equal(replans[0]!.data.reason, "prereq: missing setup")
        assert.deepEqual(replans[0]!.data.addedStories, [added])
        assert.deepEqual(replans[0]!.data.removedStoryIds, ["S1"])
        assert.deepEqual(replans[0]!.data.modifiedDeps, { S2: ["S1a"] })
    })
})
