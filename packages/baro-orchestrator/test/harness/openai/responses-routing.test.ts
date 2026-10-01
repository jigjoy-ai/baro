import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"

import {
    GenericOpenAIModel,
    runInferenceRound,
} from "../../../src/harness/openai/runtime.js"
import {
    ModelContext,
    ModelMessageItem,
    UserMessageItem,
} from "../../../src/runtime/mozaik.js"

// A stand-in for the baro gateway: it serves both OpenAI surfaces and records
// which one a model was sent to.
describe("OpenAI-native models use the Responses API on a custom endpoint", () => {
    let server: Server
    let baseURL: string
    const hits: { path: string; auth: string | undefined; model: unknown }[] = []

    before(async () => {
        server = createServer((req, res) => {
            let raw = ""
            req.on("data", (chunk) => (raw += chunk))
            req.on("end", () => {
                const body = JSON.parse(raw || "{}") as { model?: unknown; stream?: boolean }
                hits.push({ path: req.url ?? "", auth: req.headers.authorization, model: body.model })
                res.setHeader("content-type", "application/json")
                if (req.url === "/v1/responses") {
                    res.end(JSON.stringify({
                        id: "resp_1",
                        object: "response",
                        status: "completed",
                        model: body.model,
                        output: [{
                            type: "message",
                            id: "msg_1",
                            role: "assistant",
                            status: "completed",
                            content: [{ type: "output_text", text: "from responses", annotations: [] }],
                        }],
                        usage: {
                            input_tokens: 3,
                            input_tokens_details: { cached_tokens: 0 },
                            output_tokens: 2,
                            output_tokens_details: { reasoning_tokens: 0 },
                            total_tokens: 5,
                        },
                    }))
                    return
                }
                if (body.stream) {
                    res.setHeader("content-type", "text/event-stream")
                    res.write(`data: ${JSON.stringify({ id: "chat_1", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "from chat" } }] })}\n\n`)
                    res.write(`data: ${JSON.stringify({ id: "chat_1", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
                    res.end("data: [DONE]\n\n")
                    return
                }
                res.end(JSON.stringify({
                    id: "chat_1",
                    object: "chat.completion",
                    model: body.model,
                    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "from chat" } }],
                    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
                }))
            })
        })
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
        baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    })
    after(() => new Promise<void>((resolve) => server.close(() => resolve())))

    const ask = async (name: string): Promise<string> => {
        const model = new GenericOpenAIModel(name, { baseURL, apiKey: "gateway-key" })
        const context = ModelContext.create("routing").addContextItem(UserMessageItem.create("hello"))
        const round = await runInferenceRound(context, model)
        const message = round.items.find((item) => item instanceof ModelMessageItem) as ModelMessageItem
        return message.toJSON().content[0].text as string
    }

    it("sends gpt-* to /v1/responses with the connection's own key", async () => {
        hits.length = 0
        assert.equal(await ask("gpt-6.1-sol"), "from responses")
        assert.deepEqual(hits, [{ path: "/v1/responses", auth: "Bearer gateway-key", model: "gpt-6.1-sol" }])
    })

    it("keeps every other model on chat completions", async () => {
        hits.length = 0
        assert.equal(await ask("deepseek-flash"), "from chat")
        assert.equal(hits[0]?.path, "/v1/chat/completions")
    })

    it("BARO_OPENAI_CHAT_ONLY=1 keeps gpt-* on chat for endpoints without a Responses API", async () => {
        hits.length = 0
        process.env.BARO_OPENAI_CHAT_ONLY = "1"
        try {
            assert.equal(await ask("gpt-6.1-sol"), "from chat")
            assert.equal(hits[0]?.path, "/v1/chat/completions")
        } finally {
            delete process.env.BARO_OPENAI_CHAT_ONLY
        }
    })
})
