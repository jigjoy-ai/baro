import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import { createPlannerHarnessProgressiveSupport } from "../../src/planning/adapters/planner-harness-progressive.js"
import type { PlannerOpenAIPlanFragmentEvent } from "../../src/planning/adapters/planner-openai-progressive.js"
import type { InvariantCoverageGap } from "../../src/planning/application/plan-events.js"
import {
    invariantGapSummary,
    unownedInvariantsWithText,
} from "../../src/planning/domain/invariant-coverage-report.js"
import { buildFinalPrdRepairMessage } from "../../src/planning/domain/planner-prompts.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
} from "../../src/goal/goal-contract.js"
import {
    VerificationGoalGate,
    type VerificationGoalGateHost,
} from "../../src/verification/verification-goal-gate.js"
import {
    GoalCompletionCheckRequested,
    type GoalCompletionAttestedData,
} from "../../src/semantic-events.js"
import type { SemanticEvent } from "../../src/runtime/mozaik.js"
import type { PrdFile } from "../../src/prd.js"

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

const CONTRACT = deriveGoalContract(GOAL_ENVELOPE)
assert.ok(CONTRACT)
const ALL_INVARIANT_IDS = CONTRACT.invariants.map(({ id }) => id)

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

/** Configured exactly as planner-bus-session.ts configures the claude lane. */
async function busLaneSupport(
    runId: string,
    hooks: {
        onInvariantCoverageGap: (gap: InvariantCoverageGap) => void
        onHostFeedback?: (feedback: Record<string, unknown>) => void
    },
) {
    return await createPlannerHarnessProgressiveSupport({
        runId,
        planningId: `planning-${runId}`,
        trustedGoalEnvelope: GOAL_ENVELOPE,
        finalizationTailOnly: true,
        mcpServer: { command: process.execPath, args: [] },
        onInvariantCoverageGap: hooks.onInvariantCoverageGap,
        publish: async (event: PlannerOpenAIPlanFragmentEvent) => {
            const feedback: Record<string, unknown> = {
                graphVersion: 7,
                admittedStoryIds: event.stories.map(({ id }) => id),
                replayed: false,
            }
            hooks.onHostFeedback?.(feedback)
            return feedback
        },
    })
}

const RESERVED_RECEIPT_KEYS = [
    "invariantNote",
    "unownedInvariantIds",
    "obligationNote",
    "unownedObligationIds",
]

describe("claude-lane invariant coverage conformance", () => {
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

    it("bus-session receipt carries unowned invariant ids", async () => {
        const gaps: InvariantCoverageGap[] = []
        const feedbacks: Record<string, unknown>[] = []
        const support = await busLaneSupport("bus-lane-receipt", {
            onInvariantCoverageGap: (gap) => gaps.push(gap),
            onHostFeedback: (feedback) => feedbacks.push(feedback),
        })

        let receipt: Record<string, unknown>
        try {
            receipt = JSON.parse(
                await support.publish({
                    fragmentId: "foundation",
                    stories: [story("S1", []), story("S2", [])],
                }),
            ) as Record<string, unknown>
        } finally {
            await support.close()
        }

        assert.deepEqual(receipt.unownedInvariantIds, ALL_INVARIANT_IDS)
        const note = receipt.invariantNote as string
        assert.ok(note.startsWith("WARNING:"), note)
        for (const id of ALL_INVARIANT_IDS) assert.ok(note.includes(id), id)
        assert.deepEqual(support.unownedInvariantIds(), ALL_INVARIANT_IDS)

        assert.equal(feedbacks.length, 1)
        for (const key of RESERVED_RECEIPT_KEYS) {
            assert.ok(!(key in (feedbacks[0] as object)), key)
        }
        assert.equal(receipt.graphVersion, 7)

        assert.equal(gaps.length, 1)
        assert.deepEqual(gaps[0], {
            fragmentId: "foundation",
            unownedInvariantIds: ALL_INVARIANT_IDS,
            totalInvariants: ALL_INVARIANT_IDS.length,
        })

        assert.deepEqual(announcements(), [
            `[planner-invariants] fragment foundation admitted; unowned ${invariantGapSummary(
                ALL_INVARIANT_IDS,
                ALL_INVARIANT_IDS.length,
            )}\n`,
        ])
    })

    it("repair prompt lists invariant ids with canonical statements", () => {
        const ids = ALL_INVARIANT_IDS.slice(0, 2)
        const unownedInvariants = unownedInvariantsWithText(CONTRACT, ids)
        assert.equal(unownedInvariants.length, 2)

        const input = {
            reason: "final PRD failed goal coverage",
            unownedObligationIds: ["O-001"],
        }
        const message = buildFinalPrdRepairMessage({
            ...input,
            unownedInvariants,
        })

        assert.ok(message.includes("Unowned goal invariants (2):"), message)
        const lines = message.split("\n")
        for (const invariant of unownedInvariants) {
            assert.ok(
                lines.includes(`- [${invariant.id}] ${invariant.text}`),
                invariant.id,
            )
        }
        assert.ok(
            message.includes("Unowned architecture obligations (1):"),
            message,
        )
        assert.ok(message.indexOf("Unowned architecture obligations (1):") <
            message.indexOf("Unowned goal invariants (2):"))
        assert.ok(message.indexOf("Unowned goal invariants (2):") <
            message.indexOf("Expected schema:"))

        // A session whose envelope yields no contract must degrade silently.
        const withoutContract = unownedInvariantsWithText(
            deriveGoalContract(undefined),
            ids,
        )
        assert.deepEqual(withoutContract, [])
        const degraded = buildFinalPrdRepairMessage({
            ...input,
            unownedInvariants: withoutContract,
        })
        assert.ok(!degraded.includes("Unowned goal invariants"), degraded)
        assert.equal(degraded, buildFinalPrdRepairMessage(input))
    })

    it("coverage notice precedes terminal failure", async () => {
        const observed: string[] = []

        const support = await busLaneSupport("bus-lane-ordering", {
            onInvariantCoverageGap: (gap) =>
                observed.push(
                    `coverage-gap:${gap.unownedInvariantIds.join(",")}`,
                ),
        })
        try {
            await support.publish({
                fragmentId: "foundation",
                stories: [story("S1", [])],
            })
        } finally {
            await support.close()
        }

        const ledger = new GoalInvariantLedger(CONTRACT)
        const assessment = ledger.assess([], false)
        const projection = ledger.snapshot(1)
        assert.equal(assessment.status, "incomplete")
        assert.deepEqual(assessment.openInvariantIds, ALL_INVARIANT_IDS)

        const prd = {
            goalEnvelope: GOAL_ENVELOPE,
            userStories: [],
            runtimeGraph: {
                protocol: { schemaVersion: 1, goal: projection },
            },
        } as unknown as PrdFile
        const emitted: SemanticEvent<unknown>[] = []
        let phase = "running"
        const host: VerificationGoalGateHost = {
            emit: (event) => emitted.push(event),
            phase: () => phase,
            enterVerifying: () => {
                phase = "verifying"
            },
            requestPush: (reason) => observed.push(`terminal:${reason}`),
            prd: () => prd,
            persistGoalProtocol: () => undefined,
            waveOrdinal: () => 1,
        }
        const gate = new VerificationGoalGate({
            runId: "ordering-run",
            verifyBeforePush: false,
            hasGoalCompletionAuthority: true,
            host,
        })
        gate.requestVerification(null)

        const requested = emitted.find((event) =>
            GoalCompletionCheckRequested.is(event),
        )
        assert.ok(requested)
        gate.onGoalCompletionAttested({
            runId: "ordering-run",
            checkId: requested.data.checkId,
            contractId: CONTRACT.contractId,
            goalRevision: projection.revision,
            verificationId: requested.data.verificationId,
            status: assessment.status,
            satisfiedInvariantIds: assessment.satisfiedInvariantIds,
            openInvariantIds: assessment.openInvariantIds,
            rejectedInvariantIds: assessment.rejectedInvariantIds,
            invariants: assessment.invariants,
            reason: assessment.reason,
        } as GoalCompletionAttestedData)
        gate.releasePendings()

        const gapIndex = observed.findIndex((entry) =>
            entry.startsWith("coverage-gap:"),
        )
        const terminalIndex = observed.findIndex((entry) =>
            entry.startsWith("terminal:"),
        )
        assert.ok(gapIndex >= 0, JSON.stringify(observed))
        assert.ok(terminalIndex >= 0, JSON.stringify(observed))
        assert.ok(gapIndex < terminalIndex, JSON.stringify(observed))
        const terminal = observed[terminalIndex] as string
        assert.match(terminal, /global goal is not satisfied/)
        assert.match(terminal, /open invariant\(s\)/)
    })
})
