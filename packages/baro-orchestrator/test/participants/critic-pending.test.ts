import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { drainCriticPending } from "../../src/participants/critic-pending.js"

describe("drainCriticPending", () => {
    it("waits for work enqueued while the first pending snapshot settles", async () => {
        const pending = new Set<Promise<void>>()
        const first = deferred()
        const second = deferred()
        let secondSettled = false

        track(pending, first.promise)
        const barrier = drainCriticPending(pending)

        // Simulate a Critic event emitted by the first evaluation spawning a
        // second evaluation before the first promise leaves the pending set.
        track(
            pending,
            second.promise.then(() => {
                secondSettled = true
            }),
        )
        first.resolve()
        await first.promise
        await new Promise<void>((resolve) => setImmediate(resolve))

        let barrierSettled = false
        void barrier.then(() => {
            barrierSettled = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(barrierSettled, false)

        second.resolve()
        await barrier
        assert.equal(secondSettled, true)
        assert.equal(pending.size, 0)
    })
})

function track(pending: Set<Promise<void>>, promise: Promise<void>): void {
    pending.add(promise)
    void promise.finally(() => {
        pending.delete(promise)
    })
}

function deferred(): {
    promise: Promise<void>
    resolve(): void
} {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
