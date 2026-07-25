import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { WorkOfferDesk } from "../../src/market/work-offer-desk.js"
import type { PrdStory } from "../../src/prd.js"
import type {
    WorkLeaseGrantedData,
    WorkOfferedData,
    WorkOfferRetractionRequestedData,
} from "../../src/semantic-events.js"

function story(id: string): PrdStory {
    return {
        id,
        priority: 1,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn: [],
        retries: 1,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
    }
}

function offered(offerId: string, storyId: string): WorkOfferedData {
    return {
        runId: "run-1",
        offerId,
        generation: 1,
        priority: 1,
        request: {
            storyId,
            prompt: "do it",
            model: "sonnet",
            retries: 1,
            timeoutSecs: 60,
            graphVersion: 1,
        },
    }
}

function retraction(
    retractionId: string,
    offerId: string,
    storyId: string,
): WorkOfferRetractionRequestedData {
    return {
        runId: "run-1",
        proposalId: "proposal-1",
        retractionId,
        offerId,
        storyId,
        generation: 1,
        graphVersion: 1,
    }
}

describe("WorkOfferDesk", () => {
    it("correlates context requests exactly and consumes them once", () => {
        const desk = new WorkOfferDesk("run-1")
        const request = desk.beginContextRequest(story("S1"), ["hint"])
        assert.match(request.requestId, /^run-1:context:1:S1$/)
        assert.equal(desk.hasContextRequest("S1"), true)
        assert.equal(desk.takeContextStory(request.requestId, "S2"), undefined)
        assert.equal(
            desk.takeContextStory(request.requestId, "S1")?.id,
            "S1",
        )
        assert.equal(desk.takeContextStory(request.requestId, "S1"), undefined)
        desk.beginContextRequest(story("S3"), [])
        desk.cancelContextRequests("S3")
        assert.equal(desk.hasContextRequest("S3"), false)
    })

    it("consumes a lease grant only on exact offer correlation", () => {
        const desk = new WorkOfferDesk("run-1")
        const data = offered(desk.nextOfferId("S1"), "S1")
        desk.recordOffer(data)
        const grant = (overrides: Partial<WorkLeaseGrantedData>) => ({
            runId: "run-1",
            offerId: data.offerId,
            leaseId: "lease-1",
            workerId: "worker-1",
            generation: 1,
            request: structuredClone(data.request),
            ...overrides,
        }) as WorkLeaseGrantedData
        assert.equal(desk.consumeLeaseGrant(grant({ offerId: "other" })), false)
        assert.equal(
            desk.consumeLeaseGrant(grant({
                request: { ...structuredClone(data.request), prompt: "changed" },
            })),
            false,
        )
        assert.equal(desk.hasOffer("S1"), true)
        assert.equal(desk.consumeLeaseGrant(grant({})), true)
        assert.equal(desk.hasOffer("S1"), false)
    })

    it("restores a story only for a correlated retracted abandoned offer", () => {
        const desk = new WorkOfferDesk("run-1")
        const data = offered(desk.nextOfferId("S1"), "S1")
        desk.recordOffer(data)
        const request = retraction("stage:1", data.offerId, "S1")
        desk.abandonRetraction(request)

        const resolution = (overrides: object) => ({
            ...request,
            disposition: "retracted" as const,
            ...overrides,
        })
        assert.equal(
            desk.resolveAbandonedRetraction(
                resolution({ graphVersion: 2 }) as never,
            ),
            null,
        )
        assert.equal(
            desk.resolveAbandonedRetraction(resolution({}) as never),
            "S1",
        )
        assert.equal(desk.hasOffer("S1"), false)
        // Consumed exactly once.
        assert.equal(
            desk.resolveAbandonedRetraction(resolution({}) as never),
            null,
        )
        // Expiry-side consumption drops every entry naming the offer.
        desk.abandonRetraction(retraction("stage:2", "offer-x", "S2"))
        assert.equal(desk.consumeAbandonedByOffer("offer-x"), true)
        assert.equal(desk.consumeAbandonedByOffer("offer-x"), false)
    })
})
