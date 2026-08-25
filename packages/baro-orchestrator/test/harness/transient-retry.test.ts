import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    DIALOGUE_RETRY_ATTEMPTS_ENV,
    DIALOGUE_RETRY_MAX_WAIT_MS_ENV,
    resolveDialogueRetryPolicy,
} from "../../src/harness/dialogue-retry-policy.js"
import { withTransientRetry } from "../../src/harness/transient-retry.js"

/** The shape the OpenAI SDK throws when a socket dies mid-request. */
function connectionError(): Error {
    const error = new Error("Connection error.")
    error.name = "APIConnectionError"
    error.cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
    return error
}

describe("withTransientRetry", () => {
    it("returns the first successful attempt without waiting", async () => {
        const attempts: number[] = []
        const value = await withTransientRetry(async (attempt) => {
            attempts.push(attempt)
            return "ok"
        })
        assert.equal(value, "ok")
        assert.deepEqual(attempts, [1])
    })

    it("retries a transport failure more than once, waiting longer each time", async () => {
        // Billing correlation disables the provider SDK's retries, so a blip
        // that outlives one short pause would otherwise kill the run.
        const attempts: number[] = []
        const waits: number[] = []
        const value = await withTransientRetry(
            async (attempt) => {
                attempts.push(attempt)
                if (attempt < 3) throw connectionError()
                return "recovered"
            },
            {
                maxAttempts: 3,
                notice: (message) => {
                    const wait = /retrying in (\d+)ms/u.exec(message)?.[1]
                    if (wait) waits.push(Number(wait))
                },
            },
        )
        assert.equal(value, "recovered")
        assert.deepEqual(attempts, [1, 2, 3])
        assert.equal(waits.length, 2)
        // Exponential: a network drop that killed one request usually outlives
        // a linear step, so the second pause must be several times the first.
        assert.ok(
            waits[1]! >= waits[0]! * 3,
            `expected exponential growth, got ${waits.join(" then ")}`,
        )
    })

    it("never waits longer than the caller's cap", async () => {
        const waits: number[] = []
        await assert.rejects(
            withTransientRetry(
                async () => {
                    throw connectionError()
                },
                {
                    maxAttempts: 4,
                    maxWaitMs: 8_000,
                    notice: (message) => {
                        const wait = /retrying in (\d+)ms/u.exec(message)?.[1]
                        if (wait) waits.push(Number(wait))
                    },
                },
            ),
            /Connection error/u,
        )
        assert.equal(waits.length, 3)
        assert.ok(waits.every((wait) => wait <= 8_000), `waits exceeded the cap: ${waits}`)
    })

    it("stops at maxAttempts and rethrows the provider's error", async () => {
        let calls = 0
        await assert.rejects(
            withTransientRetry(
                async () => {
                    calls += 1
                    throw connectionError()
                },
                { maxAttempts: 2 },
            ),
            /Connection error/u,
        )
        assert.equal(calls, 2)
    })

    it("fails closed on a deterministic error without spending a retry", async () => {
        let calls = 0
        await assert.rejects(
            withTransientRetry(async () => {
                calls += 1
                throw new Error("architect contract is invalid")
            }),
            /contract is invalid/u,
        )
        assert.equal(calls, 1)
    })

    it("honors a caller veto even for a transient class", async () => {
        let calls = 0
        await assert.rejects(
            withTransientRetry(
                async () => {
                    calls += 1
                    throw connectionError()
                },
                { maxAttempts: 3, retryable: () => false },
            ),
            /Connection error/u,
        )
        assert.equal(calls, 1)
    })
})

/** A provider cooldown, optionally carrying the provider's own retry-after. */
function capacityError(retryAfterMs?: number): Error {
    return Object.assign(new Error("rate limited"), {
        status: 429,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
}

describe("the dialogue retry policy", () => {
    it("retries a capacity failure to the policy attempt count with growing waits", async () => {
        const waits: number[] = []
        let runCalls = 0
        await assert.rejects(
            withTransientRetry(
                async () => {
                    runCalls += 1
                    throw capacityError()
                },
                {
                    ...resolveDialogueRetryPolicy({}),
                    sleep: async (ms) => {
                        waits.push(ms)
                    },
                },
            ),
            /rate limited/u,
        )
        assert.equal(runCalls, 4)
        assert.deepEqual(waits, [15_000, 45_000, 120_000])
    })

    it("keeps a provider-supplied retry-after as the base, still under the cap", async () => {
        const waits: number[] = []
        await assert.rejects(
            withTransientRetry(
                async () => {
                    throw capacityError(30_000)
                },
                {
                    ...resolveDialogueRetryPolicy({}),
                    sleep: async (ms) => {
                        waits.push(ms)
                    },
                },
            ),
            /rate limited/u,
        )
        // 270_000 on the third wait, capped at the policy ceiling.
        assert.deepEqual(waits, [30_000, 90_000, 120_000])
    })

    it("still fails closed on a deterministic failure at attempt 1", async () => {
        const waits: number[] = []
        let runCalls = 0
        await assert.rejects(
            withTransientRetry(
                async () => {
                    runCalls += 1
                    throw new Error("conversation contract is invalid")
                },
                {
                    ...resolveDialogueRetryPolicy({}),
                    sleep: async (ms) => {
                        waits.push(ms)
                    },
                },
            ),
            /contract is invalid/u,
        )
        assert.equal(runCalls, 1)
        assert.equal(waits.length, 0)
    })

    it("honors the attempt-count and wait-ceiling environment overrides", async () => {
        const policy = resolveDialogueRetryPolicy({
            [DIALOGUE_RETRY_ATTEMPTS_ENV]: "2",
            [DIALOGUE_RETRY_MAX_WAIT_MS_ENV]: "20000",
        })
        assert.deepEqual(policy, {
            maxAttempts: 2,
            maxWaitMs: 20_000,
            fallbackWaitMs: 15_000,
        })
        const waits: number[] = []
        let runCalls = 0
        await assert.rejects(
            withTransientRetry(
                async () => {
                    runCalls += 1
                    throw capacityError()
                },
                {
                    ...policy,
                    sleep: async (ms) => {
                        waits.push(ms)
                    },
                },
            ),
            /rate limited/u,
        )
        assert.equal(runCalls, 2)
        assert.deepEqual(waits, [15_000])
    })

    it("falls back or clamps rather than trusting a hostile environment value", async () => {
        assert.deepEqual(resolveDialogueRetryPolicy({}), {
            maxAttempts: 4,
            maxWaitMs: 120_000,
            fallbackWaitMs: 15_000,
        })
        const attempts = (raw: string): number =>
            resolveDialogueRetryPolicy({ [DIALOGUE_RETRY_ATTEMPTS_ENV]: raw }).maxAttempts
        assert.equal(attempts("abc"), 4)
        assert.equal(attempts(""), 4)
        assert.equal(attempts("2.5"), 4)
        assert.equal(attempts("-1"), 4)
        // Never zero attempts: that would silence the dialogue entirely.
        assert.equal(attempts("0"), 1)
        assert.equal(attempts("999"), 8)
        const ceiling = (raw: string): number =>
            resolveDialogueRetryPolicy({ [DIALOGUE_RETRY_MAX_WAIT_MS_ENV]: raw }).maxWaitMs
        assert.equal(ceiling("abc"), 120_000)
        assert.equal(ceiling("0"), 1_000)
        assert.equal(ceiling("99999999"), 600_000)
        assert.equal(ceiling("45000"), 45_000)
    })
})
