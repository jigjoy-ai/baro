import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { WorkOfferDesk } from "../../src/market/work-offer-desk.js"
import {
    RuntimeReplanRetractionTimedOut,
    StagedReplanGate,
    runtimeReplanTargetIds,
    type QueuedRuntimeReplan,
    type StagedReplanGateHost,
} from "../../src/replan/staged-replan-gate.js"
import {
    WorkOfferRetractionRequested,
    type RuntimeReplanProposedData,
    type WorkOfferedData,
    type WorkOfferRetractionRequestedData,
    type WorkOfferRetractionResolvedData,
} from "../../src/semantic-events.js"

function proposal(
    proposalId: string,
    removedStoryIds: readonly string[],
): RuntimeReplanProposedData {
    return {
        runId: "run-1",
        proposalId,
        sourceStoryId: "S0",
        leaseId: "lease-0",
        generation: 1,
        baseGraphVersion: 7,
        reason: "test",
        mutation: {
            addedStories: [],
            removedStoryIds,
            modifiedDeps: {},
        },
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
            graphVersion: 7,
        },
    }
}

function harness() {
    const offers = new WorkOfferDesk("run-1")
    const calls = {
        executes: [] as {
            queued: QueuedRuntimeReplan
            leased: string[]
            retracted: string[]
        }[],
        rejections: [] as {
            proposal: RuntimeReplanProposedData
            retracted: string[]
        }[],
        requests: [] as WorkOfferRetractionRequestedData[],
        timeouts: [] as { stageId: string; proposalId: string }[],
        armed: 0,
        cleared: 0,
        fire: undefined as (() => void) | undefined,
    }
    const host: StagedReplanGateHost = {
        emit: (event) => {
            if (WorkOfferRetractionRequested.is(event)) {
                calls.requests.push(event.data)
            }
            if (RuntimeReplanRetractionTimedOut.is(event)) {
                calls.timeouts.push(event.data)
            }
        },
        planningFailed: () => false,
        graphVersion: () => 7,
        execute: (queued, leased, retracted) => {
            calls.executes.push({
                queued,
                leased: [...leased],
                retracted: [...retracted],
            })
        },
        armRetractionTimer: (fire) => {
            calls.armed += 1
            calls.fire = fire
        },
        clearRetractionTimer: () => {
            calls.cleared += 1
        },
        rejectRetractionTimeout: (rejected, retracted) => {
            calls.rejections.push({
                proposal: rejected,
                retracted: [...retracted],
            })
        },
    }
    const gate = new StagedReplanGate("run-1", offers, host)
    return { gate, offers, calls }
}

function resolved(
    request: WorkOfferRetractionRequestedData,
    disposition: "retracted" | "leased",
): WorkOfferRetractionResolvedData {
    return disposition === "retracted"
        ? { ...request, disposition }
        : { ...request, disposition, leaseId: "lease-9", workerId: "w-9" }
}

describe("StagedReplanGate", () => {
    it("executes immediately when no targeted story has an open offer", () => {
        const { gate, calls } = harness()
        gate.enqueue(proposal("p-1", ["S1"]))
        assert.equal(calls.executes.length, 1)
        assert.deepEqual(calls.executes[0]?.leased, [])
        assert.deepEqual(calls.executes[0]?.retracted, [])
        assert.equal(calls.armed, 0)
        assert.equal(calls.requests.length, 0)
    })

    it("stages retractions for open offers and executes after all resolve", () => {
        const { gate, offers, calls } = harness()
        offers.recordOffer(offered("o-1", "S1"))
        offers.recordOffer(offered("o-2", "S2"))
        gate.enqueue(proposal("p-1", ["S1", "S2"]))

        assert.equal(calls.executes.length, 0)
        assert.equal(calls.armed, 1)
        assert.equal(calls.requests.length, 2)
        assert.equal(gate.targetsStory("S1"), true)
        assert.equal(gate.isOfferAwaitingRetraction("o-1"), true)

        const [first, second] = calls.requests
        assert.equal(gate.onRetractionResolved(resolved(first!, "retracted")), true)
        assert.equal(offers.hasOffer("S1"), false)
        assert.equal(calls.executes.length, 0)

        assert.equal(gate.onRetractionResolved(resolved(second!, "leased")), true)
        assert.equal(calls.executes.length, 1)
        assert.deepEqual(calls.executes[0]?.leased, ["S2"])
        assert.deepEqual(calls.executes[0]?.retracted, ["S1"])
        assert.equal(calls.cleared, 1)
        assert.equal(gate.targetsStory("S1"), false)
    })

    it("dedups a proposal already staged or queued by id + fingerprint", () => {
        const { gate, offers, calls } = harness()
        offers.recordOffer(offered("o-1", "S1"))
        gate.enqueue(proposal("p-1", ["S1"]))
        gate.enqueue(proposal("p-1", ["S1"]))
        assert.equal(calls.requests.length, 1)
        // Same id with a different mutation is a distinct proposal.
        gate.enqueue(proposal("p-1", ["S1", "S2"]))
        const [request] = calls.requests
        gate.onRetractionResolved(resolved(request!, "retracted"))
        assert.equal(calls.executes.length, 2)
    })

    it("fails closed at the watchdog: partitions retracted vs unresolved", () => {
        const { gate, offers, calls } = harness()
        offers.recordOffer(offered("o-1", "S1"))
        offers.recordOffer(offered("o-2", "S2"))
        gate.enqueue(proposal("p-1", ["S1", "S2"]))
        const [first] = calls.requests
        gate.onRetractionResolved(resolved(first!, "retracted"))

        calls.fire!()
        assert.equal(calls.timeouts.length, 1)
        gate.onRetractionTimedOut({
            runId: "run-1",
            stageId: calls.timeouts[0]!.stageId,
            proposalId: "p-1",
        })

        assert.equal(calls.executes.length, 0)
        assert.equal(calls.rejections.length, 1)
        assert.deepEqual(calls.rejections[0]?.retracted, ["S1"])
        // The unresolved retraction lands in the Desk's abandoned ledger.
        assert.equal(offers.consumeAbandonedByOffer("o-2"), true)
        assert.equal(offers.consumeAbandonedByOffer("o-1"), false)
        // A late resolution for the dead stage no longer belongs to the gate.
        assert.equal(
            gate.onRetractionResolved(resolved(calls.requests[1]!, "retracted")),
            false,
        )
    })

    it("ignores a stale watchdog for a settled stage", () => {
        const { gate, offers, calls } = harness()
        offers.recordOffer(offered("o-1", "S1"))
        gate.enqueue(proposal("p-1", ["S1"]))
        const [request] = calls.requests
        gate.onRetractionResolved(resolved(request!, "retracted"))
        gate.onRetractionTimedOut({
            runId: "run-1",
            stageId: "run-1:runtime-replan-stage:1",
            proposalId: "p-1",
        })
        assert.equal(calls.rejections.length, 0)
        assert.equal(calls.executes.length, 1)
    })

    it("drains the queue after the active stage settles", () => {
        const { gate, offers, calls } = harness()
        offers.recordOffer(offered("o-1", "S1"))
        gate.enqueue(proposal("p-1", ["S1"]))
        gate.enqueue(proposal("p-2", ["S9"]))
        assert.equal(calls.executes.length, 0)
        const [request] = calls.requests
        gate.onRetractionResolved(resolved(request!, "retracted"))
        assert.deepEqual(
            calls.executes.map(({ queued }) => queued.proposal.proposalId),
            ["p-1", "p-2"],
        )
    })

    it("exposes the union of removed and re-wired stories as targets", () => {
        const targets = runtimeReplanTargetIds({
            ...proposal("p-1", ["S1"]),
            mutation: {
                addedStories: [],
                removedStoryIds: ["S1"],
                modifiedDeps: { S2: ["S1"] },
            },
        })
        assert.deepEqual([...targets].sort(), ["S1", "S2"])
        assert.equal(runtimeReplanTargetIds(undefined).size, 0)
    })
})
