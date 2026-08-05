import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    CooperativeSuspension,
    laneQuiescenceWitness,
    settledWithinBound,
} from "../../src/harness/cooperative-suspension.js"

const sleep = (ms: number): Promise<void> =>
    new Promise((res) => setTimeout(res, ms))

function summary() {
    return { attempts: 2, durationSecs: 7 }
}

describe("a suspension resolves only against a witness", () => {
    it("returns the summary when the lane certifies quiescence", async () => {
        const suspension = new CooperativeSuspension("S4", async () => true, 50)
        assert.deepEqual(await suspension.request("block-1", summary), {
            attempts: 2,
            durationSecs: 7,
        })
    })

    it("refuses by name when the lane cannot certify", async () => {
        const suspension = new CooperativeSuspension("S4", async () => false, 50)
        await assert.rejects(
            suspension.request("block-1", summary),
            /S4 quiescence could not be certified for dependency block block-1/,
        )
    })

    it("never hands back a summary the host would read as a certificate", async () => {
        let built = 0
        const suspension = new CooperativeSuspension("S4", async () => false, 50)
        await suspension
            .request("block-1", () => {
                built++
                return summary()
            })
            .catch(() => undefined)
        assert.equal(built, 0, "the summary is not even built on a refusal")
    })
})

describe("a story suspends for one block at a time", () => {
    it("blocks new work the moment the request is recorded", async () => {
        const suspension = new CooperativeSuspension("S4", async () => true, 50)
        assert.equal(suspension.blocksNewWork, false)
        const pending = suspension.request("block-1", summary)
        assert.equal(
            suspension.blocksNewWork,
            true,
            "recorded synchronously, so no work can slip in behind the await",
        )
        await pending
    })

    it("accepts the same block twice and refuses a second one", async () => {
        const suspension = new CooperativeSuspension("S4", async () => true, 50)
        await suspension.request("block-1", summary)
        await suspension.request("block-1", summary)
        await assert.rejects(
            suspension.request("block-2", summary),
            /already suspending for block block-1/,
        )
    })

    it("rejects a blockId that is not a trimmed non-empty string", async () => {
        const suspension = new CooperativeSuspension("S4", async () => true, 50)
        for (const bad of ["", " ", " block-1", "block-1 "]) {
            await assert.rejects(
                suspension.request(bad, summary),
                TypeError,
                `expected ${JSON.stringify(bad)} to be refused`,
            )
        }
    })

    it("reads as a cooperated decision, not a failure", () => {
        const suspension = new CooperativeSuspension("S4", async () => true, 50)
        void suspension.request("block-9", summary)
        assert.equal(
            suspension.outcomeText,
            "suspended on dependency block block-9",
        )
    })
})

describe("the in-process witness", () => {
    it("certifies once every in-flight invocation settles", async () => {
        const inFlight = new Set<Promise<unknown>>()
        const slow = sleep(10)
        inFlight.add(slow)
        void slow.then(() => inFlight.delete(slow))

        assert.equal(
            await settledWithinBound(() => [...inFlight], 500),
            true,
        )
    })

    it("refuses rather than guessing when one never settles", async () => {
        const never = new Promise<void>(() => {})
        assert.equal(
            await settledWithinBound(() => [never], 30),
            false,
        )
    })

    it("certifies immediately when nothing is running", async () => {
        assert.equal(await settledWithinBound(() => [], 0), true)
    })

    it("counts a rejected invocation as settled — it stopped writing either way", async () => {
        const failed = Promise.reject(new Error("tool blew up"))
        failed.catch(() => undefined)
        assert.equal(
            await settledWithinBound(() => [failed], 100),
            true,
        )
    })
})

describe("which witness a lane brings", () => {
    it("lets a lane that owns its own loop prove quiescence itself", () => {
        assert.equal(laneQuiescenceWitness("openai"), "self")
    })

    it("borrows the operating system for lanes that spawn a process", () => {
        for (const backend of ["claude", "codex", "opencode", "pi"]) {
            assert.equal(laneQuiescenceWitness(backend), "process")
        }
    })
})
