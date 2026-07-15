import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { afterEach, describe, it } from "node:test"

import {
    ModelContext,
    ModelMessageItem,
    SystemMessageItem,
} from "@mozaik-ai/core"

import {
    BILLING_MONEY_SCALE,
    GatewayBillingCoordinator,
    parseCloudBillingReceipt,
    resolveGatewayBillingEnvironment,
    type BillingInvocationContext,
    type CloudBillingReceipt,
} from "../../src/billing/index.js"
import {
    GenericOpenAIModel,
    runInferenceRound,
} from "../../src/planning/openai-runtime.js"
import { runArchitectOpenAI } from "../../src/planning/architect-openai.js"
import { runPlannerOpenAI } from "../../src/planning/planner-openai.js"

const servers = new Set<Server>()

afterEach(async () => {
    await Promise.all(
        [...servers].map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.closeAllConnections?.()
                    server.close(() => resolve())
                }),
        ),
    )
    servers.clear()
})

const invocationContext: BillingInvocationContext = {
    runId: null,
    phase: "story",
    storyId: "S1",
    leaseId: "lease-1",
    generation: 1,
    attempt: 1,
    turn: 1,
    round: 1,
    backend: "openai",
    requestedModel: "deepseek-v4-flash",
}

describe("GatewayBillingCoordinator", () => {
    it("requires an exact gateway and credential and rejects foreign dispatches", async () => {
        const first = coordinator("https://gateway.example/v1", "tenant-a")
        const second = coordinator("https://gateway.example/v1", "tenant-a")

        assert.equal(
            first.trustsEndpoint("https://gateway.example/v1/", "tenant-a"),
            true,
        )
        assert.equal(
            first.trustsEndpoint("https://gateway.example/v1", "tenant-b"),
            false,
        )
        assert.equal(
            first.trustsEndpoint("https://other.example/v1", "tenant-a"),
            false,
        )
        assert.equal(
            first.prepareDispatch(
                "https://gateway.example/v1",
                "tenant-b",
                invocationContext,
            ),
            null,
        )
        const dispatch = first.prepareDispatch(
            "https://gateway.example/v1",
            "tenant-a",
            invocationContext,
        )
        assert.ok(dispatch)
        await assert.rejects(
            second.observeRunner(dispatch, {
                status: "succeeded",
                durationMs: 1,
            }),
            /not issued by this coordinator/,
        )

        first.close()
        second.close()
    })

    it("retains a cloud measurement until an async publisher acknowledges it", async () => {
        let receipt: CloudBillingReceipt | null = null
        let cloudAttempts = 0
        const commits: string[] = []
        const published: string[] = []
        const gateway = new GatewayBillingCoordinator({
            runId: "run-1",
            gatewayBaseUrl: "https://gateway.example/v1",
            apiKey: "tenant-a",
            drainTimeoutMs: 1_000,
            feedMaxRetries: 0,
            commitCursor: (cursor) => commits.push(cursor),
            publishMeasurement: async (measurement) => {
                await new Promise((resolve) => setTimeout(resolve, 5))
                if (measurement.evidence.producer === "cloud") {
                    cloudAttempts += 1
                    if (cloudAttempts === 1) throw new Error("consumer unavailable")
                }
                published.push(measurement.measurementId)
            },
            fetchImpl: async () =>
                jsonResponse(
                    page(
                        gateway.billingSessionId,
                        receipt ? [receipt] : [],
                        "cursor-1",
                    ),
                ),
        })
        const dispatch = gateway.prepareDispatch(
            "https://gateway.example/v1",
            "tenant-a",
            invocationContext,
        )
        assert.ok(dispatch)
        receipt = completeReceipt(
            dispatch.record.billingSessionId,
            dispatch.record.invocationId,
        )

        await gateway.observeRunner(dispatch, {
            status: "succeeded",
            durationMs: 12,
            usage: undefined,
        })
        const result = await gateway.drain()

        assert.equal(result.complete, true)
        assert.equal(result.settledInvocations, 1)
        assert.equal(cloudAttempts, 2)
        assert.deepEqual(commits, ["cursor-1"])
        assert.equal(
            published.filter((id) => id === `billing:${receipt.receiptId}`).length,
            1,
        )
        gateway.close()
    })

    it("enforces drainTimeoutMs as a wall-clock deadline even when fetch hangs", async () => {
        const gateway = new GatewayBillingCoordinator({
            runId: "run-deadline",
            gatewayBaseUrl: "https://gateway.example/v1",
            apiKey: "tenant-a",
            drainTimeoutMs: 20,
            feedTimeoutMs: 60_000,
            feedMaxRetries: 0,
            publishMeasurement: () => undefined,
            fetchImpl: (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal
                    if (!signal) return
                    const abort = () => reject(signal.reason ?? new Error("aborted"))
                    if (signal.aborted) abort()
                    else signal.addEventListener("abort", abort, { once: true })
                }),
        })
        assert.ok(
            gateway.prepareDispatch(
                "https://gateway.example/v1",
                "tenant-a",
                invocationContext,
            ),
        )

        const started = Date.now()
        const result = await gateway.drain()
        const elapsed = Date.now() - started

        assert.equal(result.complete, false)
        assert.equal(result.unresolvedInvocationIds.length, 1)
        assert.ok(elapsed < 250, `drain took ${elapsed}ms`)
        gateway.close()
    })

    it("uses one upstream HTTP attempt and sends correlation only to the trusted gateway", async () => {
        let providerCalls = 0
        let requestBody: Record<string, unknown> | null = null
        let receipt: CloudBillingReceipt | null = null
        const baseUrl = await listen(async (request, response) => {
            if (request.method === "POST" && request.url === "/v1/chat/completions") {
                providerCalls += 1
                requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>
                const correlation = requestBody._baro_billing as {
                    session_id: string
                    invocation_id: string
                }
                receipt = completeReceipt(
                    correlation.session_id,
                    correlation.invocation_id,
                )
                return json(response, 200, chatCompletion())
            }
            if (request.method === "GET" && request.url?.startsWith("/v1/billing/receipts")) {
                return json(
                    response,
                    200,
                    page(
                        new URL(request.url, baseUrl).searchParams.get("session_id")!,
                        receipt ? [receipt] : [],
                        "cursor-1",
                    ),
                )
            }
            json(response, 404, { error: "not found" })
        })
        const gateway = new GatewayBillingCoordinator({
            runId: "run-http",
            gatewayBaseUrl: `${baseUrl}/v1`,
            apiKey: "tenant-a",
            publishMeasurement: () => undefined,
            feedMaxRetries: 0,
        })
        const model = new GenericOpenAIModel("deepseek-v4-flash", {
            baseURL: `${baseUrl}/v1`,
            apiKey: "tenant-a",
            extraBody: {
                _baro_billing: { forged: true },
                thinking: { type: "enabled" },
            },
        })
        model.setTools([])
        const context = ModelContext.create("billing-http").addContextItem(
            SystemMessageItem.create("Return ok"),
        )

        const round = await runInferenceRound(context, model, {
            billing: {
                coordinator: gateway,
                context: {
                    runId: "ignored",
                    phase: "story",
                    storyId: "S1",
                    leaseId: "lease-1",
                    generation: 1,
                    attempt: 1,
                    turn: 1,
                    round: 1,
                },
            },
        })
        const settled = await gateway.drain()

        assert.equal(providerCalls, 1)
        assert.ok(round.billingInvocationId)
        assert.deepEqual(requestBody?.thinking, { type: "enabled" })
        assert.deepEqual(requestBody?._baro_billing, {
            schema_version: 1,
            session_id: gateway.billingSessionId,
            invocation_id: round.billingInvocationId,
        })
        assert.equal(settled.complete, true)
        gateway.close()
    })

    it("strips reserved metadata from an ordinary compatible endpoint", async () => {
        let requestBody: Record<string, unknown> | null = null
        const baseUrl = await listen(async (request, response) => {
            requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>
            json(response, 200, chatCompletion())
        })
        const gateway = new GatewayBillingCoordinator({
            runId: "run-untrusted",
            gatewayBaseUrl: "https://trusted.example/v1",
            apiKey: "tenant-a",
            publishMeasurement: () => undefined,
        })
        const model = new GenericOpenAIModel("compatible-model", {
            baseURL: `${baseUrl}/v1`,
            apiKey: "ordinary-key",
            extraBody: { _baro_billing: { forged: true }, vendor_flag: true },
        })
        model.setTools([])

        const result = await runInferenceRound(
            ModelContext.create("ordinary-compatible"),
            model,
            {
                billing: {
                    coordinator: gateway,
                    context: {
                        runId: null,
                        phase: "story",
                        storyId: "S1",
                        leaseId: "lease-1",
                        generation: 1,
                        attempt: 1,
                        turn: 1,
                        round: 1,
                    },
                },
            },
        )

        assert.equal(result.billingInvocationId, null)
        assert.equal(Object.hasOwn(requestBody ?? {}, "_baro_billing"), false)
        assert.equal(requestBody?.vendor_flag, true)
        gateway.close()
    })

    it("disables hidden OpenAI SDK retries for a billed invocation", async () => {
        let providerCalls = 0
        const baseUrl = await listen(async (request, response) => {
            if (request.method === "POST") {
                providerCalls += 1
                return json(response, 500, { error: { message: "transient" } })
            }
            json(
                response,
                200,
                page(
                    new URL(request.url ?? "/", baseUrl).searchParams.get("session_id") ??
                        "unknown",
                    [],
                    "cursor-empty",
                ),
            )
        })
        const gateway = new GatewayBillingCoordinator({
            runId: "run-no-sdk-retry",
            gatewayBaseUrl: `${baseUrl}/v1`,
            apiKey: "tenant-a",
            publishMeasurement: () => undefined,
            drainTimeoutMs: 0,
        })
        const model = new GenericOpenAIModel("deepseek-v4-flash", {
            baseURL: `${baseUrl}/v1`,
            apiKey: "tenant-a",
        })
        model.setTools([])

        await assert.rejects(
            runInferenceRound(ModelContext.create("failure"), model, {
                billing: {
                    coordinator: gateway,
                    context: {
                        runId: null,
                        phase: "story",
                        storyId: "S1",
                        leaseId: "lease-1",
                        generation: 1,
                        attempt: 1,
                        turn: 1,
                        round: 1,
                    },
                },
            }),
        )
        assert.equal(providerCalls, 1)
        gateway.close()
    })

    it("aborts the underlying provider request before settling billed telemetry", async () => {
        let announceStarted!: () => void
        const providerStarted = new Promise<void>((resolve) => {
            announceStarted = resolve
        })
        let announceClosed!: () => void
        const providerClosed = new Promise<void>((resolve) => {
            announceClosed = resolve
        })
        const measurements: Array<{
            status: string
            totalReason: string | null
        }> = []
        const baseUrl = await listen(async (request, response) => {
            if (request.method === "POST") {
                response.once("close", announceClosed)
                await readBody(request)
                announceStarted()
                return
            }
            json(response, 200, page("unused", [], "cursor-empty"))
        })
        const gateway = new GatewayBillingCoordinator({
            runId: "run-provider-abort",
            gatewayBaseUrl: `${baseUrl}/v1`,
            apiKey: "tenant-a",
            publishMeasurement: (measurement) => {
                measurements.push({
                    status: measurement.status,
                    totalReason:
                        measurement.tokens.total.state === "unknown"
                            ? measurement.tokens.total.reason
                            : null,
                })
            },
            drainTimeoutMs: 0,
        })
        const model = new GenericOpenAIModel("deepseek-v4-flash", {
            baseURL: `${baseUrl}/v1`,
            apiKey: "tenant-a",
        })
        model.setTools([])
        const controller = new AbortController()
        const pending = runInferenceRound(
            ModelContext.create("provider-abort"),
            model,
            {
                signal: controller.signal,
                billing: {
                    coordinator: gateway,
                    context: {
                        runId: "run-provider-abort",
                        phase: "dialogue",
                        storyId: null,
                        leaseId: null,
                        generation: null,
                        attempt: null,
                        turn: 1,
                        round: 1,
                    },
                },
            },
        )

        await providerStarted
        controller.abort()
        await assert.rejects(pending, /abort/i)
        await Promise.race([
            providerClosed,
            new Promise<never>((_resolve, reject) =>
                setTimeout(
                    () => reject(new Error("provider connection was not closed")),
                    2_000,
                ),
            ),
        ])

        assert.deepEqual(measurements, [{
            status: "cancelled",
            totalReason: "not_reported",
        }])
        gateway.close()
    })
})

describe("billing opt-in isolation", () => {
    it("does not infer billing authority from local harness or generic OpenAI settings", () => {
        for (const environment of [
            { ANTHROPIC_API_KEY: "claude", CLAUDE_CODE_USE_SUBSCRIPTION: "1" },
            { CODEX_HOME: "/tmp/codex", OPENAI_API_KEY: "codex-subscription" },
            { OPENCODE_CONFIG: "/tmp/opencode", OPENAI_API_KEY: "open-code" },
            { PI_CODING_AGENT_DIR: "/tmp/pi" },
            {
                OPENAI_BASE_URL: "https://compatible.example/v1",
                OPENAI_API_KEY: "generic-key",
            },
        ]) {
            assert.equal(resolveGatewayBillingEnvironment(environment), null)
        }
    })

    it("requires the explicit billing URL and a credential", () => {
        assert.deepEqual(
            resolveGatewayBillingEnvironment({
                BARO_GATEWAY_BILLING_URL: " https://gateway.example/v1 ",
                JIGJOY_API_KEY: "tenant-a",
            }),
            {
                gatewayBaseUrl: "https://gateway.example/v1",
                apiKey: "tenant-a",
            },
        )
        assert.throws(
            () =>
                resolveGatewayBillingEnvironment({
                    BARO_GATEWAY_BILLING_URL: "https://gateway.example/v1",
                }),
            /requires/,
        )
    })
})

describe("planning phase billing wiring", () => {
    it("threads explicit planner and architect round identities without affecting other runtimes", async () => {
        const gateway = coordinator("https://gateway.example/v1", "tenant-a")
        const plannerOptions: unknown[] = []
        const architectOptions: unknown[] = []
        const model = new GenericOpenAIModel("deepseek-v4-pro")
        const modeContract = {
            mode: "parallel" as const,
            confidence: 1,
            reason: "test",
            source: "user",
        }
        const validPrd = JSON.stringify({
            project: "billing-wiring",
            branchName: "billing-wiring",
            description: "test",
            userStories: [
                {
                    id: "S1",
                    priority: 1,
                    title: "Test wiring",
                    description: "Exercise planning billing context.",
                    dependsOn: [],
                    retries: 1,
                    acceptance: ["Planner returns a runnable story."],
                    tests: ["npm test"],
                    model: "standard",
                },
            ],
        })
        await runPlannerOpenAI({
            goal: "test billing wiring",
            cwd: "/unused",
            modeContract,
            billingCoordinator: gateway,
            testRuntime: {
                model,
                tools: [],
                inferRound: async (_context, _model, options) => {
                    plannerOptions.push(options)
                    return {
                        items: [ModelMessageItem.rehydrate({ text: validPrd })],
                        usage: undefined,
                        billingInvocationId: null,
                    }
                },
            },
        })
        await runArchitectOpenAI({
            goal: "test billing wiring",
            cwd: "/unused",
            modeContract,
            billingCoordinator: gateway,
            testRuntime: {
                model,
                tools: [],
                inferRound: async (_context, _model, options) => {
                    architectOptions.push(options)
                    return {
                        items: [
                            ModelMessageItem.rehydrate({
                                text:
                                    "## Existing context\nBilling is explicit.\n\n" +
                                    "## ADR-001: Preserve opt-in billing\n" +
                                    "**Status:** Accepted\n" +
                                    "**Context:** Harnesses must remain local.\n" +
                                    "**Decision:** Bill only a trusted gateway.\n" +
                                    "**Consequences:** Claude and Codex remain unchanged.",
                            }),
                        ],
                        usage: undefined,
                        billingInvocationId: null,
                    }
                },
            },
        })

        assert.equal(
            (plannerOptions[0] as { billing: { context: { phase: string } } })
                .billing.context.phase,
            "planner",
        )
        assert.equal(
            (architectOptions[0] as { billing: { context: { phase: string } } })
                .billing.context.phase,
            "architect",
        )
        gateway.close()
    })
})

function coordinator(gatewayBaseUrl: string, apiKey: string) {
    return new GatewayBillingCoordinator({
        runId: "run",
        gatewayBaseUrl,
        apiKey,
        publishMeasurement: () => undefined,
        fetchImpl: async () => jsonResponse(page("unused", [], "cursor")),
    })
}

function completeReceipt(
    billingSessionId: string,
    invocationId: string,
): CloudBillingReceipt {
    return parseCloudBillingReceipt({
        schemaVersion: 1,
        receiptId: `receipt-${invocationId}`,
        chargeId: `charge-${invocationId}`,
        billingSessionId,
        invocationId,
        provider: "deepseek",
        requestedModel: "deepseek-v4-flash",
        resolvedModel: "deepseek-v4-flash",
        providerRequestId: `provider-${invocationId}`,
        tokens: {
            inputTotal: 10,
            cachedInput: 0,
            cacheWriteInput: null,
            outputTotal: 5,
            reasoningOutput: 0,
            total: 15,
        },
        state: "final",
        metering: "complete",
        providerCost: {
            currency: "USD",
            amount: "1000",
            scale: BILLING_MONEY_SCALE,
        },
        customerCost: {
            currency: "USD",
            amount: "1200",
            scale: BILLING_MONEY_SCALE,
        },
        rateCardVersion: "test-v1",
        settledAt: "2026-07-14T12:00:00Z",
    })
}

function page(
    billingSessionId: string,
    receipts: readonly unknown[],
    nextCursor: string,
) {
    return {
        schemaVersion: 1,
        billingSessionId,
        receipts,
        nextCursor,
        hasMore: false,
    }
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
    })
}

function chatCompletion() {
    return {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "deepseek-v4-flash",
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
        },
    }
}

async function listen(
    handler: Parameters<typeof createServer>[0],
): Promise<string> {
    const server = createServer(handler)
    servers.add(server)
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === "object")
    return `http://127.0.0.1:${address.port}`
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
    let body = ""
    for await (const chunk of request) body += chunk.toString()
    return body
}

function json(
    response: import("node:http").ServerResponse,
    status: number,
    value: unknown,
): void {
    const body = JSON.stringify(value)
    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
    })
    response.end(body)
}
