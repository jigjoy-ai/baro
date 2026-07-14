import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    resolveGatewayBillingForRoutes,
} from "../../src/billing/index.js"
import type { StoryRoute } from "../../src/routing.js"

const gateway = "https://gateway.example/v1"

function resolve(
    routes: readonly StoryRoute[],
    environment: NodeJS.ProcessEnv,
    defaults: { baseUrl?: string; apiKey?: string } = {},
) {
    return resolveGatewayBillingForRoutes({
        routes,
        environment,
        defaultOpenAiBaseUrl: defaults.baseUrl,
        defaultOpenAiApiKey: defaults.apiKey,
    })
}

describe("route-aware Gateway billing activation", () => {
    it("ignores stale billing configuration for subscription harness routes", () => {
        for (const backend of ["claude", "codex", "opencode", "pi"] as const) {
            assert.equal(
                resolve([{ backend }], { BARO_GATEWAY_BILLING_URL: gateway }),
                null,
            )
        }
        assert.equal(
            resolve(
                [{ backend: "claude" }],
                { BARO_GATEWAY_BILLING_URL: "not a URL" },
            ),
            null,
        )
    })

    it("activates a canonically matching global OpenAI route", () => {
        const result = resolve(
            [{ backend: "openai", model: "deepseek-v4-flash" }],
            {
                BARO_GATEWAY_BILLING_URL: `${gateway}/`,
                OPENAI_API_KEY: "route-key",
            },
            { baseUrl: gateway, apiKey: "route-key" },
        )
        assert.deepEqual(result, {
            gatewayBaseUrl: `${gateway}/`,
            apiKey: "route-key",
        })
    })

    it("ignores registered or selected OpenAI endpoints on another origin", () => {
        assert.equal(
            resolve(
                [
                    {
                        backend: "openai",
                        model: "compatible-model",
                        baseUrl: "https://other.example/v1",
                        apiKey: "other-key",
                    },
                ],
                { BARO_GATEWAY_BILLING_URL: gateway },
            ),
            null,
        )
    })

    it("uses a matching named endpoint credential without global leakage", () => {
        assert.deepEqual(
            resolve(
                [
                    {
                        backend: "openai",
                        model: "deepseek-v4-flash",
                        baseUrl: gateway,
                        apiKey: "named-route-key",
                    },
                ],
                { BARO_GATEWAY_BILLING_URL: gateway },
            ),
            { gatewayBaseUrl: gateway, apiKey: "named-route-key" },
        )
    })

    it("fails closed for a matching route without one exact credential", () => {
        assert.throws(
            () =>
                resolve(
                    [{ backend: "openai", baseUrl: gateway }],
                    { BARO_GATEWAY_BILLING_URL: gateway },
                ),
            /requires BARO_GATEWAY_BILLING_API_KEY/,
        )
        assert.throws(
            () =>
                resolve(
                    [
                        {
                            backend: "openai",
                            baseUrl: gateway,
                            apiKey: "route-key",
                        },
                    ],
                    {
                        BARO_GATEWAY_BILLING_URL: gateway,
                        BARO_GATEWAY_BILLING_API_KEY: "different-key",
                    },
                ),
            /does not match the model route credential/,
        )
        assert.throws(
            () =>
                resolve(
                    [
                        { backend: "openai", baseUrl: gateway, apiKey: "first" },
                        { backend: "openai", baseUrl: gateway, apiKey: "second" },
                    ],
                    { BARO_GATEWAY_BILLING_URL: gateway },
                ),
            /multiple credentials/,
        )
    })
})
