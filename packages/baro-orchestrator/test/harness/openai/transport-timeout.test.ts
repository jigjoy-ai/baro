import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import { after, describe, it } from "node:test"

import OpenAI from "openai"

const load = createRequire(import.meta.url)
const { Agent } = load("undici") as {
    Agent: new (options: Record<string, unknown>) => unknown
}

/** A model that thinks for `delayMs` before its first byte of response. */
function slowEndpoint(delayMs: number): Promise<{ url: string; close: () => void }> {
    const server: Server = createServer((_request, response) => {
        setTimeout(() => {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(
                JSON.stringify({
                    id: "cmpl-1",
                    object: "chat.completion",
                    created: 0,
                    model: "slow",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "the decision" },
                            finish_reason: "stop",
                        },
                    ],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
            )
        }, delayMs)
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

const started: Array<() => void> = []
after(() => {
    for (const close of started) close()
})

async function ask(baseURL: string, dispatcher: unknown): Promise<string> {
    const client = new OpenAI({ baseURL, apiKey: "test", maxRetries: 0 })
    const response = await client.chat.completions.create(
        { model: "slow", messages: [{ role: "user", content: "decide" }] },
        { fetchOptions: { dispatcher } as never },
    )
    return response.choices[0]?.message?.content ?? ""
}

// Baro removed its wall-clock caps in 0.82.0, and Node's fetch quietly put one
// back: undici defaults headersTimeout to 300s, and a non-streamed completion
// sends no header until the whole answer exists. Three live rounds died at
// exactly 301s while the model was still answering correctly.
describe("a long answer is not a timed-out one", () => {
    it("honours the dispatcher we hand the provider client", async () => {
        const endpoint = await slowEndpoint(1_500)
        started.push(endpoint.close)
        // Proves the plumbing: a cap this tight must actually bite, or the
        // test below would pass for the wrong reason.
        await assert.rejects(
            ask(endpoint.url, new Agent({ headersTimeout: 300, bodyTimeout: 300 })),
            (error: Error) => /timed out|timeout/iu.test(error.message),
        )
    })

    it("lets an answer take as long as it takes", async () => {
        const endpoint = await slowEndpoint(1_500)
        started.push(endpoint.close)
        const answer = await ask(
            endpoint.url,
            new Agent({ headersTimeout: 0, bodyTimeout: 0 }),
        )
        assert.equal(answer, "the decision")
    })

    it("is what an inference round asks for", async () => {
        // The round's own configuration, read back: no transport deadline.
        const runtime = await import("../../../src/harness/openai/runtime.js")
        const uncapped = (
            runtime as unknown as {
                __testUncappedTransport?: () => { fetchOptions?: { dispatcher?: unknown } }
            }
        ).__testUncappedTransport
        assert.ok(uncapped, "the round must expose what it hands the client")
        const dispatcher = uncapped().fetchOptions?.dispatcher
        assert.ok(dispatcher, "a round without a dispatcher inherits the 300s default")
    })
})
