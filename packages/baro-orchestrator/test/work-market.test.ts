import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    expectedVerifiedCostUsd,
    isValidWorkBidEstimate,
    selectWorkBid,
    type WorkBidCandidate,
    type WorkBidEstimate,
} from "../src/work-market.js"

describe("work market", () => {
    it("validates finite non-negative cost and latency plus 0 < p <= 1", () => {
        assert.equal(isValidWorkBidEstimate(estimate(1, 0.8, 100)), true)
        assert.equal(isValidWorkBidEstimate(estimate(0, 1, 0)), true)

        for (const invalid of [
            estimate(-1, 0.8, 100),
            estimate(Number.NaN, 0.8, 100),
            estimate(Number.POSITIVE_INFINITY, 0.8, 100),
            estimate(1, 0, 100),
            estimate(1, -0.1, 100),
            estimate(1, 1.01, 100),
            estimate(1, Number.NaN, 100),
            estimate(1, Number.POSITIVE_INFINITY, 100),
            estimate(1, 0.8, -1),
            estimate(1, 0.8, Number.NaN),
            estimate(1, 0.8, Number.POSITIVE_INFINITY),
        ]) {
            assert.equal(isValidWorkBidEstimate(invalid), false)
        }
    })

    it("ranks by expected cost per verified success", () => {
        const lowStickerPrice = bid("worker-a", "bid-a", 1, 0.5, 20)
        const betterVerifiedCost = bid("worker-b", "bid-b", 1.2, 0.8, 30)

        assert.equal(expectedVerifiedCostUsd(lowStickerPrice.estimate), 2)
        assert.ok(
            Math.abs(expectedVerifiedCostUsd(betterVerifiedCost.estimate) - 1.5) <=
                Number.EPSILON,
        )
        assert.equal(
            selectWorkBid([lowStickerPrice, betterVerifiedCost]),
            betterVerifiedCost,
        )
    })

    it("applies minimum-success, maximum-cost, and maximum-latency constraints", () => {
        const lowSuccess = bid("low-success", "b1", 0.1, 0.5, 20)
        const tooExpensive = bid("expensive", "b2", 3, 0.95, 20)
        const tooSlow = bid("slow", "b3", 0.5, 0.95, 2_000)
        const eligible = bid("eligible", "b4", 1, 0.9, 500)

        assert.equal(
            selectWorkBid(
                [lowSuccess, tooExpensive, tooSlow, eligible],
                {
                    minSuccessProbability: 0.8,
                    maxCostUsd: 2,
                    maxLatencyMs: 1_000,
                },
            ),
            eligible,
        )
    })

    it("uses latency, higher success, worker id, and bid id as deterministic ties", () => {
        const slower = bid("worker-z", "bid-z", 1, 0.5, 20)
        const faster = bid("worker-y", "bid-y", 1, 0.5, 10)
        assert.equal(selectWorkBid([slower, faster]), faster)

        const lowerSuccess = bid("worker-z", "bid-z", 1, 0.5, 10)
        const higherSuccess = bid("worker-y", "bid-y", 1.6, 0.8, 10)
        assert.equal(selectWorkBid([lowerSuccess, higherSuccess]), higherSuccess)

        const laterWorker = bid("worker-b", "bid-a", 1, 0.5, 10)
        const earlierWorker = bid("worker-a", "bid-z", 1, 0.5, 10)
        assert.equal(selectWorkBid([laterWorker, earlierWorker]), earlierWorker)

        const laterBid = bid("worker-a", "bid-b", 1, 0.5, 10)
        const earlierBid = bid("worker-a", "bid-a", 1, 0.5, 10)
        assert.equal(selectWorkBid([laterBid, earlierBid]), earlierBid)
    })

    it("returns the same winner for every input permutation", () => {
        const candidates = [
            bid("worker-d", "bid-d", 2, 0.8, 100),
            bid("worker-b", "bid-b", 1, 0.8, 90),
            bid("worker-c", "bid-c", 0.9, 0.6, 80),
            bid("worker-a", "bid-a", 1, 0.8, 90),
        ]

        for (const ordering of permutations(candidates)) {
            assert.equal(selectWorkBid(ordering)?.bidId, "bid-a")
        }
    })

    it("ignores invalid bids and returns null when none are eligible", () => {
        const invalid = bid("invalid", "bad", -1, 0.9, 10)
        const constrained = bid("constrained", "costly", 2, 0.9, 10)

        assert.equal(selectWorkBid([invalid]), null)
        assert.equal(selectWorkBid([invalid, constrained], { maxCostUsd: 1 }), null)
        assert.equal(selectWorkBid([]), null)
    })

    it("rejects invalid policy configuration", () => {
        const candidate = bid("worker", "bid", 1, 0.9, 10)
        assert.throws(
            () => selectWorkBid([candidate], { minSuccessProbability: 1.1 }),
            /minSuccessProbability/,
        )
        assert.throws(
            () => selectWorkBid([candidate], { maxCostUsd: Number.POSITIVE_INFINITY }),
            /maxCostUsd/,
        )
        assert.throws(
            () => selectWorkBid([candidate], { maxLatencyMs: -1 }),
            /maxLatencyMs/,
        )
    })
})

function estimate(
    expectedCostUsd: number,
    estimatedSuccessProbability: number,
    estimatedLatencyMs: number,
): WorkBidEstimate {
    return {
        expectedCostUsd,
        estimatedSuccessProbability,
        estimatedLatencyMs,
    }
}

function bid(
    workerId: string,
    bidId: string,
    expectedCostUsd: number,
    estimatedSuccessProbability: number,
    estimatedLatencyMs: number,
): WorkBidCandidate {
    return {
        workerId,
        bidId,
        estimate: estimate(
            expectedCostUsd,
            estimatedSuccessProbability,
            estimatedLatencyMs,
        ),
    }
}

function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]]
    const out: T[][] = []
    for (let i = 0; i < items.length; i += 1) {
        const head = items[i]!
        const rest = [...items.slice(0, i), ...items.slice(i + 1)]
        for (const tail of permutations(rest)) out.push([head, ...tail])
    }
    return out
}
