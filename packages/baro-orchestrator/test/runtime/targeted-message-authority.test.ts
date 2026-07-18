import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    acceptsTargetedMessage,
    correlatedTargetedMessage,
} from "../../src/runtime/targeted-message-authority.js"
import { source } from "../participants/helpers.js"

describe("targeted message authority", () => {
    it("keeps legacy recipient-only delivery while collective delivery fails closed", () => {
        const bridge = source("bridge")
        const impostor = source("bridge")
        const base = { recipientId: "S1", text: "focus", metadata: {} }
        const correlation = {
            runId: "run-1",
            recipientId: "S1",
            leaseId: "lease-1",
            generation: 2,
        }
        const delivered = correlatedTargetedMessage(base, correlation)

        assert.equal(
            acceptsTargetedMessage(impostor, base, "S1", undefined, {}),
            true,
        )
        assert.equal(
            acceptsTargetedMessage(bridge, delivered, "S1", bridge, correlation),
            true,
        )
        for (const [candidateSource, candidate] of [
            [impostor, delivered],
            [bridge, { ...delivered, runId: "other" }],
            [bridge, { ...delivered, leaseId: "other" }],
            [bridge, { ...delivered, generation: 3 }],
            [bridge, base],
        ] as const) {
            assert.equal(
                acceptsTargetedMessage(
                    candidateSource,
                    candidate,
                    "S1",
                    bridge,
                    correlation,
                ),
                false,
            )
        }
    })

    it("overwrites forged intent correlation with the authoritative lease", () => {
        const delivery = correlatedTargetedMessage(
            {
                recipientId: "S1",
                text: "message",
                metadata: { source: "operator" },
                runId: "forged",
                leaseId: "forged",
                generation: 99,
            },
            {
                runId: "run-real",
                recipientId: "S1",
                leaseId: "lease-real",
                generation: 4,
            },
        )
        assert.deepEqual(delivery, {
            recipientId: "S1",
            text: "message",
            metadata: { source: "operator" },
            runId: "run-real",
            leaseId: "lease-real",
            generation: 4,
        })
    })
})
