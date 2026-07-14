import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
    ModelContext,
    SystemMessageItem,
} from "@mozaik-ai/core"

import {
    GatewayBillingCoordinator,
    type GatewayBillingDrainResult,
} from "../src/billing/index.js"
import type { ModelInvocationMeasuredData } from "../src/model-telemetry.js"
import {
    GenericOpenAIModel,
    runInferenceRound,
} from "../src/planning/openai-runtime.js"

interface ControlPlane {
    readonly port: number
    close(): Promise<void>
}

interface CloudServerModule {
    startControlPlane(options: {
        port: number
        dbFile: string
        pairingFile: string
        cliTokenFile: string
        githubFile: string
        installFile: string
        tenantFile: string
        watchFile: string
        runnersFile: string
        billingFile: string
        devUser: { userId: string }
    }): Promise<ControlPlane>
}

interface GatewayServerModule {
    createGatewayServer(): Server
}

interface CapturedProviderRequest {
    readonly url: string
    readonly authorization: string | undefined
    readonly rawBody: string
    readonly body: Record<string, unknown>
    readonly ledgerBeforeProvider: readonly BillingLedgerEntry[]
}

interface BillingLedgerEntry {
    readonly key: string
    readonly record: Record<string, unknown>
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const baroRepo = resolve(scriptDirectory, "../../..")
const siblingRoot = dirname(baroRepo)
const cloudRepo = resolve(
    process.env.BARO_CLOUD_REPO ?? join(siblingRoot, "baro-cloud"),
)
const gatewayRepo = resolve(
    process.env.BARO_GATEWAY_REPO ?? join(siblingRoot, "baro-gateway"),
)

const signingSecret = "provider-free-e2e-hosted-signing-secret"
const billingSecret = "provider-free-e2e-billing-service-secret"
const tenantId = "tenant-provider-free-e2e"
const environmentKeys = [
    "BARO_GATEWAY_BILLING_SECRET",
    "BILLING_BACKEND_TIMEOUT_MS",
    "BILLING_FINALIZE_MAX_ATTEMPTS",
    "BILLING_FINALIZE_RETRY_BASE_MS",
    "CHARGE_ENABLED",
    "CREDITS_MARKUP",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "ECS_CLUSTER",
    "ECS_SUBNETS",
    "ECS_TASKDEF",
    "ECS_TASK_SG",
    "DYNAMO_TABLE",
    "GATEWAY_HOSTED_KEY",
    "GATEWAY_PUBLIC_ORIGIN",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_B64",
    "JIGJOY_VALIDATE_URL",
    "MEM0_PG_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "PER_RUN_CAP_USD",
    "PLAN_ALLOWANCE_FREE",
    "PLANNER_MODEL",
    "POSTHOG_KEY",
    "PRICE_DEEPSEEK_CACHE_IN",
    "PRICE_DEEPSEEK_IN",
    "PRICE_DEEPSEEK_OUT",
    "PROXY_API_KEY",
    "RATE_CARD_VERSION",
    "RESEND_API_KEY",
    "STORY_MODEL",
] as const

async function main(): Promise<void> {
    const originalEnvironment = new Map(
        environmentKeys.map((key) => [key, process.env[key]]),
    )
    const originalFetch = globalThis.fetch
    const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "baro-authoritative-billing-e2e-"),
    )
    const billingFile = join(temporaryDirectory, "billing-receipts.json")
    const providerRequests: CapturedProviderRequest[] = []
    const measurements: ModelInvocationMeasuredData[] = []
    let providerServer: Server | null = null
    let gatewayServer: Server | null = null
    let cloud: ControlPlane | null = null
    let coordinator: GatewayBillingCoordinator | null = null
    let drain: GatewayBillingDrainResult | null = null

    try {
        configureIsolatedEnvironment()
        globalThis.fetch = loopbackOnlyFetch(originalFetch)

        providerServer = createServer(async (request, response) => {
            try {
                const rawBody = await readBody(request)
                const body = JSON.parse(rawBody) as Record<string, unknown>
                providerRequests.push({
                    url: request.url ?? "",
                    authorization: request.headers.authorization,
                    rawBody,
                    body,
                    ledgerBeforeProvider: readBillingLedger(billingFile),
                })
                if (
                    request.method !== "POST" ||
                    request.url !== "/v1/chat/completions"
                ) {
                    return sendJson(response, 404, {
                        error: "unexpected provider route",
                    })
                }
                return sendJson(response, 200, {
                    id: "provider-free-response-1",
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
                        prompt_tokens: 100,
                        prompt_cache_hit_tokens: 40,
                        completion_tokens: 20,
                        total_tokens: 120,
                    },
                })
            } catch (error) {
                return sendJson(response, 500, {
                    error: error instanceof Error ? error.message : "provider error",
                })
            }
        })
        const providerPort = await listen(providerServer)
        process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`
        process.env.OPENAI_BASE_URL = `http://127.0.0.1:${providerPort}/v1`
        process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${providerPort}/v1`

        const cloudServerModule = (await importLocalModule(
            join(cloudRepo, "src/server.ts"),
        )) as CloudServerModule
        cloud = await cloudServerModule.startControlPlane({
            port: 0,
            dbFile: join(temporaryDirectory, "runs.json"),
            pairingFile: join(temporaryDirectory, "pairing.json"),
            cliTokenFile: join(temporaryDirectory, "cli-tokens.json"),
            githubFile: join(temporaryDirectory, "github.json"),
            installFile: join(temporaryDirectory, "installs.json"),
            tenantFile: join(temporaryDirectory, "tenants.json"),
            watchFile: join(temporaryDirectory, "watches.json"),
            runnersFile: join(temporaryDirectory, "runners.json"),
            billingFile,
            devUser: { userId: tenantId },
        })
        const cloudBaseUrl = `http://127.0.0.1:${cloud.port}`
        process.env.JIGJOY_VALIDATE_URL = cloudBaseUrl
        const issued = await issueLoginBackedGatewayCredential(cloudBaseUrl)
        const runId = issued.runId
        const gatewayKey = issued.apiKey
        assert.match(gatewayKey, /^gk_v1\./)
        assert.equal(issued.gatewayBaseUrl, "https://gw.baro.jigjoy.ai/v1")

        const gatewayModule = (await importLocalModule(
            join(gatewayRepo, "src/server.mjs"),
        )) as GatewayServerModule
        gatewayServer = gatewayModule.createGatewayServer()
        const gatewayPort = await listen(gatewayServer)
        const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/v1`

        coordinator = new GatewayBillingCoordinator({
            runId,
            gatewayBaseUrl,
            apiKey: gatewayKey,
            drainTimeoutMs: 3_000,
            feedTimeoutMs: 1_000,
            feedMaxRetries: 0,
            publishMeasurement: (measurement) => {
                measurements.push(measurement)
            },
        })
        const model = new GenericOpenAIModel("deepseek-v4-flash", {
            baseURL: gatewayBaseUrl,
            apiKey: gatewayKey,
        })
        model.setTools([])

        const round = await runInferenceRound(
            ModelContext.create("provider-free-billing-e2e").addContextItem(
                SystemMessageItem.create("Reply with ok."),
            ),
            model,
            {
                billing: {
                    coordinator,
                    context: {
                        runId,
                        phase: "story",
                        storyId: "S-e2e",
                        leaseId: "lease-e2e",
                        generation: 1,
                        attempt: 1,
                        turn: 1,
                        round: 1,
                    },
                },
            },
        )
        const ledgerAfterRound = readBillingLedger(billingFile)
        drain = await coordinator.drain()

        assert.ok(round.billingInvocationId, "Baro allocated billing correlation")
        assert.equal(providerRequests.length, 1, "exactly one provider request")
        assert.equal(providerRequests[0].url, "/v1/chat/completions")
        assert.equal(
            providerRequests[0].authorization,
            "Bearer fake-deepseek-provider-key",
        )
        assert.equal(
            Object.hasOwn(providerRequests[0].body, "_baro_billing"),
            false,
            "gateway stripped private billing metadata",
        )
        assert.equal(providerRequests[0].body.model, "deepseek-v4-flash")
        const reservation = providerRequests[0].ledgerBeforeProvider.find(
            ({ record }) => record.kind === "reserved",
        )?.record
        assert.ok(reservation, "Cloud persisted reservation before provider dispatch")
        assert.equal(reservation.billingSessionId, coordinator.billingSessionId)
        assert.equal(reservation.invocationId, round.billingInvocationId)
        assert.equal(
            reservation.requestHash,
            providerRequestHash(
                "/v1/chat/completions",
                Buffer.from(providerRequests[0].rawBody, "utf8"),
            ),
        )

        const finalRecord = ledgerAfterRound.find(
            ({ record }) =>
                record.kind === "final" &&
                record.invocationId === round.billingInvocationId,
        )?.record
        assert.ok(finalRecord, "Cloud finalized before Gateway returned the model response")
        assert.equal(finalRecord.requestHash, reservation.requestHash)
        assert.equal(typeof finalRecord.canonicalJson, "string")
        const publicReceipt = JSON.parse(finalRecord.canonicalJson) as Record<
            string,
            unknown
        >
        assert.equal(Object.hasOwn(publicReceipt, "requestHash"), false)
        assert.deepEqual(publicReceipt.attribution, { tenantId, runId })
        assert.deepEqual(publicReceipt.tokens, {
            inputTotal: 100,
            cachedInput: 40,
            cacheWriteInput: 0,
            outputTotal: 20,
            reasoningOutput: 0,
            total: 120,
        })
        assert.deepEqual(publicReceipt.providerCost, {
            currency: "USD",
            amount: "14112",
            scale: 9,
        })
        assert.deepEqual(publicReceipt.customerCost, {
            currency: "USD",
            amount: "28224",
            scale: 9,
        })
        assert.equal(drain.complete, true)
        assert.equal(drain.registeredInvocations, 1)
        assert.equal(drain.settledInvocations, 1)
        assert.deepEqual(drain.unresolvedInvocationIds, [])

        const runnerMeasurement = measurements.find(
            (measurement) => measurement.evidence.producer === "runner",
        )
        const cloudMeasurement = measurements.find(
            (measurement) => measurement.evidence.producer === "cloud",
        )
        assert.ok(runnerMeasurement, "runner measurement was published")
        assert.ok(cloudMeasurement, "Cloud receipt measurement was published")
        assert.equal(cloudMeasurement.invocationId, round.billingInvocationId)
        assert.deepEqual(cloudMeasurement.tokens.inputTotal, {
            state: "known",
            value: 100,
            source: "gateway_receipt",
        })
        assert.deepEqual(cloudMeasurement.cost.providerUsd, {
            state: "known",
            value: 0.000014112,
            source: "gateway_rate_card",
        })
        assert.deepEqual(cloudMeasurement.cost.customerUsd, {
            state: "known",
            value: 0.000028224,
            source: "cloud_charge",
        })

        const usageResponse = await fetch(`${cloudBaseUrl}/account/usage`)
        assert.equal(usageResponse.status, 200)
        const usage = (await usageResponse.json()) as {
            calls: number
            spentUsd: number
        }
        assert.equal(usage.calls, 1)
        assert.equal(usage.spentUsd, 0.000028224)

        const authorization = {
            authorization: `Bearer ${gatewayKey}`,
            "content-type": "application/json",
        }
        const providerCallsAfterBaro = providerRequests.length
        const missingCorrelation = await fetch(
            `${gatewayBaseUrl}/chat/completions`,
            {
                method: "POST",
                headers: authorization,
                body: JSON.stringify({
                    model: "deepseek-v4-flash",
                    messages: [{ role: "user", content: "must fail closed" }],
                }),
            },
        )
        assert.equal(missingCorrelation.status, 400)
        await missingCorrelation.body?.cancel()
        assert.equal(providerRequests.length, providerCallsAfterBaro)

        const unknownRateCard = await fetch(
            `${gatewayBaseUrl}/chat/completions`,
            {
                method: "POST",
                headers: authorization,
                body: JSON.stringify({
                    model: "deepseek-future-expensive",
                    messages: [{ role: "user", content: "must fail closed" }],
                    _baro_billing: billingExtension(
                        "session-unknown-model",
                        "invocation-unknown-model",
                    ),
                }),
            },
        )
        assert.equal(unknownRateCard.status, 400)
        await unknownRateCard.body?.cancel()
        assert.equal(providerRequests.length, providerCallsAfterBaro)

        const duplicateInvocation = await fetch(
            `${gatewayBaseUrl}/chat/completions`,
            {
                method: "POST",
                headers: authorization,
                body: JSON.stringify({
            model: "deepseek-v4-flash",
                    messages: [{ role: "user", content: "duplicate invocation" }],
            _baro_billing: billingExtension(
                        coordinator.billingSessionId,
                        round.billingInvocationId,
            ),
                }),
            },
        )
        assert.equal(duplicateInvocation.status, 409)
        await duplicateInvocation.body?.cancel()
        assert.equal(
            providerRequests.length,
            providerCallsAfterBaro,
            "durable reserve rejected replay before a second provider call",
        )

        const usageAfterReplay = (await (
            await fetch(`${cloudBaseUrl}/account/usage`)
        ).json()) as { calls: number; spentUsd: number }
        assert.equal(usageAfterReplay.calls, 1)
        assert.equal(usageAfterReplay.spentUsd, 0.000028224)

        console.log(
            JSON.stringify(
                {
                    ok: true,
                    backend: "local Baro Cloud + local Baro Gateway + fake DeepSeek",
                    credential: "Cloud-issued gk_v1 via cli_ login exchange",
                    runId,
                    providerCalls: providerRequests.length,
                    baroProviderCalls: providerCallsAfterBaro,
                    duplicateInvocationProviderCalls: 0,
                    missingCorrelationProviderCalls: 0,
                    unknownRateCardProviderCalls: 0,
                    registeredInvocations: drain.registeredInvocations,
                    settledInvocations: drain.settledInvocations,
                    providerUsd: cloudMeasurement.cost.providerUsd,
                    customerUsd: cloudMeasurement.cost.customerUsd,
                    externalNetworkAllowed: false,
                },
                null,
                2,
            ),
        )
    } finally {
        coordinator?.close()
        await closeServer(gatewayServer)
        await cloud?.close().catch(() => undefined)
        await closeServer(providerServer)
        globalThis.fetch = originalFetch
        for (const [key, value] of originalEnvironment) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        rmSync(temporaryDirectory, { recursive: true, force: true })
    }
}

function configureIsolatedEnvironment(): void {
    Object.assign(process.env, {
        BARO_GATEWAY_BILLING_SECRET: billingSecret,
        BILLING_BACKEND_TIMEOUT_MS: "1000",
        BILLING_FINALIZE_MAX_ATTEMPTS: "1",
        BILLING_FINALIZE_RETRY_BASE_MS: "0",
        CHARGE_ENABLED: "true",
        CREDITS_MARKUP: "2",
        DEEPSEEK_API_KEY: "fake-deepseek-provider-key",
        DYNAMO_TABLE: "",
        ECS_CLUSTER: "",
        ECS_SUBNETS: "",
        ECS_TASKDEF: "",
        ECS_TASK_SG: "",
        GATEWAY_HOSTED_KEY: signingSecret,
        GATEWAY_PUBLIC_ORIGIN: "https://gw.baro.jigjoy.ai",
        GITHUB_APP_ID: "",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_PRIVATE_KEY_B64: "",
        MEM0_PG_URL: "",
        OPENAI_API_KEY: "fake-openai-provider-key",
        OPENROUTER_API_KEY: "fake-openrouter-provider-key",
        PER_RUN_CAP_USD: "1",
        PLAN_ALLOWANCE_FREE: "1",
        PLANNER_MODEL: "gpt-5.5",
        POSTHOG_KEY: "",
        PRICE_DEEPSEEK_CACHE_IN: "0.0028",
        PRICE_DEEPSEEK_IN: "0.14",
        PRICE_DEEPSEEK_OUT: "0.28",
        PROXY_API_KEY: signingSecret,
        RATE_CARD_VERSION: "provider-free-e2e-rate-card-v1",
        RESEND_API_KEY: "",
        STORY_MODEL: "deepseek-v4-flash",
    })
}

async function issueLoginBackedGatewayCredential(cloudBaseUrl: string): Promise<{
    runId: string
    gatewayBaseUrl: string
    apiKey: string
}> {
    const started = await fetch(`${cloudBaseUrl}/cli/auth/start`, { method: "POST" })
    assert.equal(started.status, 200)
    const device = (await started.json()) as { deviceCode: string; userCode: string }
    const approved = await fetch(`${cloudBaseUrl}/cli/auth/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: device.userCode }),
    })
    assert.equal(approved.status, 200)
    const polled = await fetch(
        `${cloudBaseUrl}/cli/auth/poll?deviceCode=${encodeURIComponent(device.deviceCode)}`,
    )
    assert.equal(polled.status, 200)
    const login = (await polled.json()) as { status: string; token: string }
    assert.equal(login.status, "approved")
    assert.match(login.token, /^cli_/)

    const response = await fetch(`${cloudBaseUrl}/cli/gateway/credentials`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${login.token}`,
            "content-type": "application/json",
        },
        // Authority-bearing caller fields must be ignored by the issuer.
        body: JSON.stringify({
            tenant: "attacker",
            runId: "run-attacker",
            scope: ["admin"],
            ttlSecs: 999_999,
        }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("cache-control") ?? "", /no-store/)
    const issued = (await response.json()) as {
        schemaVersion: number
        runId: string
        gatewayBaseUrl: string
        apiKey: string
        expiresAt: string
    }
    assert.equal(issued.schemaVersion, 1)
    assert.match(issued.runId, /^run-local-[a-f0-9]{32}$/)
    assert.equal(Number.isFinite(Date.parse(issued.expiresAt)), true)
    assert.doesNotMatch(issued.apiKey, /attacker|admin/)
    return issued
}

function loopbackOnlyFetch(originalFetch: typeof fetch): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const rawUrl =
            input instanceof Request
                ? input.url
                : input instanceof URL
                  ? input.toString()
                  : input
        const url = new URL(rawUrl)
        if (!isLoopback(url.hostname)) {
            throw new Error(`provider-free E2E blocked external HTTP request to ${url.origin}`)
        }
        return originalFetch(input, init)
    }) as typeof fetch
}

function isLoopback(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
    return (
        normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1"
    )
}

function billingExtension(sessionId: string, invocationId: string) {
    return {
        schema_version: 1,
        session_id: sessionId,
        invocation_id: invocationId,
    }
}

function providerRequestHash(pathAndQuery: string, body: Buffer): string {
    return createHash("sha256")
        .update("baro-billing-request-v1\n", "utf8")
        .update("POST\n", "utf8")
        .update(pathAndQuery, "utf8")
        .update("\napplication/json\n", "utf8")
        .update(body)
        .digest("hex")
}

function readBillingLedger(path: string): readonly BillingLedgerEntry[] {
    if (!existsSync(path)) return []
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!Array.isArray(value)) throw new Error("Cloud billing ledger is not an array")
    return value.map((entry) => {
        if (
            !entry ||
            typeof entry !== "object" ||
            typeof (entry as { key?: unknown }).key !== "string" ||
            !(entry as { record?: unknown }).record ||
            typeof (entry as { record?: unknown }).record !== "object"
        ) {
            throw new Error("Cloud billing ledger contains a malformed entry")
        }
        return entry as BillingLedgerEntry
    })
}

async function importLocalModule(path: string): Promise<unknown> {
    return import(pathToFileURL(path).href)
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
        throw new Error("local test server did not expose a TCP port")
    }
    return address.port
}

async function closeServer(server: Server | null): Promise<void> {
    if (!server?.listening) return
    await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise())
        server.closeIdleConnections?.()
    })
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString("utf8")
}

function sendJson(
    response: import("node:http").ServerResponse,
    status: number,
    body: unknown,
): void {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
}

await main()
