import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
    createPlannerOpenAIProgressiveSupport,
    createPlannerProgressivePublisher,
    type PlannerOpenAIPlanFragmentEvent,
} from "../../src/planning/adapters/planner-openai-progressive.js"
import { createPlannerHarnessProgressiveSupport } from "../../src/planning/adapters/planner-harness-progressive.js"
import type { InvariantCoverageGap } from "../../src/planning/application/plan-events.js"

const GOAL_ENVELOPE = {
    objective: "Preserve the public boundary.",
    acceptanceCriteria: [
        "Its behavior remains observable.",
        "Its receipt names the gap.",
    ],
    constraints: ["It stays fail-closed."],
    nonGoals: [],
    assumptions: [],
}

const ALL_INVARIANTS = ["G-A1", "G-A2", "G-C1"]

const BASE_STORY = {
    priority: 1,
    description: "Thread the signal through the provider boundary.",
    dependsOn: [] as string[],
    retries: 2,
    tests: ["npm test"],
    acceptance: ["The exact signal reaches providers."],
    model: "heavy",
}

function story(id: string, invariantIds: readonly string[]) {
    return {
        ...BASE_STORY,
        id,
        title: `Story ${id}`,
        goalInvariantIds: [...invariantIds],
    }
}

function publisherFor(
    runId: string,
    options: {
        goalEnvelope?: typeof GOAL_ENVELOPE
        onInvariantCoverageGap?: (gap: InvariantCoverageGap) => void
    } = {},
) {
    const published: PlannerOpenAIPlanFragmentEvent[] = []
    const envelope =
        "goalEnvelope" in options ? options.goalEnvelope : GOAL_ENVELOPE
    const publisher = createPlannerProgressivePublisher({
        runId,
        planningId: `planning-${runId}`,
        ...(envelope === undefined ? {} : { trustedGoalEnvelope: envelope }),
        ...(options.onInvariantCoverageGap === undefined
            ? {}
            : { onInvariantCoverageGap: options.onInvariantCoverageGap }),
        publish: (event) => published.push(event),
    })
    return { publisher, published }
}

describe("progressive fragment invariant receipt", () => {
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
        written.filter((line) => line.startsWith("[planner-invariants] "))

    it("names the concrete unowned invariant ids left after this fragment", async () => {
        const { publisher } = publisherFor("invariant-receipt-ids")

        const receipt = await publisher.publish({
            fragmentId: "foundation",
            stories: [story("S1", ["G-A1"])],
        })

        assert.equal(receipt.disposition, "admitted")
        const note = receipt.invariantNote as string
        assert.match(note, /2 of 3 goal invariant\(s\) are still unowned/)
        for (const id of ["G-A2", "G-C1"]) assert.ok(note.includes(id), id)
        assert.ok(!note.includes("G-A1]"))
        assert.match(note, /Published stories are immutable/)
        assert.deepEqual(receipt.unownedInvariantIds, ["G-A2", "G-C1"])
        assert.deepEqual(publisher.unownedInvariantIds(), ["G-A2", "G-C1"])
    })

    it("omits the note and the id array once nothing is unowned", async () => {
        const { publisher, published } = publisherFor("invariant-complete")

        const receipt = await publisher.publish({
            fragmentId: "complete",
            stories: [story("S1", ALL_INVARIANTS)],
        })

        assert.equal(receipt.disposition, "admitted")
        assert.ok(!("invariantNote" in receipt))
        assert.ok(!("unownedInvariantIds" in receipt))
        assert.deepEqual(publisher.unownedInvariantIds(), [])
        assert.equal(published.length, 1)
        assert.deepEqual(announcements(), [
            "[planner-invariants] fragment complete admitted; unowned 0/3\n",
        ])
    })

    it("announces the shrinking gap on stderr once per admission", async () => {
        const { publisher } = publisherFor("invariant-announce-two")

        await publisher.publish({
            fragmentId: "first",
            stories: [story("S1", ["G-A1"])],
        })
        await publisher.publish({
            fragmentId: "second",
            stories: [story("S2", ["G-A2"])],
        })

        assert.deepEqual(announcements(), [
            "[planner-invariants] fragment first admitted; unowned 2/3: G-A2, G-C1\n",
            "[planner-invariants] fragment second admitted; unowned 1/3: G-C1\n",
        ])
    })

    it("hands the gap to an injected sink at admission time", async () => {
        const gaps: InvariantCoverageGap[] = []
        const { publisher } = publisherFor("invariant-sink", {
            onInvariantCoverageGap: (gap) => gaps.push(gap),
        })

        await publisher.publish({
            fragmentId: "foundation",
            stories: [story("S1", ["G-A1"])],
        })

        assert.equal(gaps.length, 1)
        assert.deepEqual(gaps[0], {
            fragmentId: "foundation",
            unownedInvariantIds: ["G-A2", "G-C1"],
            totalInvariants: 3,
        })

        await publisher.publish({
            fragmentId: "closing",
            stories: [story("S2", ["G-A2", "G-C1"])],
        })

        assert.equal(gaps.length, 1)
    })

    it("defaults to the ungated run-stream warn when no sink is injected", async () => {
        const { publisher } = publisherFor("invariant-default-sink")
        const stdout: string[] = []
        const realStdoutWrite = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string | Uint8Array) => {
            stdout.push(typeof chunk === "string" ? chunk : chunk.toString())
            return true
        }) as typeof process.stdout.write
        try {
            await publisher.publish({
                fragmentId: "foundation",
                stories: [story("S1", ["G-A1"])],
            })
        } finally {
            process.stdout.write = realStdoutWrite
        }

        const warns = stdout
            .join("")
            .split("\n")
            .filter((line) => line.includes('"kind":"warn"'))
        assert.equal(warns.length, 1)
        const warn = warns[0] as string
        assert.match(warn, /\[planner-invariants\] fragment foundation: 2\/3/)
        for (const id of ["G-A2", "G-C1"]) assert.ok(warn.includes(id), id)
    })

    it("keeps the gap fields before host feedback, which may still override them", async () => {
        const publisher = createPlannerProgressivePublisher({
            runId: "invariant-receipt-order",
            planningId: "planning-invariant-receipt-order",
            trustedGoalEnvelope: GOAL_ENVELOPE,
            publish: () => ({ graphVersion: 7, unownedInvariantIds: ["G-C1"] }),
        })

        const receipt = await publisher.publish({
            fragmentId: "foundation",
            stories: [story("S1", ["G-A1"])],
        })

        assert.deepEqual(Object.keys(receipt), [
            "ok",
            "disposition",
            "fragmentId",
            "ordinal",
            "fingerprint",
            "storyIds",
            "nextOrdinal",
            "invariantNote",
            "unownedInvariantIds",
            "graphVersion",
        ])
        assert.deepEqual(receipt.unownedInvariantIds, ["G-C1"])
    })

    it("stays silent and still admits when no goal envelope is configured", async () => {
        const gaps: InvariantCoverageGap[] = []
        const { publisher, published } = publisherFor("invariant-no-contract", {
            goalEnvelope: undefined,
            onInvariantCoverageGap: (gap) => gaps.push(gap),
        })

        const receipt = await publisher.publish({
            fragmentId: "foundation",
            stories: [story("S1", [])],
        })

        assert.equal(receipt.disposition, "admitted")
        assert.ok(!("invariantNote" in receipt))
        assert.ok(!("unownedInvariantIds" in receipt))
        assert.deepEqual(announcements(), [])
        assert.deepEqual(gaps, [])
        assert.equal(published.length, 1)
        assert.deepEqual(publisher.unownedInvariantIds(), [])
    })

    it("reports the gap through the native support facade and its disabled stub", async () => {
        const support = createPlannerOpenAIProgressiveSupport({
            runId: "invariant-support-gap",
            planningId: "planning-invariant-support-gap",
            trustedGoalEnvelope: GOAL_ENVELOPE,
            publish: () => undefined,
        })
        const publishTool = support.extraTools[0]
        assert.ok(publishTool)

        await publishTool.invoke({
            fragmentId: "foundation",
            stories: [story("S1", ["G-A1"])],
        })

        assert.deepEqual(support.unownedInvariantIds(), ["G-A2", "G-C1"])
        assert.deepEqual(
            createPlannerOpenAIProgressiveSupport(undefined).unownedInvariantIds(),
            [],
        )
    })

    it("forwards the receipt keys verbatim through the harness support", async () => {
        const support = await createPlannerHarnessProgressiveSupport({
            runId: "invariant-harness-gap",
            planningId: "planning-invariant-harness-gap",
            trustedGoalEnvelope: GOAL_ENVELOPE,
            mcpServer: { command: process.execPath, args: [] },
            publish: () => undefined,
        })

        const receipt = JSON.parse(
            await support.publish({
                fragmentId: "foundation",
                stories: [story("S1", ["G-A1"])],
            }),
        ) as Record<string, unknown>

        assert.match(
            receipt.invariantNote as string,
            /2 of 3 goal invariant\(s\) are still unowned/,
        )
        assert.deepEqual(receipt.unownedInvariantIds, ["G-A2", "G-C1"])
        assert.deepEqual(support.unownedInvariantIds(), ["G-A2", "G-C1"])
        await support.close()

        const disabled = await createPlannerHarnessProgressiveSupport(undefined)
        assert.deepEqual(disabled.unownedInvariantIds(), [])
    })
})
