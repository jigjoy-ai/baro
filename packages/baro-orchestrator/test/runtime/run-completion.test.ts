import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    blockedStoryIds,
    goalCompletionFailure,
} from "../../src/runtime/run-completion.js"
import type { PrdStory } from "../../src/prd.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
} from "../../src/runtime/goal-contract.js"

function story(id: string, dependsOn: string[] = [], passes = false): PrdStory {
    return {
        id,
        priority: 1,
        title: id,
        description: id,
        dependsOn,
        retries: 1,
        acceptance: [],
        tests: [],
        passes,
        completedAt: null,
        durationSecs: null,
    }
}

describe("run completion projections", () => {
    it("propagates failure blocks transitively but never past passed stories", () => {
        const prd = {
            userStories: [
                story("S1"),
                story("S2", ["S1"]),
                story("S3", ["S2"]),
                story("S4", ["S1"], true),
                story("S5"),
            ],
        }
        assert.deepEqual(
            [...blockedStoryIds(prd, new Set(["S1"]))].sort(),
            ["S2", "S3"],
        )
        assert.deepEqual([...blockedStoryIds(prd, new Set())], [])
        assert.deepEqual([...blockedStoryIds(null, new Set(["S1"]))], [])
    })

    it("authorizes success only for an exact satisfied attestation", () => {
        const goalEnvelope = {
            objective: "Keep the behavior observable.",
            acceptanceCriteria: ["The behavior stays observable."],
            constraints: [],
            nonGoals: [],
            assumptions: [],
        }
        const contract = deriveGoalContract(goalEnvelope)!
        const goal = new GoalInvariantLedger(contract).snapshot(3)
        const completion = {
            runId: "run-1",
            checkId: "check-1",
            contractId: contract.contractId,
            goalRevision: goal.revision,
            verificationId: "verification-1",
            status: "satisfied" as const,
            satisfiedInvariantIds: contract.invariants.map(({ id }) => id),
            openInvariantIds: [],
            rejectedInvariantIds: [],
            invariants: [],
            reason: "all invariants satisfied",
        }
        const runtimeGraph = {
            runId: "run-1",
            version: 1,
            dynamicStories: 0,
            policyStories: 0,
            appliedDecisions: [],
            protocol: { schemaVersion: 1 as const, goal, completion },
        }

        assert.equal(
            goalCompletionFailure({ goalEnvelope, runtimeGraph }),
            null,
        )
        // No goal contract at all → nothing to attest.
        assert.equal(goalCompletionFailure({ goalEnvelope: undefined }), null)
        assert.match(goalCompletionFailure(null) ?? "", /unavailable/)
        // Any drift after attestation fails closed.
        assert.match(
            goalCompletionFailure({
                goalEnvelope,
                runtimeGraph: {
                    ...runtimeGraph,
                    protocol: {
                        schemaVersion: 1,
                        goal: { ...goal, revision: goal.revision + 1 },
                        completion,
                    },
                },
            }) ?? "",
            /changed after completion attestation/,
        )
        assert.match(
            goalCompletionFailure({ goalEnvelope, runtimeGraph: undefined }) ?? "",
            /changed after completion attestation/,
        )
    })
})
