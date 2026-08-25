import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    StreamingTurnLifecycle,
    TurnReviewMailbox,
    type StreamingTurnLifecycleOptions,
    type TurnReviewFailure,
} from "../../src/acceptance/turn-review.js"
import type { CritiqueData } from "../../src/semantic-events.js"

function critique(overrides: Partial<CritiqueData> = {}): CritiqueData {
    return {
        agentId: "S1",
        terminalId: "t-1",
        status: "evaluated",
        verdict: "fail",
        reasoning: "the candidate still misses an acceptance criterion",
        violatedCriteria: ["[O-001]"],
        turn: 1,
        modelUsed: "test",
        ...overrides,
    }
}

interface SupersedeEvent {
    supersededTerminalId: string
    terminalId: string
    turnsObserved: number
}

interface Harness {
    lifecycle: StreamingTurnLifecycle
    finishes: number
    revisions: Array<{ feedback: string; review: CritiqueData }>
    supersessions: SupersedeEvent[]
}

function harness(
    overrides: Partial<StreamingTurnLifecycleOptions> = {},
): Harness {
    const state = {
        finishes: 0,
        revisions: [] as Array<{ feedback: string; review: CritiqueData }>,
        supersessions: [] as SupersedeEvent[],
    }
    const lifecycle = new StreamingTurnLifecycle({
        requiresReview: true,
        maxTurns: 5,
        quietTimeoutMs: 60_000,
        reviewTimeoutMs: 60_000,
        onFinish: () => {
            state.finishes++
        },
        onRevision: (feedback, review) => {
            state.revisions.push({ feedback, review })
        },
        onSupersede: (event) => {
            state.supersessions.push({ ...event })
        },
        revisionFailure: (error): TurnReviewFailure => ({
            error: String(error),
            failure: { kind: "infrastructure", code: "process_spawn_failed" },
        }),
        ...overrides,
    })
    return {
        lifecycle,
        get finishes() {
            return state.finishes
        },
        get revisions() {
            return state.revisions
        },
        get supersessions() {
            return state.supersessions
        },
    } as Harness
}

/** Review delivery resolves through a promise chain, never synchronously. */
function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

describe("the latest terminal candidate wins the pending review wait", () => {
    it("switches the wait to the newer terminal instead of failing the story", async () => {
        const h = harness()
        h.lifecycle.observeResult("t-1")
        h.lifecycle.observeResult("t-2")

        assert.equal(h.lifecycle.failure(), null)
        assert.deepEqual(h.supersessions, [
            {
                supersededTerminalId: "t-1",
                terminalId: "t-2",
                turnsObserved: 2,
            },
        ])
        assert.deepEqual(h.lifecycle.supersededTerminals(), ["t-1"])

        h.lifecycle.deliverReview(critique({ terminalId: "t-2" }))
        await tick()

        assert.equal(h.lifecycle.failure(), null)
        assert.equal(h.revisions.length, 1)
        assert.equal(h.revisions[0]!.review.terminalId, "t-2")
        assert.equal(h.finishes, 0)
        h.lifecycle.cancel()
    })

    it("lets a passing verdict for the newest terminal finish the turn", async () => {
        const h = harness()
        h.lifecycle.observeResult("t-1")
        h.lifecycle.observeResult("t-2")
        h.lifecycle.deliverReview(
            critique({ terminalId: "t-2", verdict: "pass" }),
        )
        await tick()

        assert.equal(h.lifecycle.failure(), null)
        assert.equal(h.finishes, 1)
        assert.equal(h.revisions.length, 0)
    })

    it("ignores a late verdict for the superseded terminal", async () => {
        const h = harness()
        h.lifecycle.observeResult("t-1")
        h.lifecycle.observeResult("t-2")

        h.lifecycle.deliverReview(critique({ terminalId: "t-1" }))
        await tick()

        assert.equal(h.lifecycle.failure(), null)
        assert.equal(h.revisions.length, 0)
        assert.equal(h.finishes, 0)

        h.lifecycle.deliverReview(
            critique({ terminalId: "t-2", verdict: "pass" }),
        )
        await tick()

        assert.equal(h.lifecycle.failure(), null)
        assert.equal(h.finishes, 1)
        assert.equal(h.revisions.length, 0)
    })

    it("keeps reporting a supersession when the host callback throws", async () => {
        const h = harness({
            onSupersede: () => {
                throw new Error("reporting blew up")
            },
        })
        h.lifecycle.observeResult("t-1")
        h.lifecycle.observeResult("t-2")

        assert.equal(h.lifecycle.failure(), null)
        assert.deepEqual(h.lifecycle.supersededTerminals(), ["t-1"])

        h.lifecycle.deliverReview(
            critique({ terminalId: "t-2", verdict: "pass" }),
        )
        await tick()

        assert.equal(h.lifecycle.failure(), null)
        assert.equal(h.finishes, 1)
    })

    it("still refuses a terminal without a stable identity", () => {
        for (const missing of [null, ""] as Array<string | null>) {
            const h = harness()
            h.lifecycle.observeResult(missing)
            assert.deepEqual(h.lifecycle.failure(), {
                error: "quality review requires a stable terminal turn identity",
                failure: {
                    kind: "infrastructure",
                    code: "review_uncorrelated",
                },
            })
            assert.deepEqual(h.lifecycle.supersededTerminals(), [])
            assert.equal(h.supersessions.length, 0)
        }
    })

    it("drops a queued verdict for a discarded terminal", async () => {
        const mailbox = new TurnReviewMailbox()
        mailbox.deliver(critique({ terminalId: "t-1" }))
        mailbox.discard("t-1")

        const wait = mailbox.waitFor("t-1", { timeoutMs: 60_000 })
        await tick()
        mailbox.cancelActive()

        assert.deepEqual(await wait, { kind: "cancelled" })
    })
})
