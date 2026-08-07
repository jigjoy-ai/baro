import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { after, describe, it } from "node:test"

import OpenAI from "openai"

import {
    streamChatRound,
    type ChatCompletionChunk,
    type ChatStreamClient,
} from "../../../src/harness/openai/chat-stream.js"
import { FunctionCallItem, ModelMessageItem } from "../../../src/runtime/mozaik.js"

/** A provider that streams exactly these chunks, recording what it was sent. */
function endpoint(chunks: ChatCompletionChunk[]): {
    client: ChatStreamClient
    sent: Record<string, unknown>[]
    options: Record<string, unknown>[]
} {
    const sent: Record<string, unknown>[] = []
    const options: Record<string, unknown>[] = []
    const client: ChatStreamClient = {
        chat: {
            completions: {
                create: async (body, requestOptions) => {
                    sent.push(body)
                    options.push(requestOptions ?? {})
                    return (async function* () {
                        for (const chunk of chunks) yield chunk
                    })()
                },
            },
        },
    }
    return { client, sent, options }
}

const text = (content: string): ChatCompletionChunk => ({
    choices: [{ delta: { content } }],
})

describe("a streamed round is assembled into what a round returns", () => {
    it("asks for usage, without which a streamed round reports no tokens", async () => {
        const { client, sent } = endpoint([text("hi")])
        await streamChatRound(client, { model: "glm-5.2", messages: [] })
        assert.equal(sent[0]!.stream, true)
        assert.deepEqual(sent[0]!.stream_options, { include_usage: true })
        assert.equal(sent[0]!.model, "glm-5.2", "the caller's body is preserved")
    })

    it("joins the message the model wrote across chunks", async () => {
        const { client } = endpoint([
            text("The decision "),
            text("is to add "),
            text("an audit table."),
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.items.length, 1)
        assert.equal(
            (round.items[0] as ModelMessageItem).toJSON().content[0].text,
            "The decision is to add an audit table.",
        )
    })

    it("rebuilds a tool call whose arguments arrive in fragments", async () => {
        const { client } = endpoint([
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                { index: 0, id: "call_1", function: { name: "read_files" } },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ths":["a.ts"' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "]}" } }] } }] },
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.items.length, 1)
        const call = round.items[0] as FunctionCallItem
        assert.equal(call.type, "function_call")
        assert.equal(call.name, "read_files")
        assert.equal(call.callId, "call_1")
        assert.deepEqual(JSON.parse(call.args), { paths: ["a.ts"] })
    })

    it("keeps parallel calls apart, in the order the provider indexed them", async () => {
        const { client } = endpoint([
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                { index: 1, id: "b", function: { name: "grep", arguments: "{}" } },
                                { index: 0, id: "a", function: { name: "read_file", arguments: "{}" } },
                            ],
                        },
                    },
                ],
            },
        ])
        const round = await streamChatRound(client, {})
        assert.deepEqual(
            round.items.map((item) => (item as FunctionCallItem).name),
            ["read_file", "grep"],
        )
    })

    it("reads the usage frame, cached tokens and all", async () => {
        const { client } = endpoint([
            text("done"),
            {
                choices: [],
                usage: {
                    prompt_tokens: 120_000,
                    completion_tokens: 400,
                    total_tokens: 120_400,
                    prompt_tokens_details: { cached_tokens: 96_000 },
                    completion_tokens_details: { reasoning_tokens: 250 },
                },
            },
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.usage?.inputTokens, 120_000)
        assert.equal(round.usage?.outputTokens, 400)
        assert.equal(round.usage?.inputTokenDetails?.cached_tokens, 96_000)
        assert.equal(round.usage?.outputTokenDetails?.reasoning_tokens, 250)
    })

    // A missing number and a free round are not the same fact: reporting zero
    // would quietly write "this cost nothing" into every cost figure.
    it("reports no usage rather than zero usage when none was streamed", async () => {
        const { client } = endpoint([text("done")])
        const round = await streamChatRound(client, {})
        assert.equal(round.usage, undefined)
    })

    // A live Architect answered with 36k tokens over eleven minutes and the
    // reply was unparseable when it landed. Nothing said it was too long: the
    // host could only report "not valid JSON", which sends the model back to
    // write the same document again, at the same length.
    it("reports a reply the provider cut off at the ceiling", async () => {
        const { client } = endpoint([
            text("## ADR-001"),
            { choices: [{ finish_reason: "length", delta: {} }] },
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.truncated, true)
    })

    it("does not call a finished reply truncated", async () => {
        const { client } = endpoint([
            text("done"),
            { choices: [{ finish_reason: "stop", delta: {} }] },
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.truncated, false)
    })

    it("proves it is alive on every chunk", async () => {
        const { client } = endpoint([text("a"), text("b"), text("c")])
        let beats = 0
        await streamChatRound(client, {}, { onActivity: () => (beats += 1) })
        assert.equal(beats, 3, "silence must be measurable while the model writes")
    })

    it("passes the caller's transport options through untouched", async () => {
        const { client, options } = endpoint([text("hi")])
        const dispatcher = { marker: true }
        await streamChatRound(client, {}, {
            requestOptions: { fetchOptions: { dispatcher } },
        })
        assert.deepEqual(
            (options[0]!.fetchOptions as { dispatcher: unknown }).dispatcher,
            dispatcher,
        )
    })
})

/** A provider that speaks the wire format, not a stand-in for one. */
function sseEndpoint(frames: unknown[]): Promise<{ url: string; close: () => void }> {
    const server: Server = createServer((_request, response) => {
        response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
        })
        for (const frame of frames) {
            response.write(`data: ${JSON.stringify(frame)}\n\n`)
        }
        response.write("data: [DONE]\n\n")
        response.end()
    })
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            const port = typeof address === "object" && address ? address.port : 0
            resolve({
                url: `http://127.0.0.1:${port}/v1`,
                close: () => server.close(),
            })
        })
    })
}

const listening: Array<() => void> = []
after(() => {
    for (const close of listening) close()
})

// The assembler above is tested against a stand-in client. This one runs the
// whole path a live round runs: the provider SDK parsing server-sent events,
// and this module consuming what it yields.
describe("through the provider client, on the wire", () => {
    it("returns the message, the tool call and the usage a round is billed on", async () => {
        const endpoint = await sseEndpoint([
            { choices: [{ index: 0, delta: { role: "assistant", content: "reading " } }] },
            { choices: [{ index: 0, delta: { content: "the service" } }] },
            {
                choices: [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_9",
                                    type: "function",
                                    function: { name: "batch", arguments: '{"calls"' },
                                },
                            ],
                        },
                    },
                ],
            },
            {
                choices: [
                    {
                        index: 0,
                        delta: { tool_calls: [{ index: 0, function: { arguments: ":[]}" } }] },
                    },
                ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            {
                choices: [],
                usage: {
                    prompt_tokens: 42,
                    completion_tokens: 7,
                    total_tokens: 49,
                    prompt_tokens_details: { cached_tokens: 30 },
                },
            },
        ])
        listening.push(endpoint.close)

        const client = new OpenAI({
            baseURL: endpoint.url,
            apiKey: "test",
            maxRetries: 0,
        })
        let beats = 0
        const round = await streamChatRound(
            client as unknown as ChatStreamClient,
            { model: "glm-5.2", messages: [{ role: "user", content: "decide" }] },
            { onActivity: () => (beats += 1) },
        )

        assert.equal(
            (round.items[0] as ModelMessageItem).toJSON().content[0].text,
            "reading the service",
        )
        const call = round.items[1] as FunctionCallItem
        assert.equal(call.name, "batch")
        assert.deepEqual(JSON.parse(call.args), { calls: [] })
        assert.equal(round.usage?.inputTokens, 42)
        assert.equal(round.usage?.inputTokenDetails?.cached_tokens, 30)
        assert.ok(beats >= 5, "each frame is proof of life, not just the last")
    })
})
