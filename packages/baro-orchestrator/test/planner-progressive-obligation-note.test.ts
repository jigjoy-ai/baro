import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
    createPlannerOpenAIProgressiveSupport,
    createPlannerProgressivePublisher,
    type PlannerOpenAIPlanFragmentEvent,
} from "../src/planning/adapters/planner-openai-progressive.js"
import { renderArchitectureObligationCriterion } from "../src/planning/domain/architecture-obligation-contract.js"

const OBLIGATIONS = [
    {
        id: "O-001",
        invariantIds: ["G-A1"],
        subject: "the public boundary",
        scenario: "it is invoked directly",
        expectedOutcome: "its behavior remains observable",
        evidence: ["a focused boundary test"],
    },
    {
        id: "O-002",
        invariantIds: ["G-A1"],
        subject: "the boundary receipt",
        scenario: "a fragment is admitted",
        expectedOutcome: "the receipt names the gap",
        evidence: ["a focused receipt test"],
    },
    {
        id: "O-003",
        invariantIds: ["G-A1"],
        subject: "the boundary announcement",
        scenario: "a fragment is admitted",
        expectedOutcome: "one line announces the gap",
        evidence: ["a focused announcement test"],
    },
] as const

const DECISION_DOCUMENT = `## Existing context
One public boundary exists.

## ADR-001: Preserve the public boundary
**Status:** Accepted
**Context:** The boundary is independently callable.
**Decision:** Preserve its observable behavior.
**Consequences:** Focused tests own the evidence.

\`\`\`baro-obligations-v1
${JSON.stringify({ schemaVersion: 1, obligations: OBLIGATIONS })}
\`\`\``

const GOAL_ENVELOPE = {
    objective: "Preserve the public boundary.",
    acceptanceCriteria: ["Its behavior remains observable."],
    constraints: [],
    nonGoals: [],
    assumptions: [],
}

const BASE_STORY = {
    priority: 1,
    description: "Thread the signal through the provider boundary.",
    dependsOn: [] as string[],
    retries: 2,
    tests: ["npm test"],
    goalInvariantIds: ["G-A1"],
    model: "heavy",
}

function criterionFor(id: string): string {
    const obligation = OBLIGATIONS.find((candidate) => candidate.id === id)
    assert.ok(obligation, `no fixture obligation ${id}`)
    return renderArchitectureObligationCriterion(obligation)
}

function story(id: string, obligationIds: readonly string[]) {
    return {
        ...BASE_STORY,
        id,
        title: `Story ${id}`,
        acceptance:
            obligationIds.length > 0
                ? obligationIds.map(criterionFor)
                : ["The exact signal reaches providers."],
    }
}

function publisherFor(
    runId: string,
    options: { decisionDocument?: string } = {},
) {
    const published: PlannerOpenAIPlanFragmentEvent[] = []
    const publisher = createPlannerProgressivePublisher({
        runId,
        planningId: `planning-${runId}`,
        trustedGoalEnvelope: GOAL_ENVELOPE,
        ...(options.decisionDocument === undefined
            ? {}
            : { trustedDecisionDocument: options.decisionDocument }),
        publish: (event) => published.push(event),
    })
    return { publisher, published }
}

describe("progressive fragment obligation receipt", () => {
    let written: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)

    beforeEach(() => {
        written = []
        process.stderr.write = ((chunk: string | Uint8Array) => {
            written.push(typeof chunk === "string" ? chunk : chunk.toString())
            return true
        }) as typeof process.stderr.write
    })

    afterEach(() => {
        process.stderr.write = realWrite
    })

    const announcements = () =>
        written.filter((line) => line.startsWith("[planner-obligations] "))

    it("names the concrete unowned ids left after this fragment", async () => {
        const { publisher } = publisherFor("receipt-ids", {
            decisionDocument: DECISION_DOCUMENT,
        })

        const receipt = await publisher.publish({
            fragmentId: "foundation",
            stories: [story("S1", ["O-001"])],
        })

        assert.equal(receipt.disposition, "admitted")
        const note = receipt.obligationNote as string
        assert.match(note, /2 of 3 architecture obligation\(s\) are still unowned/)
        for (const id of ["O-002", "O-003"]) assert.ok(note.includes(id), id)
        assert.ok(!note.includes("O-001"))
        assert.deepEqual(receipt.unownedObligationIds, ["O-002", "O-003"])
        assert.deepEqual(publisher.unownedObligationIds(), ["O-002", "O-003"])
    })

    it("omits the note and the id array once nothing is unowned", async () => {
        const { publisher, published } = publisherFor("receipt-complete", {
            decisionDocument: DECISION_DOCUMENT,
        })

        const receipt = await publisher.publish({
            fragmentId: "complete",
            stories: [story("S1", ["O-001", "O-002", "O-003"])],
        })

        assert.equal(receipt.disposition, "admitted")
        assert.ok(!("obligationNote" in receipt))
        assert.ok(!("unownedObligationIds" in receipt))
        assert.deepEqual(publisher.unownedObligationIds(), [])
        assert.equal(published.length, 1)
        assert.deepEqual(announcements(), [
            "[planner-obligations] fragment complete admitted; unowned 0/3\n",
        ])
    })

    it("keeps the receipt keys and their order with the gap fields before host feedback", async () => {
        const publisher = createPlannerProgressivePublisher({
            runId: "receipt-order",
            planningId: "planning-receipt-order",
            trustedGoalEnvelope: GOAL_ENVELOPE,
            trustedDecisionDocument: DECISION_DOCUMENT,
            publish: () => ({ graphVersion: 7 }),
        })

        const receipt = await publisher.publish({
            fragmentId: "foundation",
            stories: [story("S1", ["O-001"])],
        })

        assert.deepEqual(Object.keys(receipt), [
            "ok",
            "disposition",
            "fragmentId",
            "ordinal",
            "fingerprint",
            "storyIds",
            "nextOrdinal",
            "obligationNote",
            "unownedObligationIds",
            "graphVersion",
        ])
    })

    it("announces the shrinking gap once per admission", async () => {
        const { publisher } = publisherFor("announce-two", {
            decisionDocument: DECISION_DOCUMENT,
        })

        await publisher.publish({
            fragmentId: "first",
            stories: [story("S1", ["O-001"])],
        })
        await publisher.publish({
            fragmentId: "second",
            stories: [story("S2", ["O-002"])],
        })

        assert.deepEqual(announcements(), [
            "[planner-obligations] fragment first admitted; unowned 2/3: O-002, O-003\n",
            "[planner-obligations] fragment second admitted; unowned 1/3: O-003\n",
        ])
    })

    it("stays silent and still admits when no obligation contract is configured", async () => {
        const { publisher, published } = publisherFor("no-contract")

        const receipt = await publisher.publish({
            fragmentId: "foundation",
            stories: [story("S1", [])],
        })

        assert.equal(receipt.disposition, "admitted")
        assert.ok(!("obligationNote" in receipt))
        assert.ok(!("unownedObligationIds" in receipt))
        assert.deepEqual(announcements(), [])
        assert.equal(published.length, 1)
        assert.deepEqual(publisher.unownedObligationIds(), [])
    })

    it("reports the gap through the support facade and its disabled stub", async () => {
        const support = createPlannerOpenAIProgressiveSupport({
            runId: "support-gap",
            planningId: "planning-support-gap",
            trustedGoalEnvelope: GOAL_ENVELOPE,
            trustedDecisionDocument: DECISION_DOCUMENT,
            publish: () => undefined,
        })
        const publishTool = support.extraTools[0]
        assert.ok(publishTool)

        await publishTool.invoke({
            fragmentId: "foundation",
            stories: [story("S1", ["O-001"])],
        })

        assert.deepEqual(support.unownedObligationIds(), ["O-002", "O-003"])
        assert.deepEqual(
            createPlannerOpenAIProgressiveSupport(undefined).unownedObligationIds(),
            [],
        )
    })
})
