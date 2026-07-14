import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    BARO_JIGJOY_ENV_MARKER,
    harnessChildEnvironment,
} from "../src/harness-environment.js"

describe("subscription harness environment isolation", () => {
    it("removes only Baro-injected JigJoy routing and credentials", () => {
        const parentOpenAiKey = process.env.OPENAI_API_KEY
        const child = harnessChildEnvironment({
            [BARO_JIGJOY_ENV_MARKER]: "1",
            OPENAI_API_KEY: "hosted-run-key",
            OPENAI_BASE_URL: "https://gateway.example/v1",
            JIGJOY_API_KEY: "hosted-run-key",
            BARO_JIGJOY_URL: "https://gateway.example/v1",
            BARO_GATEWAY_BILLING_URL: "https://gateway.example/v1",
            BARO_GATEWAY_BILLING_API_KEY: "hosted-run-key",
            CODEX_HOME: "/subscription/codex",
            ANTHROPIC_API_KEY: "user-owned-claude-value",
            OPENCODE_CONFIG: "/user/opencode.json",
        })

        assert.equal(child.OPENAI_API_KEY, undefined)
        assert.equal(child.OPENAI_BASE_URL, undefined)
        assert.equal(child.JIGJOY_API_KEY, undefined)
        assert.equal(child.BARO_GATEWAY_BILLING_URL, undefined)
        assert.equal(child.BARO_GATEWAY_BILLING_API_KEY, undefined)
        assert.equal(child[BARO_JIGJOY_ENV_MARKER], undefined)
        assert.equal(child.CODEX_HOME, "/subscription/codex")
        assert.equal(child.ANTHROPIC_API_KEY, "user-owned-claude-value")
        assert.equal(child.OPENCODE_CONFIG, "/user/opencode.json")
        assert.equal(process.env.OPENAI_API_KEY, parentOpenAiKey)
    })

    it("preserves ordinary user environment when Baro did not inject it", () => {
        const source = {
            OPENAI_API_KEY: "user-owned-openai-key",
            OPENAI_BASE_URL: "https://user-endpoint.example/v1",
            BARO_GATEWAY_BILLING_URL: "https://explicit-user-gateway.example/v1",
            PATH: "/usr/bin",
        }
        assert.deepEqual(harnessChildEnvironment(source), source)
    })
})
