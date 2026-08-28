import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import type { SemanticEvent } from "../../src/runtime/mozaik.js"

import { ProgressivePlanningCoordinator } from "../../src/planning/application/progressive-planning-coordinator.js"
import { evaluateFinalTailTolerance } from "../../src/planning/domain/final-tail-tolerance.js"
import {
    progressivePlanFragmentFingerprint,
    reconcileProgressivePlanStories,
} from "../../src/planning/domain/progressive-plan.js"
import { renderArchitectureObligationCriterion } from "../../src/planning/domain/architecture-obligation-contract.js"
import { deriveGoalContract } from "../../src/goal/goal-contract.js"
import type {
    PrdFile,
    PrdProgressivePlanningState,
    PrdStory,
} from "../../src/prd.js"
import {
    PlanningStreamClosed,
    PlanningStreamCompleted,
    PlanFragmentRejected,
    RuntimeReplanApplied,
} from "../../src/semantic-events.js"
import type { ProgressivePlanningBoardPhase } from "../../src/planning/application/progressive-planning-coordinator.js"

const RUN_ID = "run-final-tail"
const PLANNING_ID = "planning-final-tail"

describe("final planner tail admission", () => {
    // run-19681: both admitted stories had settled and merged, the board had
    // already moved to phase "pushing", and the tail proposed ~2s later hit the
    // very first gate in onPlanFragmentProposed. The whole run died on
    // "the final planner tail could not be durably admitted".
    it("closes planning completed when the rejected tail is redundant", () => {
        const harness = buildHarness({ phase: "pushing" })

        harness.complete()

        assert.equal(harness.planning().status, "completed")
        assert.equal(harness.planning().terminalReason, undefined)
        assert.equal(harness.closed()?.status, "completed")

        const rejected = harness.rejections()
        assert.equal(rejected.length, 1)
        assert.equal(rejected[0]?.code, "planning_not_open")
        assert.equal(
            rejected[0]?.reason,
            "the collective run is not accepting planner fragments",
        )

        const discarded = harness.discards()
        assert.equal(discarded.length, 1, "exactly one FinalTailDiscarded")
        assert.deepEqual(discarded[0]?.storyIds, ["S2"])
        assert.equal(discarded[0]?.code, "planning_not_open")
        assert.equal(
            discarded[0]?.reason,
            "the collective run is not accepting planner fragments",
        )
        assert.equal(discarded[0]?.ordinal, 2)
        assert.match(String(discarded[0]?.fragmentId), /^final-[0-9a-f]{64}$/)

        assert.equal(
            harness.toleranceCalls().length,
            1,
            "tolerance is consulted exactly once, on the rejection",
        )

        const activity = harness.activity()
        assert.equal(activity.length, 1)
        assert.equal(activity[0]?.kind, "warn")
        assert.match(activity[0]?.text ?? "", /dropped stories: S2/)
        assert.match(activity[0]?.text ?? "", /planning_not_open/)
        assert.match(
            activity[0]?.text ?? "",
            /the collective run is not accepting planner fragments/,
        )
    })

    it("still fails planning when the rejected tail owns an unowned obligation", () => {
        const harness = buildHarness({ phase: "pushing", obligations: true })

        harness.complete()

        const planning = harness.planning()
        assert.equal(planning.status, "failed")
        const reason = planning.terminalReason ?? ""
        assert.match(reason, /^final_tail_rejected: /)
        assert.match(reason, /planning_not_open/)
        assert.match(
            reason,
            /the collective run is not accepting planner fragments/,
        )
        assert.match(reason, /obligation_unowned/)
        assert.match(reason, /no story owns: O-002/)
        assert.doesNotMatch(reason, /could not be durably admitted/)
        assert.equal(harness.closed()?.status, "failed")

        // The board rejection is still traced, and nothing was discarded.
        assert.equal(harness.rejections().length, 1)
        assert.equal(harness.rejections()[0]?.code, "planning_not_open")
        assert.equal(harness.discards().length, 0)

        assert.equal(harness.toleranceCalls().length, 1)

        const activity = harness.activity()
        assert.equal(activity.length, 1)
        assert.equal(activity[0]?.kind, "error")
        assert.match(activity[0]?.text ?? "", /planning_not_open/)
        assert.match(activity[0]?.text ?? "", /blocker: obligation_unowned/)
    })

    // The replay branch admits nothing new and leaves nextOrdinal untouched, so
    // the old snapshot comparison failed a legitimately replayed tail. The
    // admitted story here is deliberately unsettled: tolerance would block if it
    // were consulted, and planning still completes because it is not.
    it("completes on a replayed tail without discarding anything", () => {
        const harness = buildHarness({ phase: "running", replayTail: true })

        assert.equal(
            evaluateFinalTailTolerance({
                prd: harness.prd(),
                admittedStoryIds: harness.planning().admittedStoryIds,
                goalContract: deriveGoalContract(harness.prd().goalEnvelope),
            }).tolerated,
            false,
            "tolerance would have blocked had the replay path consulted it",
        )

        harness.complete()

        assert.deepEqual(
            harness.toleranceCalls(),
            [],
            "a replayed tail never consults tolerance",
        )
        assert.equal(harness.planning().status, "completed")
        assert.equal(harness.planning().nextOrdinal, 2, "replay advances nothing")
        assert.equal(harness.discards().length, 0)
        assert.equal(harness.rejections().length, 0)
        assert.deepEqual(harness.activity(), [])
    })

    // Same guard on the admitted path: an unsettled admitted story would block
    // tolerance, yet a genuinely admitted tail closes planning completed.
    it("completes on an admitted tail without consulting tolerance", () => {
        const harness = buildHarness({ phase: "running", admitTail: true })

        assert.equal(
            evaluateFinalTailTolerance({
                prd: harness.prd(),
                admittedStoryIds: harness.planning().admittedStoryIds,
                goalContract: deriveGoalContract(harness.prd().goalEnvelope),
            }).tolerated,
            false,
            "tolerance would have blocked had the admitted path consulted it",
        )

        harness.complete()

        assert.deepEqual(
            harness.toleranceCalls(),
            [],
            "an admitted tail never consults tolerance",
        )
        assert.equal(harness.planning().status, "completed")
        assert.deepEqual(harness.planning().admittedStoryIds, ["S1", "S2"])
        assert.equal(harness.discards().length, 0)
        assert.equal(harness.rejections().length, 0)
        assert.deepEqual(harness.activity(), [])
    })
    // What makes the method spy above a spy on the tolerance function: there is
    // one call site, it lives in discardRedundantFinalTail, and that method is
    // reached only from the rejected branch of the tail block.
    it("keeps evaluateFinalTailTolerance to one call site, in the rejected branch", () => {
        const source = readFileSync(
            new URL(
                "../../src/planning/application/progressive-planning-coordinator.ts",
                import.meta.url,
            ),
            "utf8",
        )
        assert.equal(
            (source.match(/evaluateFinalTailTolerance\(/g) ?? []).length,
            1,
        )
        assert.equal(
            (source.match(/this\.discardRedundantFinalTail\(/g) ?? []).length,
            1,
        )
        const discardBody = source.slice(
            source.indexOf("private discardRedundantFinalTail("),
            source.indexOf("private onPlanningStreamFailed("),
        )
        assert.match(discardBody, /evaluateFinalTailTolerance\(/)
        const tailBlock = source.slice(
            source.indexOf("const tail = finalStories.slice("),
            source.indexOf("private discardRedundantFinalTail("),
        )
        assert.match(
            tailBlock,
            /admission\.status === "rejected"[\s\S]*?this\.discardRedundantFinalTail\(/,
        )
    })
})

describe("evaluateFinalTailTolerance", () => {
    it("tolerates a settled, fully-owning admitted set", () => {
        assert.deepEqual(
            evaluateFinalTailTolerance({
                prd: toleranceFixture(),
                admittedStoryIds: ["S1"],
                goalContract: deriveGoalContract(GOAL_ENVELOPE),
            }),
            { tolerated: true },
        )
    })

    it("blocks on an unsettled admitted story", () => {
        const prd = toleranceFixture()
        prd.userStories[0]!.passes = false
        const result = evaluateFinalTailTolerance({
            prd,
            admittedStoryIds: ["S1"],
            goalContract: deriveGoalContract(GOAL_ENVELOPE),
        })
        assert.equal(result.tolerated, false)
        assert.equal(result.blocker, "unsettled_stories")
        assert.equal(result.detail, "S1")
    })

    it("blocks on an admitted story id the PRD does not carry", () => {
        const result = evaluateFinalTailTolerance({
            prd: toleranceFixture(),
            admittedStoryIds: ["S1", "S9"],
            goalContract: deriveGoalContract(GOAL_ENVELOPE),
        })
        assert.equal(result.tolerated, false)
        assert.equal(result.blocker, "unsettled_stories")
        assert.equal(result.detail, "S9")
    })

    // A merge that failed is unfinished work, not a settled story.
    it("blocks on a story whose merge failed", () => {
        const prd = toleranceFixture()
        prd.userStories[0]!.passes = false
        prd.userStories[0]!.mergeStatus = "failed"
        const result = evaluateFinalTailTolerance({
            prd,
            admittedStoryIds: ["S1"],
            goalContract: deriveGoalContract(GOAL_ENVELOPE),
        })
        assert.equal(result.tolerated, false)
        assert.equal(result.blocker, "unsettled_stories")
    })

    it("blocks when no admitted story owns an obligation", () => {
        const contract = deriveGoalContract(TWO_CRITERIA_ENVELOPE)!
        const prd: PrdFile = {
            ...bootstrapPrd(),
            goalEnvelope: TWO_CRITERIA_ENVELOPE,
            decisionDocument: obligationDecisionDocument(),
            userStories: [
                {
                    ...story("S1", [], {
                        acceptance: [criterionFor("O-001")],
                        goalInvariantIds: ["G-A1"],
                    }),
                    passes: true,
                },
            ],
        }
        const result = evaluateFinalTailTolerance({
            prd,
            admittedStoryIds: ["S1"],
            goalContract: contract,
        })
        assert.equal(result.tolerated, false)
        assert.equal(result.blocker, "obligation_unowned")
        assert.match(result.detail, /no story owns: O-002/)
    })

    it("blocks when the admitted set leaves a goal invariant uncovered", () => {
        const prd: PrdFile = {
            ...bootstrapPrd(),
            goalEnvelope: TWO_CRITERIA_ENVELOPE,
            userStories: [
                {
                    ...story("S1", [], { goalInvariantIds: ["G-A1"] }),
                    passes: true,
                },
            ],
        }
        const result = evaluateFinalTailTolerance({
            prd,
            admittedStoryIds: ["S1"],
            goalContract: deriveGoalContract(TWO_CRITERIA_ENVELOPE),
        })
        assert.equal(result.tolerated, false)
        assert.equal(result.blocker, "goal_contract_incomplete")
        assert.match(result.detail, /no story owns invariant\(s\): G-A2/)
    })

    // First blocker wins: an unsettled story is reported even though the
    // admitted set also fails obligation coverage.
    it("reports the first blocker when several apply", () => {
        const prd: PrdFile = {
            ...bootstrapPrd(),
            goalEnvelope: TWO_CRITERIA_ENVELOPE,
            decisionDocument: obligationDecisionDocument(),
            userStories: [
                story("S1", [], {
                    acceptance: [criterionFor("O-001")],
                    goalInvariantIds: ["G-A1"],
                }),
            ],
        }
        const result = evaluateFinalTailTolerance({
            prd,
            admittedStoryIds: ["S1"],
            goalContract: deriveGoalContract(TWO_CRITERIA_ENVELOPE),
        })
        assert.equal(result.tolerated, false)
        assert.equal(result.blocker, "unsettled_stories")
    })
})

const GOAL_ENVELOPE = {
    objective: "Keep the final tail honest.",
    acceptanceCriteria: ["First behavior"],
    constraints: [],
    nonGoals: [],
    assumptions: [],
}

const TWO_CRITERIA_ENVELOPE = {
    objective: "Keep the final tail honest.",
    acceptanceCriteria: ["First behavior", "Second behavior"],
    constraints: [],
    nonGoals: [],
    assumptions: [],
}

const OBLIGATIONS = [
    {
        id: "O-001",
        invariantIds: ["G-A1"],
        subject: "the admitted prefix",
        scenario: "S1 lands",
        expectedOutcome: "the first behavior is observable",
        evidence: ["npm test -- S1"],
    },
    {
        id: "O-002",
        invariantIds: ["G-A2"],
        subject: "the planner tail",
        scenario: "S2 lands",
        expectedOutcome: "the second behavior is observable",
        evidence: ["npm test -- S2"],
    },
]

function criterionFor(id: string): string {
    const obligation = OBLIGATIONS.find((entry) => entry.id === id)!
    return renderArchitectureObligationCriterion(obligation)
}

function obligationDecisionDocument(): string {
    const json = JSON.stringify({ schemaVersion: 1, obligations: OBLIGATIONS })
    return `Keep the public API additive.\n\n\`\`\`baro-obligations-v1\n${json}\n\`\`\`\n`
}

function bootstrapPrd(userStories: PrdStory[] = []): PrdFile {
    return {
        project: "progressive-final-tail",
        branchName: "baro/progressive-final-tail",
        description: "Exercise the final planner tail.",
        decisionDocument: "Keep the public API additive.",
        executionMode: {
            mode: "parallel",
            reason: "independent safe prefixes may execute early",
            maxStories: 8,
            source: "llm",
        },
        userStories,
    }
}

function story(
    id: string,
    dependsOn: string[] = [],
    overrides: Partial<PrdStory> = {},
): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")) || 1,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
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

function toleranceFixture(): PrdFile {
    return {
        ...bootstrapPrd([
            {
                ...story("S1", [], { goalInvariantIds: ["G-A1"] }),
                passes: true,
            },
        ]),
        goalEnvelope: GOAL_ENVELOPE,
    }
}

interface HarnessOptions {
    phase: ProgressivePlanningBoardPhase
    /** Fence an obligation contract so the tail owns O-002 alone. */
    obligations?: boolean
    /** Pre-record the final fragment so the tail replays instead of admitting. */
    replayTail?: boolean
    /** Let admitGraph apply, so the tail is genuinely admitted. */
    admitTail?: boolean
}

interface Harness {
    complete(): void
    prd(): PrdFile
    planning(): PrdProgressivePlanningState
    closed(): { status: string; reason?: string } | undefined
    rejections(): { code: string; reason: string }[]
    discards(): {
        storyIds: readonly string[]
        code: string
        reason: string
        fragmentId: string
        ordinal: number
    }[]
    activity(): { kind: string; text: string }[]
    /** Recorded invocations of the sole evaluateFinalTailTolerance call site. */
    toleranceCalls(): unknown[][]
}

function buildHarness(options: HarnessOptions): Harness {
    const goalEnvelope = options.obligations
        ? TWO_CRITERIA_ENVELOPE
        : GOAL_ENVELOPE
    const authoredS1 = story("S1", [], {
        ...(options.obligations
            ? { acceptance: [criterionFor("O-001")], goalInvariantIds: ["G-A1"] }
            : { goalInvariantIds: ["G-A1"] }),
    })
    const authoredS2 = story("S2", ["S1"], {
        ...(options.obligations
            ? { acceptance: [criterionFor("O-002")], goalInvariantIds: ["G-A2"] }
            : { goalInvariantIds: ["G-A1"] }),
    })

    const finalPrd: PrdFile = {
        ...bootstrapPrd([authoredS1, authoredS2]),
        ...(options.obligations
            ? { decisionDocument: obligationDecisionDocument() }
            : {}),
        goalEnvelope,
    }

    // The admitted prefix is settled only where the scenario needs tolerance to
    // pass; the replay/admit scenarios deliberately leave it unsettled.
    const settled = !options.replayTail && !options.admitTail
    const runtimeS1: PrdStory = {
        ...structuredClone(authoredS1),
        ...(settled ? { passes: true, mergeStatus: "merged" as const } : {}),
    }

    const fragments: PrdProgressivePlanningState["fragments"] = [
        {
            fragmentId: "fragment-1",
            ordinal: 1,
            fingerprint: "fingerprint-1",
            storyIds: ["S1"],
            graphVersion: 2,
            authoredStories: [structuredClone(authoredS1)],
        },
    ]
    if (options.replayTail) {
        const authoredPrefix = [authoredS1, authoredS2]
        const finalStories = reconcileProgressivePlanStories(
            authoredPrefix,
            finalPrd,
        ).finalStories
        const fragmentId = `final-${createHash("sha256")
            .update(JSON.stringify(finalStories), "utf8")
            .digest("hex")}`
        const tail = finalStories.slice(1)
        fragments.push({
            fragmentId,
            ordinal: 2,
            fingerprint: progressivePlanFragmentFingerprint({
                schemaVersion: 1,
                planningSessionId: PLANNING_ID,
                fragmentId,
                ordinal: 2,
                stories: tail,
            }),
            storyIds: ["S2"],
            graphVersion: 3,
            authoredStories: [structuredClone(authoredS2)],
        })
    }

    let prd: PrdFile = {
        ...bootstrapPrd([runtimeS1]),
        ...(options.obligations
            ? { decisionDocument: obligationDecisionDocument() }
            : {}),
        goalEnvelope,
        runtimeGraph: {
            runId: RUN_ID,
            version: 2,
            dynamicStories: 0,
            policyStories: 0,
            appliedDecisions: [],
            planning: {
                schemaVersion: 1,
                runId: RUN_ID,
                planningId: PLANNING_ID,
                status: "open",
                nextOrdinal: 2,
                admittedStoryIds: ["S1"],
                fragments,
            },
        },
    }

    const emitted: SemanticEvent<unknown>[] = []
    const activity: { kind: string; text: string }[] = []
    const coordinator = new ProgressivePlanningCoordinator({
        runId: RUN_ID,
        planningId: PLANNING_ID,
        host: {
            snapshot: () => ({
                phase: options.phase,
                prd,
                graphVersion: prd.runtimeGraph?.version ?? 2,
                wave: null,
            }),
            commitPrd: (value) => {
                prd = value
            },
            admitGraph: ({ proposal, planningState }) => {
                const next: PrdFile = {
                    ...prd,
                    userStories: [
                        ...prd.userStories,
                        ...proposal.mutation.addedStories.map((added) => ({
                            ...story(added.id, [...added.dependsOn]),
                            ...added,
                        })),
                    ],
                    runtimeGraph: {
                        ...prd.runtimeGraph!,
                        version: 3,
                        planning: planningState,
                    },
                }
                prd = next
                return {
                    event: RuntimeReplanApplied.create({
                        runId: RUN_ID,
                        proposalId: proposal.proposalId,
                        sourceStoryId: proposal.sourceStoryId,
                        leaseId: proposal.leaseId,
                        generation: proposal.generation,
                        baseGraphVersion: proposal.baseGraphVersion,
                        previousGraphVersion: proposal.baseGraphVersion,
                        graphVersion: 3,
                        reason: proposal.reason,
                        mutation: proposal.mutation,
                    }),
                    applied: {
                        prd: next,
                        addedStoryIds: proposal.mutation.addedStories.map(
                            ({ id }) => id,
                        ),
                        removedStoryIds: [],
                        modifiedStoryIds: [],
                        affectedStoryIds: proposal.mutation.addedStories.map(
                            ({ id }) => id,
                        ),
                    },
                }
            },
            emit: (event) => {
                emitted.push(event)
            },
            afterAdmission: () => undefined,
            afterClose: () => undefined,
            terminate: (reason) => {
                throw new Error(`unexpected terminate: ${reason}`)
            },
        },
    })

    // evaluateFinalTailTolerance is an ESM binding the coordinator imports
    // directly, so it cannot be replaced from a test. discardRedundantFinalTail
    // is its sole call site — asserted below — so shadowing that method on the
    // instance spies on the tolerance invocation itself.
    const toleranceCalls: unknown[][] = []
    const spied = coordinator as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >
    const realDiscard = spied.discardRedundantFinalTail!.bind(coordinator)
    spied.discardRedundantFinalTail = (...args: unknown[]) => {
        toleranceCalls.push(args)
        return realDiscard(...args)
    }

    return {
        toleranceCalls: () => toleranceCalls,
        complete: () => {
            const written = captureActivity(activity, () => {
                coordinator.handleEvent(
                    PlanningStreamCompleted.create({
                        runId: RUN_ID,
                        planningId: PLANNING_ID,
                        finalPrd,
                    }),
                )
            })
            assert.ok(written, "stdout capture was restored")
        },
        prd: () => prd,
        planning: () => prd.runtimeGraph!.planning!,
        closed: () =>
            emitted
                .filter((event) => PlanningStreamClosed.is(event))
                .map((event) => event.data)
                .at(-1),
        rejections: () =>
            emitted
                .filter((event) => PlanFragmentRejected.is(event))
                .map((event) => event.data),
        discards: () =>
            emitted
                .filter((event) => event.type === "final_tail_discarded")
                .map(
                    (event) =>
                        event.data as {
                            storyIds: readonly string[]
                            code: string
                            reason: string
                            fragmentId: string
                            ordinal: number
                        },
                ),
        activity: () => activity,
    }
}

/**
 * emitPlanActivity writes the `activity` BaroEvent straight to stdout, which is
 * exactly the surface run-19681 recorded. Intercepting the write is the only
 * way to observe it without a full board harness.
 */
function captureActivity(
    sink: { kind: string; text: string }[],
    run: () => void,
): boolean {
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        const line = typeof chunk === "string" ? chunk : String(chunk)
        try {
            const parsed = JSON.parse(line) as {
                type?: string
                id?: string
                kind?: string
                text?: string
            }
            if (parsed.type === "activity" && parsed.id === "plan") {
                sink.push({ kind: parsed.kind ?? "", text: parsed.text ?? "" })
                return true
            }
        } catch {
            /* not one of ours — pass it through */
        }
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write
    try {
        run()
    } finally {
        process.stdout.write = original
    }
    return true
}
