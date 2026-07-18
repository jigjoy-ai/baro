import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"

import type { PrdFile, PrdStory } from "../../src/prd.js"
import {
    PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA,
    type PlannerOpenAIPlanFragmentEvent,
} from "../../src/planning/planner-openai-progressive.js"
import {
    createPlannerHarnessProgressiveSupport,
    parseProgressivePlannerMcpInvocation,
    PROGRESSIVE_PLANNER_MCP_MODE,
    PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
    runProgressivePlannerMcpServer,
    type PlannerProgressiveMcpStatus,
} from "../../src/planning/planner-harness-progressive.js"

interface JsonRpcResponse {
    jsonrpc: "2.0"
    id: string | number | null
    result?: unknown
    error?: {
        code: number
        message: string
    }
}

interface PendingRequest {
    resolve(response: JsonRpcResponse): void
    reject(error: Error): void
    timer: NodeJS.Timeout
}

interface McpClient {
    request(method: string, params?: unknown): Promise<JsonRpcResponse>
    notify(method: string, params?: unknown): void
    close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
    terminate(): Promise<void>
    stderr(): string
}

function story(
    id: string,
    dependsOn: string[] = [],
    overrides: Partial<PrdStory> = {},
): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/gu, "")) || 1,
        title: `Story ${id}`,
        description: `Implement ${id}`,
        dependsOn,
        retries: 2,
        acceptance: [`${id} is observable`],
        tests: [`npm test -- ${id}`],
        goalInvariantIds: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
        ...overrides,
    }
}

function finalPrd(stories: PrdStory[]): PrdFile {
    return {
        project: "harness-progressive-test",
        branchName: "baro/harness-progressive-test",
        description: "Reconcile a plan published through the stdio MCP child.",
        userStories: stories,
    }
}

function record(value: unknown, label: string): Record<string, unknown> {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), label)
    return value as Record<string, unknown>
}

function toolPayload(response: JsonRpcResponse): Record<string, unknown> {
    assert.equal(response.error, undefined)
    const result = record(response.result, "tools/call must return an MCP result")
    const content = result.content
    assert.ok(Array.isArray(content) && content.length === 1)
    const item = record(content[0], "tools/call must return one text content item")
    assert.equal(item.type, "text")
    assert.equal(typeof item.text, "string")
    return { result, text: item.text }
}

function spawnMcpClient(
    command: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
    onResponse: (response: JsonRpcResponse) => void,
): McpClient {
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { ...process.env, ...environment, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
    })
    const pending = new Map<string | number | null, PendingRequest>()
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    let nextId = 1
    let stderr = ""
    let closed = false

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk
    })

    lines.on("line", (line) => {
        let response: JsonRpcResponse
        try {
            response = JSON.parse(line) as JsonRpcResponse
        } catch (error) {
            for (const request of pending.values()) {
                clearTimeout(request.timer)
                request.reject(
                    new Error(`MCP child emitted invalid JSON: ${line}`, {
                        cause: error,
                    }),
                )
            }
            pending.clear()
            return
        }
        onResponse(response)
        const request = pending.get(response.id)
        if (!request) return
        pending.delete(response.id)
        clearTimeout(request.timer)
        request.resolve(response)
    })

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
            child.once("error", reject)
            child.once("close", (code, signal) => {
                closed = true
                lines.close()
                for (const request of pending.values()) {
                    clearTimeout(request.timer)
                    request.reject(
                        new Error(
                            `MCP child closed before replying (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
                        ),
                    )
                }
                pending.clear()
                resolve({ code, signal })
            })
        },
    )

    return {
        request(method, params) {
            const id = nextId++
            return new Promise<JsonRpcResponse>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id)
                    reject(
                        new Error(
                            `timed out waiting for MCP ${method} response: ${stderr}`,
                        ),
                    )
                }, 10_000)
                pending.set(id, { resolve, reject, timer })
                child.stdin.write(
                    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
                )
            })
        },
        notify(method, params) {
            child.stdin.write(
                JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
            )
        },
        async close() {
            if (!closed) child.stdin.end()
            return await exit
        },
        async terminate() {
            if (!closed) child.kill()
            try {
                await exit
            } catch {
                // The original test failure is more useful than cleanup noise.
            }
        },
        stderr: () => stderr,
    }
}

describe("progressive planner harness MCP", () => {
    it("relays a complete deterministic MCP session through the run-planner child", { timeout: 30_000 }, async () => {
        const published: PlannerOpenAIPlanFragmentEvent[] = []
        const firstPublishOrder: string[] = []
        const statuses: PlannerProgressiveMcpStatus[] = []
        const runPlanner = fileURLToPath(
            new URL("../../scripts/run-planner.ts", import.meta.url),
        )
        const support = await createPlannerHarnessProgressiveSupport({
            runId: "run-harness-progressive",
            planningId: "planning-harness-progressive",
            publish: async (event) => {
                if (published.length === 0) firstPublishOrder.push("parent-publish")
                published.push(event)
            },
            onStatus: (status) => statuses.push(status),
            mcpServer: {
                command: process.execPath,
                args: ["--import", "tsx", runPlanner, PROGRESSIVE_PLANNER_MCP_MODE],
            },
        })
        assert.ok(support.mcpConnection)

        const client = spawnMcpClient(
            support.mcpConnection.command,
            support.mcpConnection.args,
            support.mcpConnection.providerEnvironment,
            (response) => {
                if (response.id === 3) firstPublishOrder.push("mcp-response")
            },
        )

        try {
            assert.throws(
                () => support.assertInitialized(),
                /was not initialized by the harness/u,
            )

            const initialized = await client.request("initialize", {
                protocolVersion: "2099-12-31",
                capabilities: {},
                clientInfo: { name: "baro-test", version: "1.0.0" },
            })
            assert.equal(initialized.error, undefined)
            assert.deepEqual(initialized.result, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: {
                    name: "baro-progressive-planner",
                    version: "1.0.0",
                },
                instructions: support.systemInstruction,
            })
            support.assertInitialized()
            client.notify("notifications/initialized", {})

            const listed = await client.request("tools/list", {})
            assert.equal(listed.error, undefined)
            const listedResult = record(listed.result, "tools/list result is required")
            assert.ok(Array.isArray(listedResult.tools))
            assert.equal(listedResult.tools.length, 1)
            const listedTool = record(listedResult.tools[0], "tool definition is required")
            assert.equal(listedTool.name, PROGRESSIVE_PLANNER_MCP_TOOL_NAME)
            assert.deepEqual(
                listedTool.inputSchema,
                PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA,
            )
            const storiesSchema = record(
                record(
                    listedTool.inputSchema,
                    "tool input schema is required",
                ).properties,
                "tool input properties are required",
            ).stories
            const storyItems = record(
                record(storiesSchema, "stories schema is required").items,
                "story items schema is required",
            )
            assert.equal(storyItems.type, "object")
            assert.deepEqual(storyItems.required, [
                "id",
                "priority",
                "title",
                "description",
                "dependsOn",
                "retries",
                "acceptance",
                "tests",
                "goalInvariantIds",
                "model",
            ])
            assert.equal(storyItems.additionalProperties, false)

            const s1 = story("S1")
            const {
                passes: _passes,
                completedAt: _completedAt,
                durationSecs: _durationSecs,
                ...finalPrdS1
            } = s1
            const publishedResponse = await client.request("tools/call", {
                name: PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
                arguments: {
                    fragmentId: "foundation",
                    stories: [finalPrdS1],
                },
            })
            const firstPayload = toolPayload(publishedResponse)
            assert.equal(firstPayload.result.isError, false)
            assert.deepEqual(firstPublishOrder, ["parent-publish", "mcp-response"])
            assert.equal(published.length, 1)
            assert.deepEqual(published[0], {
                type: "plan_fragment",
                run_id: "run-harness-progressive",
                planning_id: "planning-harness-progressive",
                fragment_id: "foundation",
                ordinal: 1,
                stories: [s1],
            })
            assert.deepEqual(JSON.parse(firstPayload.text as string), {
                ok: true,
                disposition: "admitted",
                fragmentId: "foundation",
                ordinal: 1,
                fingerprint: JSON.parse(firstPayload.text as string).fingerprint,
                storyIds: ["S1"],
                nextOrdinal: 2,
            })
            assert.match(
                (JSON.parse(firstPayload.text as string) as { fingerprint: string })
                    .fingerprint,
                /^[a-f0-9]{64}$/u,
            )
            assert.equal(support.hasEarlyPlan(), true)

            const replayResponse = await client.request("tools/call", {
                name: PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
                arguments: { fragmentId: "foundation", stories: [s1] },
            })
            const replayPayload = toolPayload(replayResponse)
            assert.equal(replayPayload.result.isError, false)
            assert.deepEqual(JSON.parse(replayPayload.text as string), {
                ...JSON.parse(firstPayload.text as string),
                disposition: "replayed",
            })
            assert.equal(published.length, 2)
            assert.deepEqual(published[1], published[0])

            const invalidResponse = await client.request("tools/call", {
                name: PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
                arguments: {
                    fragmentId: "forward-reference",
                    stories: [story("S2", ["S99"])],
                },
            })
            const invalidPayload = toolPayload(invalidResponse)
            assert.equal(invalidPayload.result.isError, true)
            assert.match(
                invalidPayload.text as string,
                /depends on unknown provisional story 'S99'/u,
            )
            assert.equal(published.length, 2)
            assert.deepEqual(statuses, [
                "mcp-initialized",
                "tools-listed",
                "publish-attempt",
                "admission-receipt",
                "publish-attempt",
                "admission-receipt",
                "publish-attempt",
                "validation-failure",
            ])
            assert.doesNotMatch(
                statuses.join(" "),
                /foundation|S1|S99|token|secret/u,
            )

            const s2 = story("S2", ["S1"])
            const final = JSON.stringify(finalPrd([s1, s2]))
            assert.doesNotThrow(() => support.reconcileFinalCandidate(final))
            assert.doesNotThrow(() => support.reconcileFinalCandidate(final))
            assert.throws(
                () =>
                    support.reconcileFinalCandidate(
                        JSON.stringify(
                            finalPrd([
                                story("S1", [], { title: "Changed after publication" }),
                                s2,
                            ]),
                        ),
                    ),
                /already reconciled with a different final PRD/u,
            )

            const childExit = await client.close()
            assert.deepEqual(childExit, { code: 0, signal: null })
            assert.equal(client.stderr(), "")
            await support.close()
            await support.close()
        } finally {
            await client.terminate()
            await support.close()
        }
    })

    it("preserves split UTF-8 input and negotiates only its supported protocol", async () => {
        const published: PlannerOpenAIPlanFragmentEvent[] = []
        const support = await createPlannerHarnessProgressiveSupport({
            runId: "run-split-utf8",
            planningId: "planning-split-utf8",
            publish: async (event) => {
                published.push(event)
            },
            mcpServer: {
                command: process.execPath,
                args: [PROGRESSIVE_PLANNER_MCP_MODE],
            },
        })
        assert.ok(support.mcpConnection)
        const invocation = parseProgressivePlannerMcpInvocation(
            support.mcpConnection.args,
            support.mcpConnection.providerEnvironment,
        )
        assert.ok(invocation)
        const unicodeStory = story("S1", [], { title: "Compose the 🧩 plan" })
        const wire = Buffer.from(
            [
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: { protocolVersion: "2099-12-31" },
                }),
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: {
                        name: PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
                        arguments: {
                            fragmentId: "unicode-foundation",
                            stories: [unicodeStory],
                        },
                    },
                }),
                "",
            ].join("\n"),
            "utf8",
        )
        const emoji = Buffer.from("🧩", "utf8")
        const emojiStart = wire.indexOf(emoji)
        assert.notEqual(emojiStart, -1)
        const outputChunks: Buffer[] = []
        const output = new Writable({
            write(chunk: Buffer, _encoding, callback) {
                outputChunks.push(Buffer.from(chunk))
                callback()
            },
        })

        try {
            await runProgressivePlannerMcpServer({
                ...invocation,
                input: Readable.from([
                    wire.subarray(0, emojiStart + 1),
                    wire.subarray(emojiStart + 1),
                ]),
                output,
            })
            const responses = Buffer.concat(outputChunks)
                .toString("utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as JsonRpcResponse)
            assert.equal(
                record(responses[0]!.result, "initialize result").protocolVersion,
                "2024-11-05",
            )
            assert.equal(
                record(responses[1]!.result, "tool result").isError,
                false,
            )
            assert.equal(published[0]!.stories[0]!.title, "Compose the 🧩 plan")
        } finally {
            await support.close()
        }
    })

    it("waits for an admitted in-flight publication before closing", async () => {
        let markPublishEntered!: () => void
        let releasePublish!: () => void
        const publishEntered = new Promise<void>((resolve) => {
            markPublishEntered = resolve
        })
        const publishGate = new Promise<void>((resolve) => {
            releasePublish = resolve
        })
        const support = await createPlannerHarnessProgressiveSupport({
            runId: "run-close-waits",
            planningId: "planning-close-waits",
            publish: async () => {
                markPublishEntered()
                await publishGate
            },
            mcpServer: {
                command: process.execPath,
                args: [PROGRESSIVE_PLANNER_MCP_MODE],
            },
        })
        assert.ok(support.mcpConnection)
        const invocation = parseProgressivePlannerMcpInvocation(
            support.mcpConnection.args,
            support.mcpConnection.providerEnvironment,
        )
        assert.ok(invocation)
        const input = Readable.from([
            Buffer.from(
                [
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "initialize",
                        params: { protocolVersion: "2024-11-05" },
                    }),
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: 2,
                        method: "tools/call",
                        params: {
                            name: PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
                            arguments: {
                                fragmentId: "closing-foundation",
                                stories: [story("S1")],
                            },
                        },
                    }),
                    "",
                ].join("\n"),
            ),
        ])
        const output = new Writable({
            write(_chunk, _encoding, callback) {
                callback()
            },
        })
        const serving = runProgressivePlannerMcpServer({
            ...invocation,
            input,
            output,
        })
        let closeSettled = false

        try {
            await publishEntered
            const closing = support.close().then(() => {
                closeSettled = true
            })
            await new Promise<void>((resolve) => setImmediate(resolve))
            assert.equal(closeSettled, false)
            releasePublish()
            await closing
            assert.equal(closeSettled, true)
            await serving
        } finally {
            releasePublish()
            await support.close()
            await serving.catch(() => undefined)
        }
    })
})
