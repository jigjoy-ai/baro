import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createPlannerProgressivePublisher,
    type PlannerOpenAIPlanFragmentEvent,
} from "../../src/planning/adapters/planner-openai-progressive.js"

// Issue #104: the planner's final tail used to meet the board only after the
// session had closed, and a host refusal left the local session out of step.

const STORY = {
    id: "S1",
    priority: 1,
    title: "Foundation",
    description: "First published story.",
    dependsOn: [] as string[],
    retries: 2,
    acceptance: ["S1 is observable"],
    tests: ["npm test -- S1"],
    goalInvariantIds: [] as string[],
    model: "standard",
    writes: ["src/a.js"],
}

const TAIL = {
    ...STORY,
    id: "S2",
    title: "Tail",
    dependsOn: ["S1"],
    writes: ["src/a.js"],
}

const CORRECTED_TAIL = { ...TAIL, writes: ["src/b.js"] }

const METADATA = { project: "p", branchName: "b", description: "d" }
const candidate = (stories: unknown[]) => JSON.stringify({ ...METADATA, userStories: stories })

function publisherWithHost(host: (event: PlannerOpenAIPlanFragmentEvent) => void) {
    const events: PlannerOpenAIPlanFragmentEvent[] = []
    const publisher = createPlannerProgressivePublisher({
        runId: "run-1",
        planningId: "planning-1",
        finalizationTailOnly: true,
        publish: async (event) => {
            events.push(event)
            host(event)
        },
    })
    return { publisher, events }
}

describe("progressive publisher and the host's verdict", () => {
    it("forgets a fragment the host refused so the corrected retry lands on the same ordinal", async () => {
        let refuse = false
        const { publisher, events } = publisherWithHost(() => {
            if (refuse) throw new Error("fragment rejected (graph_rejected): overlapping write surface")
        })
        await publisher.publish({ fragmentId: "f1", stories: [STORY] })

        refuse = true
        await assert.rejects(
            publisher.publish({ fragmentId: "f2", stories: [TAIL] }),
            /overlapping write surface/,
        )
        assert.equal(publisher.hasEarlyPlan(), true)

        refuse = false
        const receipt = await publisher.publish({ fragmentId: "f2", stories: [CORRECTED_TAIL] })
        assert.equal(receipt.disposition, "admitted")
        assert.equal(receipt.ordinal, 2)
        assert.deepEqual(events.map((e) => [e.fragment_id, e.ordinal]), [
            ["f1", 1],
            ["f2", 2],
            ["f2", 2],
        ])
        assert.deepEqual(events.at(-1)?.stories[0]?.writes, ["src/b.js"])
    })

    it("publishes the appended tail through the fragment path before the plan is composed", async () => {
        const { publisher, events } = publisherWithHost(() => undefined)
        await publisher.publish({ fragmentId: "f1", stories: [STORY] })

        await publisher.publishFinalTail(candidate([CORRECTED_TAIL]))
        assert.deepEqual(events.map((e) => [e.fragment_id, e.ordinal]), [
            ["f1", 1],
            ["final-tail-2", 2],
        ])

        // The tail is admitted now; composing the same candidate appends nothing twice.
        const composed = publisher.reconcileFinalCandidate(candidate([CORRECTED_TAIL]))
        assert.deepEqual(
            (composed.userStories as Array<{ id: string }>).map((s) => s.id),
            ["S1", "S2"],
        )
    })

    it("publishes nothing for an empty tail or a reconciled session", async () => {
        const { publisher, events } = publisherWithHost(() => undefined)
        await publisher.publish({ fragmentId: "f1", stories: [STORY] })

        await publisher.publishFinalTail(candidate([]))
        assert.equal(events.length, 1)

        publisher.reconcileFinalCandidate(candidate([]))
        await publisher.publishFinalTail(candidate([CORRECTED_TAIL]))
        assert.equal(events.length, 1, "a sealed session never publishes")
    })

    it("surfaces the host's refusal of the tail and leaves the session open for a retry", async () => {
        const { publisher, events } = publisherWithHost((event) => {
            if (event.fragment_id.startsWith("final-tail")) {
                throw new Error("fragment rejected (graph_rejected): overlapping write surface")
            }
        })
        await publisher.publish({ fragmentId: "f1", stories: [STORY] })

        await assert.rejects(publisher.publishFinalTail(candidate([TAIL])), /overlapping/)
        await assert.rejects(publisher.publishFinalTail(candidate([TAIL])), /overlapping/)
        assert.deepEqual(
            events.map((e) => e.ordinal),
            [1, 2, 2],
            "the refused tail never advances the local ordinal",
        )
        // The board's tolerance still gets the tail when the planner gives up.
        const composed = publisher.reconcileFinalCandidate(candidate([TAIL]))
        assert.deepEqual(
            (composed.userStories as Array<{ id: string }>).map((s) => s.id),
            ["S1", "S2"],
        )
    })
})
