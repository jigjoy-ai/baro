import assert from "node:assert/strict"
import { describe, it } from "node:test"

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
