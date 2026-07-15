import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

import {
    applyReplan,
    loadPrd,
    markStoryPassed,
    normalizePrd,
    savePrd,
    savePrdAtomic,
    type PrdFile,
} from "../src/prd.js"
import { validateRuntimeReplanMutation } from "../src/runtime/runtime-replan.js"
import type { GoalEnvelope } from "../src/session/conversation-contract.js"
import { withTempDir } from "./participants/helpers.js"

const GOAL: GoalEnvelope = {
    objective: "Keep the conversation intent attached to the run.",
    constraints: ["Do not invoke providers."],
    acceptanceCriteria: ["Metadata survives every PRD rewrite."],
    nonGoals: ["Changing runtime authority."],
    assumptions: ["The session already passed intake."],
}

describe("PRD conversation metadata", () => {
    it("strictly normalizes and defensively copies valid session metadata", () => {
        const mutableGoal = structuredClone(GOAL) as {
            objective: string
            constraints: string[]
            acceptanceCriteria: string[]
            nonGoals: string[]
            assumptions: string[]
        }

        const prd = normalizePrd(
            {
                ...basePrd(),
                conversationSessionId: "session:conversation-1",
                goalEnvelope: mutableGoal,
            },
            "conversation-prd.json",
        )

        mutableGoal.constraints.push("late mutation")
        assert.equal(prd.conversationSessionId, "session:conversation-1")
        assert.deepEqual(prd.goalEnvelope, GOAL)
        assert.equal(Object.isFrozen(prd.goalEnvelope), true)
        assert.equal(Object.isFrozen(prd.goalEnvelope?.constraints), true)
    })

    it("fails closed for unsafe session ids and non-exact GoalEnvelopes", () => {
        assert.throws(
            () =>
                normalizePrd(
                    {
                        ...basePrd(),
                        conversationSessionId: "session id with spaces",
                    },
                    "unsafe-session.json",
                ),
            /invalid conversation metadata: conversationSessionId is not a safe correlation id/,
        )

        assert.throws(
            () =>
                normalizePrd(
                    {
                        ...basePrd(),
                        goalEnvelope: {
                            ...GOAL,
                            workerModel: "must-not-enter-intake",
                        },
                    } as unknown as Partial<PrdFile>,
                    "extra-goal-field.json",
                ),
            /invalid conversation metadata: goalEnvelope shape is not exact/,
        )
    })

    it("round-trips metadata through normal and atomic persistence", async () => {
        await withTempDir("prd-conversation-metadata-", async (dir) => {
            const expected = normalizePrd(
                {
                    ...basePrd(),
                    conversationSessionId: "session.persistence-1",
                    goalEnvelope: GOAL,
                },
                "memory",
            )

            const regularPath = join(dir, "regular-prd.json")
            savePrd(regularPath, expected)
            assert.deepEqual(loadPrd(regularPath), expected)

            const atomicPath = join(dir, "atomic-prd.json")
            savePrdAtomic(atomicPath, expected)
            assert.deepEqual(loadPrd(atomicPath), expected)
        })
    })

    it("preserves metadata through completion, legacy replan, and runtime replan rewrites", () => {
        const initial = normalizePrd(
            {
                ...basePrd(),
                conversationSessionId: "session.runtime-1",
                goalEnvelope: GOAL,
            },
            "runtime-prd.json",
        )

        const completed = markStoryPassed(initial, "S1", 1.25)
        assertMetadata(completed)

        const legacy = applyReplan(completed, {
            source: "surgeon",
            reason: "Add independently discovered work.",
            addedStories: [newStory("S2")],
            removedStoryIds: [],
            modifiedDeps: {},
        })
        assertMetadata(legacy)

        const runtime = validateRuntimeReplanMutation(
            initial,
            {
                addedStories: [newStory("S3")],
                removedStoryIds: [],
                modifiedDeps: {},
            },
            { immutableStoryIds: [], maxAddedStories: 1 },
        )
        assert.equal(runtime.ok, true)
        if (!runtime.ok) return
        assertMetadata(runtime.prd)
    })
})

function basePrd(): PrdFile {
    return {
        project: "baro",
        branchName: "baro/conversation-metadata",
        description: "Exercise durable conversation metadata.",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Preserve intent",
                description: "Keep conversation metadata on the PRD.",
                dependsOn: [],
                retries: 2,
                acceptance: ["The metadata remains present."],
                tests: ["npm test"],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
        ],
    }
}

function newStory(id: string) {
    return {
        id,
        priority: 2,
        title: `Dynamic ${id}`,
        description: "Add work without replacing conversation metadata.",
        dependsOn: ["S1"],
        retries: 2,
        acceptance: [`${id} is complete.`],
        tests: ["npm test"],
    }
}

function assertMetadata(prd: PrdFile): void {
    assert.equal(prd.conversationSessionId, "session.runtime-1")
    assert.deepEqual(prd.goalEnvelope, GOAL)
}
