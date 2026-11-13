import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { afterAll, describe, it } from "@rstest/core"

import OpenAI from "openai"

import {
    IncompleteChatRoundError,
    streamChatRound,
    type ChatCompletionChunk,
    type ChatStreamClient,
} from "../../../src/harness/openai/chat-stream.js"
import { OpenAIStoryAgent } from "../../../src/harness/openai/story-agent.js"
import { FunctionCallItem, ModelMessageItem, toWire } from "../../../src/runtime/mozaik.js"
import { captureEnv, withTempDir } from "../../execution/helpers.js"

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

const ended = (reason: string): ChatCompletionChunk => ({
    choices: [{ finish_reason: reason, delta: {} }],
})

const partialCall = (args: string): ChatCompletionChunk => ({
    choices: [
        {
            delta: {
                tool_calls: [
                    { index: 0, id: "call_1", function: { name: "read_files", arguments: args } },
                ],
            },
        },
    ],
})

const incomplete = (reason: string) => (error: unknown) =>
    error instanceof IncompleteChatRoundError && error.reason === reason

describe("a streamed round is assembled into what a round returns", () => {
    it("asks for usage, without which a streamed round reports no tokens", async () => {
        const { client, sent } = endpoint([text("hi"), ended("stop")])
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
            ended("stop"),
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.items.length, 1)
        assert.equal(
            toWire((round.items[0] as ModelMessageItem)).content[0].text,
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
            ended("tool_calls"),
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
            ended("tool_calls"),
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
            ended("stop"),
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
        const { client } = endpoint([text("done"), ended("stop")])
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
            ended("length"),
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.truncated, true)
    })

    it("does not call a finished reply truncated", async () => {
        const { client } = endpoint([
            text("done"),
            ended("stop"),
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.truncated, false)
    })

    it("returns a tool round that finished with its calls whole", async () => {
        const { client } = endpoint([
            partialCall('{"paths":["a.ts"]}'),
            ended("tool_calls"),
        ])
        const round = await streamChatRound(client, {})
        assert.equal(round.truncated, false)
        assert.deepEqual(JSON.parse((round.items[0] as FunctionCallItem).args), {
            paths: ["a.ts"],
        })
    })

    it("refuses a round the provider's content filter stopped", async () => {
        const { client } = endpoint([
            text("The decision "),
            ended("content_filter"),
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ])
        await assert.rejects(streamChatRound(client, {}), incomplete("content_filter"))
    })

    it("refuses a stream that ended after partial text with no finish reason", async () => {
        const { client } = endpoint([text("The decision ")])
        await assert.rejects(streamChatRound(client, {}), incomplete("eof"))
    })

    it("refuses a stream that ended mid tool-call arguments with no finish reason", async () => {
        const { client } = endpoint([partialCall('{"paths":["a.')])
        await assert.rejects(streamChatRound(client, {}), incomplete("eof"))
    })

    it("proves it is alive on every chunk", async () => {
        const { client } = endpoint([text("a"), text("b"), text("c"), ended("stop")])
        let beats = 0
        await streamChatRound(client, {}, { onActivity: () => (beats += 1) })
        assert.equal(beats, 4, "silence must be measurable while the model writes")
    })

    it("passes the caller's transport options through untouched", async () => {
        const { client, options } = endpoint([text("hi"), ended("stop")])
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
afterAll(() => {
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
            toWire((round.items[0] as ModelMessageItem)).content[0].text,
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

/** Serves one scripted stream per request, the last one repeating. */
async function scriptedProvider(
    rounds: Array<{ frames: unknown[]; done?: boolean }>,
): Promise<{ url: string; requests: () => number }> {
    let served = 0
    const server = createServer((request, response) => {
        request.resume()
        request.on("end", () => {
            const round = rounds[Math.min(served, rounds.length - 1)]!
            served += 1
            response.writeHead(200, { "content-type": "text/event-stream" })
            for (const frame of round.frames) {
                response.write(`data: ${JSON.stringify(frame)}\n\n`)
            }
            response.end(round.done === false ? undefined : "data: [DONE]\n\n")
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    listening.push(() => server.close())
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    return { url: `http://127.0.0.1:${port}/v1`, requests: () => served }
}

const frame = (choice: Record<string, unknown>) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: null, ...choice }],
})
const said = (content: string) => frame({ delta: { role: "assistant", content } })
const writeArgs = (args: string) =>
    frame({
        delta: {
            tool_calls: [
                {
                    index: 0,
                    id: "call_w",
                    type: "function",
                    function: { name: "write_file", arguments: args },
                },
            ],
        },
    })
const finished = (reason: string) => frame({ finish_reason: reason })
const billed = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
}
const settles = { frames: [said("story complete"), finished("stop"), billed] }
const fullWrite = JSON.stringify({ path: "written.txt", content: "x\n" })

async function runStory(
    rounds: Array<{ frames: unknown[]; done?: boolean }>,
    check: (
        outcome: Awaited<ReturnType<OpenAIStoryAgent["run"]>>,
        cwd: string,
        requests: number,
    ) => void,
): Promise<void> {
    await withTempDir("chat-stream-ending-", async (cwd) => {
        const provider = await scriptedProvider(rounds)
        const agent = new OpenAIStoryAgent(
            {
                id: "story-ending",
                prompt: "finish the story",
                cwd,
                retries: 0,
                quietTimeoutMs: 5,
                maxTurns: 1,
            },
            {
                model: "fake-model",
                baseUrl: provider.url,
                apiKey: "test-key",
                maxRoundsPerTurn: 3,
                perRoundTimeoutSecs: 5,
            },
        )
        check(await agent.run(captureEnv()), cwd, provider.requests())
    })
}

// The story agent settles a story on a round's last message and runs its tool
// calls, so it is where an unfinished round would be mistaken for a finished one.
describe("what a story does with each way a streamed round ends", () => {
    it("settles on a reply that finished with stop", async () => {
        await runStory([settles], (outcome) => {
            assert.equal(outcome.success, true)
        })
    })

    it("runs a finished tool round, then settles", async () => {
        await runStory(
            [{ frames: [writeArgs(fullWrite), finished("tool_calls"), billed] }, settles],
            (outcome, cwd) => {
                assert.equal(outcome.success, true)
                assert.equal(existsSync(join(cwd, "written.txt")), true)
            },
        )
    })

    it("does not settle on a reply the content filter stopped", async () => {
        await runStory(
            [{ frames: [said("story comp"), finished("content_filter"), billed] }],
            (outcome) => {
                assert.equal(outcome.success, false)
                assert.match(outcome.error ?? "", /content_filter/u)
            },
        )
    })

    it("does not settle on partial text from a stream that just stopped", async () => {
        await runStory([{ frames: [said("story comp")], done: false }], (outcome) => {
            assert.equal(outcome.success, false)
            assert.match(outcome.error ?? "", /no finish_reason/u)
        })
    })

    it("does not answer a tool call whose arguments never finished", async () => {
        await runStory(
            [{ frames: [writeArgs('{"path":"written.txt","con')] }, settles],
            (outcome, _cwd, requests) => {
                assert.equal(outcome.success, false)
                assert.equal(requests, 1, "no tool result is sent back for the fragment")
            },
        )
    })

    // Arguments that happen to parse still come from a round that never ended.
    it("does not run a parseable tool call from a round with no finish reason", async () => {
        await runStory([{ frames: [writeArgs(fullWrite)] }, settles], (outcome, cwd) => {
            assert.equal(existsSync(join(cwd, "written.txt")), false)
            assert.equal(outcome.success, false)
        })
    })
})
