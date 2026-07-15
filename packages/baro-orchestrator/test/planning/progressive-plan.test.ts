import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { PrdFile, PrdStory } from "../../src/prd.js"
import {
    ProgressivePlanContractError,
    openProgressivePlanSession,
    progressivePlanFragmentFingerprint,
    reconcileProgressivePlanStories,
    restoreProgressivePlanSession,
    validateProgressivePlanFragment,
} from "../../src/planning/progressive-plan.js"

function story(
    id: string,
    dependsOn: string[] = [],
    overrides: Partial<PrdStory> = {},
): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")) || 1,
        title: `Story ${id}`,
        description: `Implement ${id}`,
        dependsOn,
        retries: 2,
        acceptance: [`${id} is observable`],
        tests: [`npm test -- ${id}`],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
        ...overrides,
    }
}

function fragment(
    fragmentId: string,
    ordinal: number,
    stories: PrdStory[],
): Record<string, unknown> {
    return {
        schemaVersion: 1,
        planningSessionId: "planning-1",
        fragmentId,
        ordinal,
        stories,
    }
}

function finalPrd(stories: PrdStory[]): PrdFile {
    return {
        project: "progressive-plan",
        branchName: "baro/progressive-plan",
        description: "Exercise progressive planning.",
        userStories: stories,
    }
}

function expectCode(
    action: () => unknown,
    code: ProgressivePlanContractError["code"],
): void {
    assert.throws(action, (error: unknown) => {
        assert.ok(error instanceof ProgressivePlanContractError)
        assert.equal(error.code, code)
        return true
    })
}

describe("progressive plan v1", () => {
    it("opens a session and atomically admits continuous closed fragments", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        const s1 = story("S1")
        const mutableDependencies = ["S1"]
        const s2 = story("S2", mutableDependencies)

        const first = session.admit(fragment("fragment-1", 1, [s1]))
        const second = session.admit(fragment("fragment-2", 2, [s2]))
        mutableDependencies.push("not-admitted")
        s2.title = "mutated after admission"

        assert.equal(first.disposition, "admitted")
        assert.equal(second.disposition, "admitted")
        assert.equal(session.nextOrdinal, 3)
        assert.deepEqual(session.snapshot().stories, [
            story("S1"),
            story("S2", ["S1"]),
        ])
    })

    it("allows dependencies within one fragment but rejects a same-fragment cycle", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        session.admit(
            fragment("closed", 1, [
                story("S2", ["S1"]),
                story("S1"),
            ]),
        )

        expectCode(
            () => session.admit(
                fragment("cycle", 2, [
                    story("S3", ["S4"]),
                    story("S4", ["S3"]),
                ]),
            ),
            "dependency_cycle",
        )
        assert.equal(session.nextOrdinal, 2)
        assert.deepEqual(session.snapshot().stories.map((item) => item.id), ["S2", "S1"])
    })

    it("rejects provisional forward references without retaining pending work", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })

        expectCode(
            () => session.admit(fragment("future", 1, [story("S2", ["S1"])])),
            "forward_reference",
        )
        assert.equal(session.nextOrdinal, 1)
        assert.deepEqual(session.snapshot().stories, [])

        session.admit(fragment("foundation", 1, [story("S1")]))
        session.admit(fragment("consumer", 2, [story("S2", ["S1"])]))
        assert.deepEqual(session.snapshot().stories.map((item) => item.id), ["S1", "S2"])
    })

    it("enforces add-only story identity and continuous ordinals", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        session.admit(fragment("fragment-1", 1, [story("S1")]))

        expectCode(
            () => session.admit(fragment("gap", 3, [story("S2")])),
            "non_contiguous_ordinal",
        )
        expectCode(
            () => session.admit(fragment("duplicate", 2, [story("S1")])),
            "duplicate_story",
        )
        expectCode(
            () => session.admit(fragment("within", 2, [story("S2"), story("S2")])),
            "duplicate_story",
        )
        assert.equal(session.nextOrdinal, 2)
    })

    it("treats canonical fragment replay as idempotent and ID reuse as conflict", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        const original = fragment("fragment-1", 1, [story("S1")])
        const admitted = session.admit(original)
        const reorderedKeys = {
            stories: [story("S1")],
            ordinal: 1,
            fragmentId: "fragment-1",
            planningSessionId: "planning-1",
            schemaVersion: 1,
        }
        const replay = session.admit(reorderedKeys)

        assert.equal(replay.disposition, "replayed")
        assert.equal(replay.fingerprint, admitted.fingerprint)
        assert.equal(
            progressivePlanFragmentFingerprint(original),
            progressivePlanFragmentFingerprint(reorderedKeys),
        )
        expectCode(
            () => session.admit(
                fragment("fragment-1", 1, [story("S1", [], { title: "changed" })]),
            ),
            "fragment_conflict",
        )
        assert.equal(session.nextOrdinal, 2)
    })

    it("binds every fragment to the opened session and exact v1 shape", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        expectCode(
            () => session.admit({
                ...fragment("wrong-session", 1, [story("S1")]),
                planningSessionId: "planning-2",
            }),
            "session_mismatch",
        )
        expectCode(
            () => validateProgressivePlanFragment({
                ...fragment("unknown-key", 1, [story("S1")]),
                provisional: true,
            }),
            "invalid_fragment",
        )
        expectCode(
            () => validateProgressivePlanFragment(
                fragment("executed", 1, [
                    story("S1", [], {
                        passes: true,
                        completedAt: "2026-07-15T00:00:00.000Z",
                    }),
                ]),
            ),
            "invalid_fragment",
        )
    })

    it("reconciles an exact admitted prefix, returns the final tail, and closes", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        const s1 = story("S1")
        const s2 = story("S2", ["S1"])
        session.admit(fragment("fragment-1", 1, [s1]))
        session.admit(fragment("fragment-2", 2, [s2]))

        const final = finalPrd([
            story("S1"),
            story("S2", ["S1"]),
            story("S3", ["S2"]),
        ])
        const reconciled = session.reconcile(final)
        const replayed = session.reconcile(final)

        assert.equal(reconciled.disposition, "reconciled")
        assert.equal(replayed.disposition, "replayed")
        assert.equal(reconciled.admittedStoryCount, 2)
        assert.equal(reconciled.finalStoryCount, 3)
        assert.deepEqual(reconciled.tail, [story("S3", ["S2"])])
        assert.deepEqual(replayed.tail, reconciled.tail)
        assert.equal(session.phase, "reconciled")
        expectCode(
            () => session.admit(fragment("late", 3, [story("S3", ["S2"])])),
            "session_closed",
        )
        expectCode(
            () => session.reconcile(finalPrd([story("S1")])),
            "final_prd_conflict",
        )
    })

    it("allows a nonempty final tail but rejects missing, reordered, or changed prefix", () => {
        const admitted = [story("S1"), story("S2", ["S1"])]
        const withTail = reconcileProgressivePlanStories(
            admitted,
            finalPrd([...admitted, story("S3", ["S2"])]),
        )
        assert.deepEqual(withTail.tail, [story("S3", ["S2"])])
        assert.deepEqual(withTail.finalStories, [...admitted, story("S3", ["S2"])])

        for (const candidate of [
            [story("S1")],
            [admitted[1]!, admitted[0]!],
            [story("S1", [], { title: "changed" }), admitted[1]!],
        ]) {
            expectCode(
                () => reconcileProgressivePlanStories(admitted, finalPrd(candidate)),
                "final_prd_mismatch",
            )
        }

        expectCode(
            () => reconcileProgressivePlanStories(
                admitted,
                finalPrd([
                    ...admitted,
                    story("S3", ["S2"], {
                        passes: true,
                        completedAt: "2026-07-15T00:00:00.000Z",
                    }),
                ]),
            ),
            "invalid_final_prd",
        )
    })

    it("restores open admission and replay identity from a validated durable snapshot", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        session.admit(fragment("fragment-1", 1, [story("S1")]))
        session.admit(fragment("fragment-2", 2, [story("S2", ["S1"])]))
        const durable = JSON.parse(JSON.stringify(session.snapshot()))

        const restored = restoreProgressivePlanSession(durable)
        assert.deepEqual(restored.snapshot(), session.snapshot())
        assert.equal(
            restored.admit(fragment("fragment-1", 1, [story("S1")])).disposition,
            "replayed",
        )
        restored.admit(fragment("fragment-3", 3, [story("S3", ["S2"])]))
        assert.deepEqual(
            restored.snapshot().stories.map((item) => item.id),
            ["S1", "S2", "S3"],
        )
    })

    it("restores reconciled tails, including a zero-fragment fallback session", () => {
        const streamed = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        streamed.admit(fragment("fragment-1", 1, [story("S1")]))
        const final = finalPrd([story("S1"), story("S2", ["S1"])])
        streamed.reconcile(final)

        const restored = restoreProgressivePlanSession(streamed.snapshot())
        assert.deepEqual(restored.snapshot(), streamed.snapshot())
        assert.deepEqual(restored.reconcile(final).tail, [story("S2", ["S1"])])

        const fallback = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-fallback",
        })
        const fallbackFinal = finalPrd([story("S1")])
        fallback.reconcile(fallbackFinal)
        const fallbackRestored = restoreProgressivePlanSession(fallback.snapshot())
        assert.equal(fallbackRestored.phase, "reconciled")
        assert.deepEqual(fallbackRestored.reconcile(fallbackFinal).tail, [story("S1")])
    })

    it("rejects structurally or semantically inconsistent durable snapshots", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        session.admit(fragment("fragment-1", 1, [story("S1")]))
        const snapshot = session.snapshot()

        const wrongNext = structuredClone(snapshot)
        wrongNext.nextOrdinal = 9
        expectCode(() => restoreProgressivePlanSession(wrongNext), "invalid_snapshot")

        const wrongFingerprint = structuredClone(snapshot)
        wrongFingerprint.fragments[0]!.fingerprint = "0".repeat(64)
        expectCode(
            () => restoreProgressivePlanSession(wrongFingerprint),
            "invalid_snapshot",
        )

        const forwardReference = structuredClone(snapshot)
        forwardReference.stories[0]!.dependsOn = ["future-story"]
        forwardReference.fragments[0]!.fingerprint = progressivePlanFragmentFingerprint({
            schemaVersion: 1,
            planningSessionId: "planning-1",
            fragmentId: "fragment-1",
            ordinal: 1,
            stories: forwardReference.stories,
        })
        expectCode(
            () => restoreProgressivePlanSession(forwardReference),
            "invalid_snapshot",
        )

        const contradictoryOpen = structuredClone(snapshot)
        contradictoryOpen.finalTail = []
        expectCode(
            () => restoreProgressivePlanSession(contradictoryOpen),
            "invalid_snapshot",
        )
    })

    it("uses the complete nonempty final PRD as tail when no backend fragments streamed", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        const final = [story("S1"), story("S2", ["S1"])]
        const result = session.reconcile(finalPrd(final))

        assert.equal(result.admittedStoryCount, 0)
        assert.equal(result.finalStoryCount, 2)
        assert.deepEqual(result.tail, final)
        assert.equal(session.phase, "reconciled")
    })

    it("rejects only a completely empty final plan", () => {
        const session = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: "planning-1",
        })
        expectCode(() => session.reconcile(finalPrd([])), "empty_plan")
        assert.equal(session.phase, "open")
    })
})
