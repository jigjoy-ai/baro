import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { after, before, describe, it } from "node:test"

import {
    InputTokenDetails,
    ModelMessageItem,
    OutputTokenDetails,
    TokenUsage,
} from "@mozaik-ai/core"

import { knownMetric, unknownMetric } from "../../src/model-telemetry.js"
import { SurgeonOpenAI } from "../../src/participants/surgeon-openai.js"
import type { PrdSnapshot } from "../../src/participants/surgeon.js"
import {
    ModelInvocationMeasured,
    Replan,
    StoryResult,
    type ReplanStoryAdd,
} from "../../src/semantic-events.js"
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

    it("publishes one OpenAI TokenUsage measurement before its replan", async () => {
        const surgeon = new SurgeonOpenAI({
            snapshot,
            model: "baro-test-model",
            runId: "run-openai-surgeon",
        })
        stubRound(surgeon, {
            text: JSON.stringify({
                action: "skip",
                reason: "infeasible dependency",
                added: [],
                removed: ["S1"],
                modifiedDeps: [],
            }),
            usage: new TokenUsage(
                21,
                8,
                29,
                new InputTokenDetails(5),
                new OutputTokenDetails(3),
            ),
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(source("story-agent"), failure)
        await surgeon.idle()

        const measured = env.events.filter(ModelInvocationMeasured.is)
        const replans = env.events.filter(Replan.is)
        assert.equal(measured.length, 1)
        assert.equal(replans.length, 1)
        assert.ok(env.events.indexOf(measured[0]!) < env.events.indexOf(replans[0]!))

        const item = measured[0]!.data
        assert.equal(
            item.invocationId,
            "run-openai-surgeon:surgeon:S1:evaluation-1",
        )
        assert.equal(
            item.measurementId,
            "run-openai-surgeon:surgeon:S1:evaluation-1:runner",
        )
        assert.equal(item.runId, "run-openai-surgeon")
        assert.equal(item.phase, "surgeon")
        assert.equal(item.storyId, "S1")
        assert.equal(item.turn, 1)
        assert.equal(item.round, 1)
        assert.equal(item.backend, "openai")
        assert.equal(item.provider, null)
        assert.equal(item.evidence.providerRequestId, null)
        assert.equal(item.status, "succeeded")
        assert.deepEqual(
            item.tokens.inputTotal,
            knownMetric(21, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.cachedInput,
            knownMetric(5, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.outputTotal,
            knownMetric(8, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.reasoningOutput,
            knownMetric(3, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.total,
            knownMetric(29, "provider_response"),
        )
        assert.deepEqual(
            item.cost.providerUsd,
            unknownMetric("pending_gateway_meter"),
        )
        assert.deepEqual(
            item.cost.customerUsd,
            unknownMetric("pending_gateway_meter"),
        )
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

        const measured = env.events.filter(ModelInvocationMeasured.is)
        assert.equal(measured.length, 1)
        assert.equal(measured[0]!.data.status, "failed")
        assert.deepEqual(
            measured[0]!.data.tokens.inputTotal,
            unknownMetric("not_reported"),
        )
        assert.ok(env.events.indexOf(measured[0]!) < env.events.indexOf(replans[0]!))
    })

    it("parses structured Replan JSON from OpenAI assistant text", async () => {
        const added: ReplanStoryAdd = {
            id: "S1a",
            priority: 7,
            title: "Prepare failing path",
            description: "Add the prerequisite before retrying S1.",
            dependsOn: [],
            acceptance: ["The retry has setup in place."],
            tests: ["npm test"],
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

    it("falls back to a deterministic Replan when OpenAI returns malformed text", async () => {
        responseMode = "json"
        assistantText = "no replan json available"
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
        assert.match(replans[0]!.data.reason, /openai-llm fallback after error: no JSON object found/)

        const measured = env.events.filter(ModelInvocationMeasured.is)
        assert.equal(measured.length, 1)
        assert.equal(measured[0]!.data.status, "succeeded")
        assert.deepEqual(
            measured[0]!.data.tokens.total,
            knownMetric(2, "provider_response"),
        )
    })

    it("reports an OpenAI timeout once without invented zeros", async () => {
        const surgeon = new SurgeonOpenAI({
            snapshot,
            model: "baro-test-model",
        })
        Object.defineProperty(surgeon, "runRound", {
            value: async () => {
                throw Object.assign(new Error("request timed out"), {
                    code: "ETIMEDOUT",
                })
            },
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(source("story-agent"), failure)
        await surgeon.idle()

        const measured = env.events.filter(ModelInvocationMeasured.is)
        const replans = env.events.filter(Replan.is)
        assert.equal(measured.length, 1)
        assert.equal(measured[0]!.data.status, "timed_out")
        assert.deepEqual(
            measured[0]!.data.tokens.inputTotal,
            unknownMetric("timed_out"),
        )
        assert.deepEqual(
            measured[0]!.data.tokens.total,
            unknownMetric("timed_out"),
        )
        assert.equal(replans.length, 1)
        assert.ok(env.events.indexOf(measured[0]!) < env.events.indexOf(replans[0]!))
    })
})

function stubRound(
    surgeon: SurgeonOpenAI,
    response: { text: string; usage: TokenUsage | undefined },
): void {
    Object.defineProperty(surgeon, "runRound", {
        value: async () => ({
            items: [ModelMessageItem.rehydrate({ text: response.text })],
            usage: response.usage,
        }),
    })
}
