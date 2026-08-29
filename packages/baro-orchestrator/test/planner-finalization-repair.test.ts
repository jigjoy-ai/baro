import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { AgenticEnvironment, BaseObserver } from "../src/runtime/mozaik.js"
import type {
    AgenticEnvironment as Env,
    Participant,
} from "../src/runtime/mozaik.js"
import { AgentResult, PlanFragmentAdmitted } from "../src/semantic-events.js"
import { registerLane } from "../src/harness/lane-registry.js"
import type {
    HostFunction,
    InteractiveLaneAdapter,
    LaneCapability,
    LaneGrant,
} from "../src/harness/lane-adapter.js"
import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "../src/harness/interactive-participant.js"
import {
    runPlannerBusSession,
    unownedObligationsClause,
} from "../src/planning/adapters/planner-bus-session.js"
import { createPlannerHarnessProgressiveSupport } from "../src/planning/adapters/planner-harness-progressive.js"
import {
    buildFinalPrdRepairMessage,
    PLANNER_FINAL_PRD_SCHEMA_SUMMARY,
} from "../src/planning/domain/planner-prompts.js"
import {
    formatObligationIdList,
    obligationGapSummary,
    unownedObligationIds,
} from "../src/planning/domain/obligation-coverage-report.js"
import {
    ArchitectureObligationContractError,
    missingObligationIdsFromError,
    obligationMappingsForStories,
    renderArchitectureObligationCriterion,
    validateArchitectureObligationCoverage,
    type ArchitectureObligationContractV1,
} from "../src/planning/domain/architecture-obligation-contract.js"
import type { ContractDefect } from "../src/contract/contract-normalization.js"
import type {
    PlanCompleteCommand,
    PlanFailedCommand,
    PlanFragmentCommand,
    PlanningOpenCommand,
} from "../src/stdin-commands.js"
import type { GoalEnvelope } from "../src/conversation/session/conversation-contract.js"

const ENVELOPE: GoalEnvelope = {
    objective: "Repair a rejected final PRD instead of closing the stream.",
    constraints: ["Publish one fragment before the final PRD."],
    acceptanceCriteria: ["The rejected finalization is retried with defects."],
    nonGoals: [],
    assumptions: [],
}

const OBLIGATIONS: ArchitectureObligationContractV1 = {
    schemaVersion: 1,
    obligations: [
        {
            id: "O-001",
            invariantIds: ["G-A1"],
            subject: "the retry message",
            scenario: "a finalization attempt is rejected",
            expectedOutcome: "the message names every unowned obligation",
            evidence: ["test/planner-finalization-repair.test.ts"],
        },
        {
            id: "O-002",
            invariantIds: ["G-A1"],
            subject: "the terminal schema block",
            scenario: "any finalization rejection",
            expectedOutcome: "the message restates the terminal JSON shape",
            evidence: ["test/planner-finalization-repair.test.ts"],
        },
        {
            id: "O-003",
            invariantIds: ["G-C1"],
            subject: "the empty-tail composition failure",
            scenario: "composition is reached and throws",
            expectedOutcome: "the failure lists the unowned obligation ids",
            evidence: ["test/planner-finalization-repair.test.ts"],
        },
    ],
}

const DECISION_DOCUMENT = [
    "# Decision",
    "",
    "```baro-obligations-v1",
    JSON.stringify(OBLIGATIONS),
    "```",
    "",
].join("\n")

const PUBLISHED_STORY = {
    id: "S1",
    priority: 1,
    title: "Open the progressive contract",
    description: "Publish one closed story while planning continues.",
    dependsOn: [],
    retries: 2,
    acceptance: ["The story is visible before the final PRD resolves."],
    tests: ["npm test -- planner-finalization-repair"],
    goalInvariantIds: [],
    passes: false,
    completedAt: null,
    durationSecs: null,
    model: "heavy",
}

/** A tail story that claims every obligation canonically, as a repair must. */
const OWNER_TAIL_STORY = {
    id: "S2",
    priority: 2,
    title: "Own every architecture obligation",
    description: "Claim the obligations the published prefix left unowned.",
    dependsOn: ["S1"],
    retries: 2,
    acceptance: OBLIGATIONS.obligations.map(renderArchitectureObligationCriterion),
    tests: ["npm test -- planner-finalization-repair"],
    goalInvariantIds: ["G-A1", "G-C1"],
    model: "heavy",
}

const PRD_METADATA = {
    project: "baro",
    branchName: "bootstrap-branch",
    description: "Host-owned metadata.",
}

const finalPrd = (userStories: readonly unknown[]): string =>
    JSON.stringify({ ...PRD_METADATA, userStories })

const EMPTY_TAIL_PRD = finalPrd([])
const OWNED_TAIL_PRD = finalPrd([OWNER_TAIL_STORY])

class StubFeed extends BaseObserver {
    readonly opened: PlanningOpenCommand[] = []
    readonly fragments: PlanFragmentCommand[] = []
    readonly completions: PlanCompleteCommand[] = []
    readonly failures: PlanFailedCommand[] = []

    open(command: PlanningOpenCommand): void {
        this.opened.push(command)
    }

    fragment(command: PlanFragmentCommand): void {
        this.fragments.push(command)
        const admitted = PlanFragmentAdmitted.create({
            runId: command.run_id,
            planningId: command.planning_id,
            fragmentId: command.fragment_id,
            ordinal: command.ordinal,
            graphVersion: 7,
            storyIds: command.stories.map((story) => story.id),
            replay: false,
            droppedEdges: [],
        })
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, admitted)
        }
    }

    complete(command: PlanCompleteCommand): void {
        this.completions.push(command)
    }

    failed(command: PlanFailedCommand): void {
        this.failures.push(command)
    }
}

interface ArmedPlan {
    /** One reply per host message, in order. */
    readonly script: readonly string[]
    readonly publishFragment: boolean
    readonly prompts: string[]
    hostFunction?: HostFunction
    publishError?: unknown
}

/**
 * The planner reduced to what the finalization loop needs: it answers the next
 * scripted line whenever the host says something, publishes one fragment
 * through the granted host function first, and keeps every prompt the host
 * sent so a test can read the repair text verbatim. No process, no provider.
 */
class ScriptedPlannerParticipant
    extends BaseObserver
    implements InteractiveModelParticipant<unknown>
{
    readonly done: Promise<unknown>
    onActivity: (() => void) | null = null
    private settle!: () => void
    private env: Env | null = null
    private spoken = 0
    private turns: Promise<void> = Promise.resolve()

    constructor(
        readonly agentId: string,
        private readonly plan: ArmedPlan,
    ) {
        super()
        this.done = new Promise<unknown>((resolve) => {
            this.settle = () => resolve(null)
        })
    }

    start(environment: Env): void {
        this.env = environment
    }

    sendUserMessage(text: string): void {
        this.plan.prompts.push(text)
        const reply = this.plan.script[this.spoken]
        if (reply === undefined || this.env === null) return
        const first = this.spoken === 0
        this.spoken += 1
        const turn = this.spoken
        this.turns = this.turns.then(async () => {
            if (first && this.plan.publishFragment) {
                try {
                    await this.plan.hostFunction?.invoke({
                        fragmentId: "foundation",
                        stories: [PUBLISHED_STORY],
                    })
                } catch (error) {
                    this.plan.publishError = error
                }
            }
            this.env?.deliverSemanticEvent(
                this as unknown as Participant,
                AgentResult.create({
                    agentId: this.agentId,
                    terminalId: `${this.agentId}:turn-${turn}`,
                    subtype: "success",
                    sessionId: null,
                    isError: false,
                    resultText: reply,
                    usage: null,
                    totalCostUsd: null,
                    numTurns: null,
                    durationMs: null,
                }),
            )
        })
        void this.turns.catch((error) => {
            this.plan.publishError ??= error
        })
    }

    closeStdin(): void {
        this.settle()
    }

    async abortAndWait(): Promise<boolean> {
        this.settle()
        return true
    }

    sessionEndDetail(): string {
        return "scripted planner participant ended"
    }
}

/** Both lanes reach the same finalization loop; only the grant shape differs. */
class ScriptedPlannerLane implements InteractiveLaneAdapter {
    constructor(
        readonly backend: string,
        private readonly shape: "cli" | "native",
    ) {}

    async grant(capabilities: readonly LaneCapability[]): Promise<LaneGrant> {
        for (const capability of capabilities) {
            if (capability.kind === "host-function" && armed) {
                armed.hostFunction = capability.fn
            }
        }
        return this.shape === "cli"
            ? { cliExtraArgs: ["--allowed-tools", "publish_plan_fragment"], close: async () => {} }
            : { tools: [], close: async () => {} }
    }

    create(
        request: InteractiveParticipantRequest,
    ): InteractiveModelParticipant<unknown> {
        if (armed === null) throw new Error("no planner script is armed")
        return new ScriptedPlannerParticipant(request.agentId, armed)
    }
}

let armed: ArmedPlan | null = null
const CLI_LANE = "fake-planner-cli"
const NATIVE_LANE = "fake-planner-native"
registerLane(CLI_LANE, () => new ScriptedPlannerLane(CLI_LANE, "cli"))
registerLane(NATIVE_LANE, () => new ScriptedPlannerLane(NATIVE_LANE, "native"))

class SessionRun {
    constructor(
        readonly feed: StubFeed,
        readonly prompts: string[],
        readonly plan: ArmedPlan,
        readonly result: { status: string; reason?: string },
    ) {}

    get repairPrompts(): string[] {
        return this.prompts.slice(1)
    }

    get failureReason(): string {
        assert.equal(this.feed.failures.length, 1)
        return this.feed.failures[0]!.reason
    }
}

async function runSession(input: {
    script: readonly string[]
    publishFragment?: boolean
    decisionDocument?: string
    backend?: string
}): Promise<SessionRun> {
    const prompts: string[] = []
    const plan: ArmedPlan = {
        script: input.script,
        publishFragment: input.publishFragment !== false,
        prompts,
    }
    armed = plan
    const env = new AgenticEnvironment("planner-finalization-repair")
    const feed = new StubFeed()
    feed.join(env)
    try {
        const result = await runPlannerBusSession({
            runId: "run-repair-1",
            cwd: process.cwd(),
            env,
            feed,
            goalEnvelope: ENVELOPE,
            prdMetadata: PRD_METADATA,
            backend: input.backend ?? CLI_LANE,
            idleTimeoutMs: 30_000,
            ...(input.decisionDocument !== undefined
                ? { decisionDocument: input.decisionDocument }
                : {}),
        })
        assert.equal(plan.publishError, undefined)
        return new SessionRun(feed, prompts, plan, result)
    } finally {
        armed = null
    }
}

const PROSE = "The plan is complete and no further planning output is pending."

describe("planner finalization repair prompt", () => {
    // O-001/O-002/O-003/O-026/O-027: one rejection produces one repair round
    // carrying the whole defect list, every unowned id, and the terminal shape.
    it("names every unowned obligation id, the defects and the schema", async () => {
        const run = await runSession({
            script: [EMPTY_TAIL_PRD, OWNED_TAIL_PRD],
            decisionDocument: DECISION_DOCUMENT,
        })

        assert.equal(run.result.status, "completed")
        assert.equal(run.repairPrompts.length, 1)
        const repair = run.repairPrompts[0]!
        assert.ok(
            repair.startsWith(
                "Your final PRD was rejected. Fix every defect listed below in one reply.\n\n",
            ),
        )
        assert.ok(repair.includes("Defects ("))
        assert.ok(repair.includes("Unowned architecture obligations (3):"))
        for (const id of ["O-001", "O-002", "O-003"]) {
            assert.ok(repair.includes(id), `repair prompt omits ${id}`)
        }
        assert.ok(
            repair.includes(
                "Every id above must be claimed by an acceptance criterion of a " +
                    "story in THIS reply — already-published stories are immutable " +
                    "and cannot take them later.",
            ),
        )
        assert.ok(repair.includes("Expected schema:"))
        for (const line of PLANNER_FINAL_PRD_SCHEMA_SUMMARY.split("\n")) {
            assert.ok(repair.includes(line), `repair prompt omits schema line: ${line}`)
        }
        assert.ok(
            repair.includes("Anything that is not that JSON object is discarded."),
        )
        // The corrected reply lands inside the shipped attempt budget.
        assert.equal(run.feed.completions.length, 1)
        assert.deepEqual(
            (
                run.feed.completions[0]!.final_prd as {
                    userStories: Array<{ id: string }>
                }
            ).userStories.map((story) => story.id),
            ["S1", "S2"],
        )
    })

    // O-023: the claude/bus lane and the native progressive lane share this
    // finalization path, so both are handed the identical repair message.
    it("delivers the same repair message on both lanes", async () => {
        const cli = await runSession({
            script: [EMPTY_TAIL_PRD, OWNED_TAIL_PRD],
            decisionDocument: DECISION_DOCUMENT,
        })
        const native = await runSession({
            script: [EMPTY_TAIL_PRD, OWNED_TAIL_PRD],
            decisionDocument: DECISION_DOCUMENT,
            backend: NATIVE_LANE,
        })

        assert.equal(cli.result.status, "completed")
        assert.equal(native.result.status, "completed")
        assert.equal(native.repairPrompts[0], cli.repairPrompts[0])
    })

    // O-008: prose first, corrected JSON second — inside maxFinalizationAttempts.
    it("recovers from a prose-only final response within the attempt budget", async () => {
        const run = await runSession({ script: [PROSE, EMPTY_TAIL_PRD] })

        assert.deepEqual(run.feed.failures, [])
        assert.equal(run.result.status, "completed")
        assert.equal(run.feed.completions.length, 1)
        assert.equal(run.repairPrompts.length, 1, "one repair round, not two")
        const repair = run.repairPrompts[0]!
        assert.ok(repair.includes("Defects (1):"))
        assert.ok(repair.includes("- no valid JSON object in response:"))
        // Nothing is unowned without an obligation contract: no empty section.
        assert.ok(!repair.includes("Unowned architecture obligations ("))
        // O-003: the schema block is unconditional.
        assert.ok(
            repair.includes(`Expected schema:\n${PLANNER_FINAL_PRD_SCHEMA_SUMMARY}`),
        )
    })

    // O-004/O-009/O-022: composition stays fail-closed and now says which
    // obligations were unowned and what would have made it succeed.
    it("lists the unowned ids when empty-tail composition fails", async () => {
        const run = await runSession({
            script: [PROSE, PROSE, PROSE],
            decisionDocument: DECISION_DOCUMENT,
        })

        assert.equal(run.result.status, "failed")
        assert.equal(run.feed.completions.length, 0)
        assert.equal(run.feed.failures[0]!.code, "planner_failed")
        const reason = run.failureReason
        assert.ok(reason.startsWith("no valid JSON object in response:"))
        assert.ok(reason.includes("; host empty-tail composition also failed: "))
        assert.ok(reason.includes("unowned architecture obligations (3): "))
        for (const id of ["O-001", "O-002", "O-003"]) {
            assert.ok(reason.includes(id), `composition failure omits ${id}`)
        }
        assert.ok(
            reason.endsWith(
                "composition would have succeeded only if a story published " +
                    "before the tail had claimed each of these ids in its " +
                    "acceptance text — published stories are immutable, so this " +
                    "cannot be repaired after the fact",
            ),
        )
        // O-015: composition was reached only after the model had been given
        // the repair information — two repair rounds precede it. A prose
        // rejection carries no coverage error, so the ids reach the prompt
        // through the progressive controller rather than the error.
        assert.equal(run.repairPrompts.length, 2)
        for (const repair of run.repairPrompts) {
            assert.ok(repair.includes("Defects (1):"))
            assert.ok(repair.includes("Expected schema:"))
            assert.ok(
                repair.includes("Anything that is not that JSON object is discarded."),
            )
        }
    })

    // O-016/O-020: a candidate that PARSED and was rejected carries planner
    // intent; the host refuses it outright instead of composing over it.
    it("refuses a parsed-but-rejected candidate without composing", async () => {
        const run = await runSession({
            script: [EMPTY_TAIL_PRD, EMPTY_TAIL_PRD, EMPTY_TAIL_PRD],
            decisionDocument: DECISION_DOCUMENT,
        })

        assert.equal(run.result.status, "failed")
        assert.equal(run.feed.completions.length, 0)
        assert.equal(run.feed.failures[0]!.code, "planner_failed")
        assert.equal(
            run.failureReason,
            "architecture obligation coverage is incomplete; no story owns: " +
                "O-001, O-002, O-003",
        )
        // Composition of the same prefix would have failed on the same
        // coverage error and appended its clause; neither is present, so
        // reconcileFinalCandidate was never called for a composed tail.
        assert.ok(!run.failureReason.includes("host empty-tail composition"))
        assert.ok(!run.failureReason.includes("unowned architecture obligations ("))
        assert.equal(
            run.result.reason,
            `planner_failed: ${run.failureReason}`,
        )
    })

    // O-010: an empty resolved id list appends nothing at all.
    it("appends no obligation clause when no id resolves", () => {
        assert.equal(unownedObligationsClause([]), "")
        const clause = unownedObligationsClause(["O-002", "O-005"])
        assert.ok(clause.startsWith("; unowned architecture obligations (2): O-002, O-005; "))
        assert.ok(clause.endsWith("cannot be repaired after the fact"))
    })
})

describe("final PRD repair message", () => {
    // O-027: the defect list is rendered by the shared contract primitives.
    it("renders carried defects in the shared `- path: message` format", () => {
        const defects: readonly ContractDefect[] = [
            { path: "userStories[0]", message: "userStories[0].id is required" },
            { path: "userStories[1]", message: "userStories[1].acceptance is empty" },
        ]
        const error = Object.assign(new Error("two defects"), { defects })
        const message = buildFinalPrdRepairMessage({
            reason: "two defects",
            error,
            unownedObligationIds: [],
        })

        assert.ok(
            message.includes(
                "Defects (2):\n" +
                    "- userStories[0]: userStories[0].id is required\n" +
                    "- userStories[1]: userStories[1].acceptance is empty",
            ),
        )
        assert.ok(!message.includes("Unowned architecture obligations ("))
    })

    it("falls back to the flat reason when no error is carried", () => {
        const message = buildFinalPrdRepairMessage({
            reason: "planner was not initialized by the harness",
            unownedObligationIds: ["O-007"],
        })

        assert.ok(
            message.includes(
                "Defects (1):\n- planner was not initialized by the harness",
            ),
        )
        assert.ok(
            message.includes("Unowned architecture obligations (1):\nO-007"),
        )
        assert.ok(message.endsWith("description metadata."))
    })
})

describe("obligation coverage report", () => {
    const stories = (acceptance: readonly string[]) => [
        {
            id: "S1",
            acceptance: [...acceptance],
            goalInvariantIds: ["G-A1", "G-C1"],
        },
    ]

    // O-017: partial mode only, never a throw, conservative on any failure.
    it("reports the ids no admitted story owns", () => {
        assert.deepEqual(
            unownedObligationIds(
                OBLIGATIONS,
                stories([
                    renderArchitectureObligationCriterion(
                        OBLIGATIONS.obligations[1]!,
                    ),
                ]),
            ),
            ["O-001", "O-003"],
        )
        assert.deepEqual(unownedObligationIds(OBLIGATIONS, []), [
            "O-001",
            "O-002",
            "O-003",
        ])
    })

    it("returns [] without a contract", () => {
        assert.deepEqual(unownedObligationIds(null, stories([])), [])
        assert.deepEqual(unownedObligationIds(undefined, stories([])), [])
        assert.deepEqual(
            unownedObligationIds({ schemaVersion: 1, obligations: [] }, stories([])),
            [],
        )
    })

    it("reports the full gap instead of throwing when the validator rejects", () => {
        // An unknown claim makes the validator throw in every mode.
        const unowned = unownedObligationIds(
            OBLIGATIONS,
            stories(["[O-042] a criterion naming an obligation that does not exist"]),
        )
        assert.deepEqual(unowned, ["O-001", "O-002", "O-003"])
    })

    it("bounds the rendered id list at 40 entries", () => {
        const ids = Array.from(
            { length: 41 },
            (_, index) => `O-${String(index + 1).padStart(3, "0")}`,
        )
        assert.equal(formatObligationIdList([]), "")
        assert.equal(formatObligationIdList(["O-001", "O-002"]), "O-001, O-002")
        const rendered = formatObligationIdList(ids)
        assert.ok(rendered.endsWith(" … (+1 more)"))
        assert.ok(!rendered.includes("O-041,"))
        assert.equal(formatObligationIdList(ids.slice(0, 40)), ids.slice(0, 40).join(", "))
    })

    it("reports no gap from the disabled progressive stub", async () => {
        const support = await createPlannerHarnessProgressiveSupport(undefined)
        assert.deepEqual(support.unownedObligationIds(), [])
    })

    it("summarises the gap as counts, with ids only when there are any", () => {
        assert.equal(obligationGapSummary([], 3), "0/3")
        assert.equal(obligationGapSummary(["O-001", "O-003"], 3), "2/3: O-001, O-003")
    })
})

describe("architecture obligation coverage regression", () => {
    const owned = [
        {
            id: "S1",
            acceptance: OBLIGATIONS.obligations.map(
                renderArchitectureObligationCriterion,
            ),
            goalInvariantIds: ["G-A1", "G-C1"],
        },
    ]

    // O-014/O-018: the validator is unchanged; only a read-only id list rides
    // along on the error it already threw.
    it("still throws the same message in complete mode, now carrying the ids", () => {
        assert.throws(
            () =>
                validateArchitectureObligationCoverage(
                    OBLIGATIONS,
                    obligationMappingsForStories([]),
                    "complete",
                ),
            (error: unknown) => {
                assert.ok(error instanceof ArchitectureObligationContractError)
                assert.equal(
                    error.message,
                    "architecture obligation coverage is incomplete; no story owns: " +
                        "O-001, O-002, O-003",
                )
                assert.deepEqual(error.missingObligationIds, [
                    "O-001",
                    "O-002",
                    "O-003",
                ])
                return true
            },
        )
    })

    it("still returns the unchanged partial result without throwing", () => {
        const result = validateArchitectureObligationCoverage(
            OBLIGATIONS,
            obligationMappingsForStories([]),
            "partial",
        )
        assert.deepEqual(Object.keys(result).sort(), [
            "coveredObligationIds",
            "missingObligationIds",
        ])
        assert.deepEqual(result.coveredObligationIds, [])
        assert.deepEqual(result.missingObligationIds, ["O-001", "O-002", "O-003"])
        assert.deepEqual(
            validateArchitectureObligationCoverage(
                OBLIGATIONS,
                obligationMappingsForStories(owned),
                "complete",
            ),
            {
                coveredObligationIds: ["O-001", "O-002", "O-003"],
                missingObligationIds: [],
            },
        )
    })

    it("leaves the id list empty on every other throw site", () => {
        assert.throws(
            () =>
                validateArchitectureObligationCoverage(
                    OBLIGATIONS,
                    obligationMappingsForStories([
                        { id: "S1", acceptance: ["[O-042] unknown"], goalInvariantIds: [] },
                    ]),
                    "partial",
                ),
            (error: unknown) => {
                assert.ok(error instanceof ArchitectureObligationContractError)
                assert.deepEqual(error.missingObligationIds, [])
                return true
            },
        )
        assert.deepEqual(missingObligationIdsFromError(new Error("plain")), [])
        assert.deepEqual(missingObligationIdsFromError(null), [])
        assert.deepEqual(missingObligationIdsFromError(undefined), [])
    })
})
