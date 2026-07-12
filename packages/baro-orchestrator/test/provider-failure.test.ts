import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    classifyProviderFailure,
    compactProviderFailureDetail,
    isProviderCapacityFailure,
} from "../src/provider-failure.js"

describe("provider failure classification", () => {
    it("prefers structured HTTP status and parses retry-after headers", () => {
        assert.deepEqual(
            classifyProviderFailure({
                status: 429,
                headers: { "retry-after": "3" },
                message: "request failed",
            }),
            {
                kind: "provider_capacity",
                code: "rate_limited",
                retryAfterMs: 3_000,
            },
        )
    })

    it("recognizes nested provider codes without broad message matching", () => {
        assert.deepEqual(
            classifyProviderFailure({
                status: 400,
                error: {
                    type: "invalid_request_error",
                    code: "insufficient_quota",
                    message: "account cannot serve this request",
                },
            }),
            { kind: "provider_capacity", code: "quota_exhausted" },
        )
        assert.equal(
            classifyProviderFailure(new Error("repository quota.ts test failed")),
            undefined,
        )
    })

    it("does not mistake Claude's allowed informational limit frame for exhaustion", () => {
        assert.equal(
            classifyProviderFailure({
                type: "rate_limit_event",
                rate_limit_info: {
                    status: "allowed",
                    rateLimitType: "five_hour",
                    overageStatus: "rejected",
                    overageDisabledReason: "out_of_credits",
                },
            }),
            undefined,
        )
    })

    it("classifies Claude's rejected session frame and carries reset timing", () => {
        const result = classifyProviderFailure({
            type: "rate_limit_event",
            rate_limit_info: {
                status: "rejected",
                rateLimitType: "five_hour",
                resetsAt: Math.floor(Date.now() / 1000) + 60,
                overageDisabledReason: "out_of_credits",
            },
        })

        assert.equal(result?.kind, "provider_capacity")
        assert.equal(result?.code, "session_limit")
        assert.ok((result?.retryAfterMs ?? 0) > 50_000)
        assert.ok((result?.retryAfterMs ?? 0) <= 60_000)
    })

    it("recognizes bounded terminal-message fallbacks", () => {
        assert.deepEqual(
            classifyProviderFailure("You've hit your session limit · resets 3:30pm"),
            { kind: "provider_capacity", code: "session_limit" },
        )
        assert.deepEqual(classifyProviderFailure("model is overloaded"), {
            kind: "provider_capacity",
            code: "overloaded",
        })
        assert.equal(classifyProviderFailure("ordinary execution failed"), undefined)
    })

    it("only treats explicitly structured results as capacity in policy code", () => {
        assert.equal(
            isProviderCapacityFailure({
                success: false,
                error: "You've hit your session limit",
            }),
            false,
        )
        assert.equal(
            isProviderCapacityFailure({
                success: false,
                failure: { kind: "provider_capacity", code: "session_limit" },
            }),
            true,
        )
        assert.equal(
            isProviderCapacityFailure({
                data: { failure: { kind: "provider_capacity" } },
            }),
            true,
        )
    })

    it("safely inspects cyclic SDK errors", () => {
        const error: Record<string, unknown> = {
            status: 429,
            message: "too many requests",
        }
        error.cause = error
        error.response = { error }

        assert.deepEqual(classifyProviderFailure(error), {
            kind: "provider_capacity",
            code: "rate_limited",
        })
    })

    it("never serializes opaque request metadata into diagnostics", () => {
        const signal = {
            status: 429,
            headers: { authorization: "Bearer super-secret" },
            request: { apiKey: "sk-super-secret" },
        }

        assert.deepEqual(classifyProviderFailure(signal), {
            kind: "provider_capacity",
            code: "rate_limited",
        })
        assert.equal(compactProviderFailureDetail(signal), "")
    })

    it("does not let a hostile headers accessor mask the original failure", () => {
        const headers = {
            get(): never {
                throw new Error("headers unavailable")
            },
        }
        assert.deepEqual(classifyProviderFailure({ status: 429, headers }), {
            kind: "provider_capacity",
            code: "rate_limited",
        })
    })

    it("reads retry timing from a Headers-like accessor", () => {
        const headers = {
            get(name: string): string | null {
                return name === "retry-after" ? "2" : null
            },
        }
        assert.deepEqual(classifyProviderFailure({ status: 429, headers }), {
            kind: "provider_capacity",
            code: "rate_limited",
            retryAfterMs: 2_000,
        })
    })

    it("compacts untrusted diagnostics to a fixed bound", () => {
        const detail = compactProviderFailureDetail(
            `  quota   exhausted ${"diagnostic ".repeat(100)}`,
            80,
        )
        assert.equal(detail.length, 80)
        assert.ok(detail.startsWith("quota exhausted diagnostic"))
        assert.ok(detail.endsWith("…"))
    })
})
