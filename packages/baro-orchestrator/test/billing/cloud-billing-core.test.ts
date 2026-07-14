import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { afterEach, describe, it } from "node:test"

import {
    BILLING_MONEY_SCALE,
    BillingFeedClosedError,
    BillingFeedProtocolError,
    BillingFeedTimeoutError,
    BillingInvocationAuthorityError,
    BillingInvocationRegistry,
    BillingReceiptConflictError,
    BillingReceiptFeedClient,
    BillingReceiptLedger,
    BillingReceiptValidationError,
    MAX_BILLING_MONEY_NANOUNITS,
    createTrustedGatewayIdentity,
    mapCloudBillingReceipt,
    parseCloudBillingReceipt,
    type BillingInvocationContext,
    type BillingMoney,
    type CloudBillingReceipt,
} from "../../src/billing/index.js"

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

function money(amount: string): BillingMoney {
    return { currency: "USD", amount, scale: BILLING_MONEY_SCALE }
}

const context: BillingInvocationContext = {
    runId: "run-local",
    phase: "story",
    storyId: "S1",
    leaseId: "lease-local",
    generation: 3,
    attempt: 2,
    turn: 4,
    round: 1,
    backend: "openai",
    requestedModel: "deepseek-v4-flash",
}

function completeReceipt(
    billingSessionId: string,
    invocationId: string,
    overrides: Record<string, unknown> = {},
): CloudBillingReceipt {
    return parseCloudBillingReceipt({
        schemaVersion: 1,
        receiptId: `receipt-${invocationId}`,
        chargeId: `charge-${invocationId}`,
        billingSessionId,
        invocationId,
        provider: "deepseek",
        requestedModel: "deepseek-v4-flash",
        resolvedModel: "deepseek-chat-v4-flash-202607",
        providerRequestId: `provider-${invocationId}`,
        tokens: {
            inputTotal: 1_000,
            cachedInput: 400,
            cacheWriteInput: null,
            outputTotal: 200,
            reasoningOutput: 50,
            total: 1_200,
        },
        state: "final",
        metering: "complete",
        providerCost: money("4200000"),
        customerCost: money("5000000"),
        rateCardVersion: "2026-07",
        settledAt: "2026-07-14T12:34:56.123456789Z",
        ...overrides,
    })
}

function unbillableReceipt(
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
        resolvedModel: "deepseek-chat-v4-flash-202607",
        providerRequestId: `provider-${invocationId}`,
        tokens: {
            inputTotal: null,
            cachedInput: null,
            cacheWriteInput: null,
            outputTotal: null,
            reasoningOutput: null,
            total: null,
        },
        state: "final",
        metering: "unbillable",
        providerCost: null,
        customerCost: null,
        rateCardVersion: "2026-07",
        settledAt: "2026-07-14T12:34:56Z",
        unbillableReason: "terminal usage was not reported",
    })
}

describe("canonical cloud billing receipt", () => {
    it("preserves an exact settled zero and freezes the complete receipt", () => {
        const receipt = completeReceipt("session-1", "invocation-1", {
            providerRequestId: null,
            providerCost: null,
            customerCost: money("0"),
            chargeBreakdown: {
                markupMultiplier: 1,
                allowanceApplied: money("0"),
                bankedDebit: money("0"),
                bankedBalanceAfter: money("-5000000000"),
                allowanceRemaining: money("0"),
                insufficient: true,
            },
            attribution: { tenantId: "tenant-1", runId: "backend-run-id" },
        })

        assert.equal(receipt.metering, "complete")
        assert.equal(receipt.customerCost.amount, "0")
        assert.equal(receipt.providerRequestId, null)
        assert.equal(Object.isFrozen(receipt), true)
        assert.equal(Object.isFrozen(receipt.tokens), true)
        assert.equal(Object.isFrozen(receipt.chargeBreakdown), true)
        assert.equal(Object.isFrozen(receipt.attribution), true)
    })

    it("rejects unsafe, ambiguous, inconsistent, and extra receipt data", () => {
        const valid = structuredClone(completeReceipt("session-1", "invocation-1"))

        assert.throws(
            () =>
                parseCloudBillingReceipt({
                    ...valid,
                    customerCost: money("00"),
                }),
            BillingReceiptValidationError,
        )
        assert.throws(
            () =>
                parseCloudBillingReceipt({
                    ...valid,
                    customerCost: money(
                        (MAX_BILLING_MONEY_NANOUNITS + 1n).toString(),
                    ),
                }),
            /safe telemetry range/,
        )
        assert.throws(
            () =>
                parseCloudBillingReceipt({
                    ...valid,
                    tokens: { ...valid.tokens, inputTotal: Number.MAX_SAFE_INTEGER + 1 },
                }),
            /safe integer/,
        )
        assert.throws(
            () =>
                parseCloudBillingReceipt({
                    ...valid,
                    tokens: { ...valid.tokens, inputTotal: -0 },
                }),
            /safe integer/,
        )
        assert.throws(
            () =>
                parseCloudBillingReceipt({
                    ...valid,
                    tokens: { ...valid.tokens, cachedInput: 1_001 },
                }),
            /cachedInput exceeds/,
        )
        assert.throws(
            () => parseCloudBillingReceipt({ ...valid, surprise: true }),
            /invalid fields/,
        )
        assert.throws(
            () =>
                parseCloudBillingReceipt({
                    ...structuredClone(
                        unbillableReceipt("session-1", "invocation-2"),
                    ),
                    customerCost: money("0"),
                }),
            /must be null, never zero/,
        )
    })
})

describe("billing invocation local authority", () => {
    it("requires TLS outside explicit loopback development", () => {
        assert.throws(
            () => createTrustedGatewayIdentity("http://gateway.example/v1"),
            /must use https/,
        )
        assert.equal(
            createTrustedGatewayIdentity("http://127.0.0.1:8787/v1").origin,
            "http://127.0.0.1:8787",
        )
    })

    it("allocates opaque immutable identities and enforces bounded exact lookup", () => {
        const gateway = createTrustedGatewayIdentity("https://gateway.example/api")
        const firstRegistry = new BillingInvocationRegistry({
            trustedGateway: gateway,
            maxEntries: 1,
        })
        const secondRegistry = new BillingInvocationRegistry({ trustedGateway: gateway })
        const first = firstRegistry.allocate(context)
        const second = firstRegistry.allocate({ ...context, round: 2 })

        assert.notEqual(firstRegistry.billingSessionId, secondRegistry.billingSessionId)
        assert.notEqual(first.invocationId, second.invocationId)
        assert.match(first.invocationId, /^binv_[A-Za-z0-9_-]{32}$/)
        assert.match(first.billingSessionId, /^bsess_[A-Za-z0-9_-]{32}$/)
        assert.equal(Object.isFrozen(first), true)
        assert.equal(Object.isFrozen(first.trustedGateway), true)
        assert.equal(firstRegistry.size, 1)
        assert.equal(firstRegistry.get(first.invocationId), undefined)
        assert.equal(firstRegistry.get(second.invocationId), second)

        assert.throws(
            () =>
                firstRegistry.requireForReceipt(
                    completeReceipt(first.billingSessionId, first.invocationId),
                    gateway,
                ),
            /unknown invocationId/,
        )
    })

    it("rejects foreign sessions and foreign gateway identity", () => {
        const gateway = createTrustedGatewayIdentity("https://gateway.example")
        const registry = new BillingInvocationRegistry({ trustedGateway: gateway })
        const record = registry.allocate(context)

        assert.throws(
            () =>
                registry.requireForReceipt(
                    completeReceipt("foreign-session", record.invocationId),
                    gateway,
                ),
            BillingInvocationAuthorityError,
        )
        assert.throws(
            () =>
                registry.requireForReceipt(
                    completeReceipt(record.billingSessionId, record.invocationId),
                    createTrustedGatewayIdentity("https://evil.example"),
                ),
            /untrusted gateway/,
        )
    })
})

describe("receipt mapping and ingestion", () => {
    it("uses local authority dimensions and authoritative cloud cost sources", () => {
        const gateway = createTrustedGatewayIdentity("https://gateway.example")
        const registry = new BillingInvocationRegistry({ trustedGateway: gateway })
        const record = registry.allocate(context)
        const receipt = completeReceipt(record.billingSessionId, record.invocationId, {
            customerCost: money("0"),
        })
        const measurement = mapCloudBillingReceipt(receipt, record)

        assert.equal(measurement.measurementId, `billing:${receipt.receiptId}`)
        assert.equal(measurement.invocationId, record.invocationId)
        assert.equal(measurement.runId, "run-local")
        assert.equal(measurement.storyId, "S1")
        assert.equal(measurement.leaseId, "lease-local")
        assert.equal(measurement.generation, 3)
        assert.equal(measurement.backend, "openai")
        assert.equal(measurement.requestedModel, "deepseek-v4-flash")
        assert.deepEqual(measurement.cost.customerUsd, {
            state: "known",
            value: 0,
            source: "cloud_charge",
        })
        assert.deepEqual(measurement.cost.providerUsd, {
            state: "known",
            value: 0.0042,
            source: "gateway_rate_card",
        })
        assert.deepEqual(measurement.cost.equivalentUsd, {
            state: "not_applicable",
        })
        assert.deepEqual(measurement.tokens.cachedInput, {
            state: "known",
            value: 400,
            source: "gateway_receipt",
        })
        assert.equal(measurement.evidence.producer, "cloud")
        assert.equal(Object.isFrozen(measurement.tokens), true)
    })

    it("keeps final unbillable cost unknown instead of manufacturing zero", () => {
        const gateway = createTrustedGatewayIdentity("https://gateway.example")
        const registry = new BillingInvocationRegistry({ trustedGateway: gateway })
        const record = registry.allocate(context)
        const measurement = mapCloudBillingReceipt(
            unbillableReceipt(record.billingSessionId, record.invocationId),
            record,
        )

        assert.deepEqual(measurement.cost.customerUsd, {
            state: "unknown",
            reason: "not_reported",
        })
        assert.deepEqual(measurement.cost.providerUsd, {
            state: "unknown",
            reason: "not_reported",
        })
    })

    it("ignores exact replay and rejects receipt or invocation mutation", () => {
        const gateway = createTrustedGatewayIdentity("https://gateway.example")
        const registry = new BillingInvocationRegistry({ trustedGateway: gateway })
        const record = registry.allocate(context)
        const ledger = new BillingReceiptLedger(registry)
        const receipt = completeReceipt(record.billingSessionId, record.invocationId)

        assert.equal(ledger.ingest(receipt, gateway).state, "accepted")
        assert.deepEqual(ledger.ingest(receipt, gateway), {
            state: "replay",
            receiptId: receipt.receiptId,
        })
        assert.throws(
            () =>
                ledger.ingest(
                    receipt,
                    createTrustedGatewayIdentity("https://evil.example"),
                ),
            BillingInvocationAuthorityError,
        )
        assert.equal(ledger.size, 1)

        const mutated = completeReceipt(record.billingSessionId, record.invocationId, {
            provider: "other-provider",
        })
        assert.throws(
            () => ledger.ingest(mutated, gateway),
            /mutated final data/,
        )

        const conflicting = completeReceipt(record.billingSessionId, record.invocationId, {
            receiptId: "receipt-conflicting",
            chargeId: "charge-conflicting",
        })
        assert.throws(
            () => ledger.ingest(conflicting, gateway),
            BillingReceiptConflictError,
        )
    })
})

describe("authenticated billing cursor feed", () => {
    it("shares Cloud and Gateway's exact page-size bound", () => {
        assert.throws(
            () =>
                new BillingReceiptFeedClient({
                    gatewayBaseUrl: "https://gateway.example/v1",
                    apiKey: "tenant-key",
                    billingSessionId: "session-page-bound",
                    pageSize: 101,
                }),
            /pageSize must be a safe integer from 1 to 100/,
        )
    })

    it("paginates, authenticates, commits after sinks, and ignores ledger replay", async () => {
        const responses = new Map<string, unknown>()
        let expectedSession = ""
        const requests: string[] = []
        const baseUrl = await listen(async (request, response) => {
            assert.equal(request.headers.authorization, "Bearer test-secret")
            const url = new URL(request.url ?? "/", baseUrl)
            assert.equal(url.searchParams.get("session_id"), expectedSession)
            requests.push(url.searchParams.get("after") ?? "initial")
            json(response, 200, responses.get(url.searchParams.get("after") ?? "initial"))
        })
        const gateway = createTrustedGatewayIdentity(baseUrl)
        const registry = new BillingInvocationRegistry({ trustedGateway: gateway })
        expectedSession = registry.billingSessionId
        const first = registry.allocate(context)
        const second = registry.allocate({ ...context, round: 2 })
        const firstReceipt = completeReceipt(expectedSession, first.invocationId)
        const secondReceipt = completeReceipt(expectedSession, second.invocationId)
        responses.set("initial", page(expectedSession, [firstReceipt], "cursor-1", true))
        responses.set("cursor-1", page(expectedSession, [secondReceipt], "cursor-2", false))
        responses.set("cursor-2", page(expectedSession, [firstReceipt], "cursor-3", false))

        const commits: string[] = []
        const client = new BillingReceiptFeedClient({
            gatewayBaseUrl: baseUrl,
            apiKey: "test-secret",
            billingSessionId: expectedSession,
            maxRetries: 0,
            commitCursor: (cursor) => commits.push(cursor),
        })
        const ledger = new BillingReceiptLedger(registry)
        const accepted: string[] = []
        const sink = (receipt: CloudBillingReceipt) => {
            const result = ledger.ingest(receipt, client.trustedGateway)
            if (result.state === "accepted") accepted.push(result.measurement.measurementId)
        }

        const drained = await client.drain(sink)
        assert.deepEqual(drained, {
            pages: 2,
            deliveredReceipts: 2,
            cursor: "cursor-2",
        })
        assert.deepEqual(commits, ["cursor-1", "cursor-2"])
        assert.equal(ledger.size, 2)

        const replay = await client.drain(sink)
        assert.equal(replay.deliveredReceipts, 1)
        assert.equal(client.cursor, "cursor-3")
        assert.equal(ledger.size, 2)
        assert.equal(accepted.length, 2)
        assert.deepEqual(requests, ["initial", "cursor-1", "cursor-2"])
    })

    it("does not advance a cursor until every receipt sink accepts", async () => {
        let expectedSession = ""
        let receipt: CloudBillingReceipt
        const baseUrl = await listen(async (_request, response) => {
            json(response, 200, page(expectedSession, [receipt], "cursor-1", false))
        })
        const registry = new BillingInvocationRegistry({
            trustedGateway: createTrustedGatewayIdentity(baseUrl),
        })
        expectedSession = registry.billingSessionId
        const record = registry.allocate(context)
        receipt = completeReceipt(expectedSession, record.invocationId)
        const client = new BillingReceiptFeedClient({
            gatewayBaseUrl: baseUrl,
            apiKey: "test-secret",
            billingSessionId: expectedSession,
            maxRetries: 0,
        })

        await assert.rejects(client.pull(() => Promise.reject(new Error("persist failed"))))
        assert.equal(client.cursor, null)
        let delivered = 0
        await client.pull(() => {
            delivered += 1
        })
        assert.equal(delivered, 1)
        assert.equal(client.cursor, "cursor-1")
    })

    it("observes a late final receipt on a later drain", async () => {
        let expectedSession = ""
        let late: CloudBillingReceipt | null = null
        const baseUrl = await listen(async (request, response) => {
            const url = new URL(request.url ?? "/", baseUrl)
            assert.equal(url.searchParams.get("session_id"), expectedSession)
            if (url.searchParams.get("after") === null) {
                return json(response, 200, page(expectedSession, [], "cursor-0", false))
            }
            json(
                response,
                200,
                page(expectedSession, late ? [late] : [], late ? "cursor-1" : "cursor-0", false),
            )
        })
        const registry = new BillingInvocationRegistry({
            trustedGateway: createTrustedGatewayIdentity(baseUrl),
        })
        expectedSession = registry.billingSessionId
        const record = registry.allocate(context)
        const client = new BillingReceiptFeedClient({
            gatewayBaseUrl: baseUrl,
            apiKey: "test-secret",
            billingSessionId: expectedSession,
            maxRetries: 0,
        })
        const seen: string[] = []

        assert.equal((await client.drain((receipt) => seen.push(receipt.receiptId))).deliveredReceipts, 0)
        late = completeReceipt(expectedSession, record.invocationId)
        assert.equal((await client.drain((receipt) => seen.push(receipt.receiptId))).deliveredReceipts, 1)
        assert.deepEqual(seen, [late.receiptId])
    })

    it("fails closed on timeout, redirects, foreign sessions, and malformed receipts", async () => {
        const timeoutBase = await listen(async (_request, response) => {
            await new Promise((resolve) => setTimeout(resolve, 100))
            json(response, 200, page("session", [], "cursor", false))
        })
        const timeoutClient = new BillingReceiptFeedClient({
            gatewayBaseUrl: timeoutBase,
            apiKey: "secret",
            billingSessionId: "session",
            timeoutMs: 10,
            maxRetries: 0,
        })
        await assert.rejects(timeoutClient.drain(() => undefined), BillingFeedTimeoutError)

        let redirectTargetHits = 0
        const target = await listen(async (_request, response) => {
            redirectTargetHits += 1
            json(response, 200, page("session", [], "cursor", false))
        })
        const redirectBase = await listen(async (_request, response) => {
            response.writeHead(302, { location: `${target}/v1/billing/receipts` })
            response.end()
        })
        const redirectClient = new BillingReceiptFeedClient({
            gatewayBaseUrl: redirectBase,
            apiKey: "secret",
            billingSessionId: "session",
            maxRetries: 0,
        })
        await assert.rejects(redirectClient.drain(() => undefined))
        assert.equal(redirectTargetHits, 0)

        const foreignBase = await listen(async (_request, response) => {
            json(response, 200, page("foreign", [], "cursor", false))
        })
        const foreignClient = new BillingReceiptFeedClient({
            gatewayBaseUrl: foreignBase,
            apiKey: "secret",
            billingSessionId: "session",
            maxRetries: 0,
        })
        await assert.rejects(
            foreignClient.drain(() => undefined),
            BillingFeedProtocolError,
        )

        const malformedBase = await listen(async (_request, response) => {
            json(response, 200, page("session", [{ schemaVersion: 1 }], "cursor", false))
        })
        const malformedClient = new BillingReceiptFeedClient({
            gatewayBaseUrl: malformedBase,
            apiKey: "secret",
            billingSessionId: "session",
            maxRetries: 0,
        })
        await assert.rejects(
            malformedClient.drain(() => undefined),
            BillingFeedProtocolError,
        )
    })

    it("can be closed without exposing the API key in errors", async () => {
        const client = new BillingReceiptFeedClient({
            gatewayBaseUrl: "https://gateway.example",
            apiKey: "never-print-this-secret",
            billingSessionId: "session",
        })
        client.close()
        await assert.rejects(
            client.drain(() => undefined),
            (error: unknown) => {
                assert.ok(error instanceof BillingFeedClosedError)
                assert.doesNotMatch(error.message, /never-print-this-secret/)
                return true
            },
        )
    })
})

function page(
    billingSessionId: string,
    receipts: readonly unknown[],
    nextCursor: string,
    hasMore: boolean,
): unknown {
    return {
        schemaVersion: 1,
        billingSessionId,
        receipts,
        nextCursor,
        hasMore,
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

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
    })
    response.end(body)
}
