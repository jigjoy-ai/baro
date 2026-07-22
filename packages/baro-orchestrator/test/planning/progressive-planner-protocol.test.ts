import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"

import {
    applyProgressiveBootstrapMetadata,
    parseProgressiveBootstrapMetadata,
    persistProgressivePlannerResult,
    ProgressivePlannerLifecycle,
    resolveProgressivePlannerConfig,
    writeAllSync,
    type ProgressivePlannerWireEvent,
} from "../../src/planning/progressive-planner-protocol.js"
import {
    parseArchitectureObligationContract,
    renderArchitectureObligationCriterion,
} from "../../src/planning/architecture-obligation-contract.js"
import { buildPlannerUserMessage } from "../../src/planning/planner-prompts.js"

const STORY_S1 = {
    id: "S1",
    priority: 1,
    title: "Implement S1",
    description: "Implement the dependency-closed foundation.",
    dependsOn: [] as string[],
    retries: 2,
    acceptance: ["The foundation is observable."],
    tests: ["npm test -- S1"],
    passes: false as const,
    completedAt: null,
    durationSecs: null,
    model: "standard",
}

const OBLIGATION_GOAL = {
    objective: "Preserve one behavior at its direct boundary.",
    acceptanceCriteria: ["The direct behavior remains observable."],
    constraints: [],
    nonGoals: [],
    assumptions: [],
}

const OBLIGATION_DOCUMENT = `## Existing context
The boundary can be invoked independently.

## ADR-001: Preserve direct behavior
**Status:** Accepted
**Context:** Outer composition is not the only caller.
**Decision:** Require direct evidence.
**Consequences:** One implementation story owns the proof.

## Semantic obligation contract

\`\`\`baro-obligations-v1
{"schemaVersion":1,"obligations":[{"id":"O-001","invariantIds":["G-A1"],"subject":"the direct boundary","scenario":"it is invoked independently","expectedOutcome":"the required behavior remains observable","evidence":["a direct-boundary test"]}]}
\`\`\``

const OBLIGATION_CRITERION = renderArchitectureObligationCriterion(
    parseArchitectureObligationContract(OBLIGATION_DOCUMENT)!.obligations[0]!,
)

describe("progressive planner flag contract", () => {
    it("keeps a no-flag invocation on the legacy path", () => {
        assert.equal(
            resolveProgressivePlannerConfig({ resultFile: "/tmp/result.json" }),
            undefined,
        )
    })

    it("requires the complete correlated group and a result file", () => {
        assert.deepEqual(
            resolveProgressivePlannerConfig({
                progressiveRunId: " run-1 ",
                progressivePlanningId: " planning-1 ",
                progressiveBootstrapFile: " /tmp/bootstrap.json ",
                resultFile: "/tmp/result.json",
            }),
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
        )

        for (const input of [
            { progressiveRunId: "run-1" },
            {
                progressiveRunId: "run-1",
                progressivePlanningId: "planning-1",
            },
            {
                progressiveRunId: "run-1",
                progressivePlanningId: "planning-1",
                progressiveBootstrapFile: "/tmp/bootstrap.json",
            },
        ]) {
            assert.throws(
                () => resolveProgressivePlannerConfig(input),
                /progressive|result-file/u,
            )
        }
    })
})

describe("progressive planner lifecycle wire", () => {
    it("carries an exact obligation from the real Planner handoff through fragment and completion", () => {
        const prompt = buildPlannerUserMessage({
            goal: OBLIGATION_GOAL.objective,
            decisionDocument: OBLIGATION_DOCUMENT,
        })
        const criterion = prompt
            .split("\n")
            .find((line) => line.startsWith("[O-001]; "))
        assert.ok(criterion)
        assert.equal(criterion, OBLIGATION_CRITERION)

        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-obligation-handoff",
                planningId: "planning-obligation-handoff",
                bootstrapFile: "/tmp/bootstrap.json",
                trustedGoalEnvelope: OBLIGATION_GOAL,
                trustedDecisionDocument: OBLIGATION_DOCUMENT,
            },
            (event) => events.push(event),
        )
        const owner = {
            ...STORY_S1,
            acceptance: [criterion],
            goalInvariantIds: ["G-A1"],
        }

        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-obligation-handoff",
            planning_id: "planning-obligation-handoff",
            fragment_id: "owner",
            ordinal: 1,
            stories: [owner],
        })
        lifecycle.complete({ project: "p", userStories: [owner] })

        assert.deepEqual(events.map(({ type }) => type), [
            "planning_open",
            "plan_fragment",
            "plan_complete_summary",
        ])
    })

    it("allows partial fragments but requires exact complete obligation ownership before closing", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-obligations",
                planningId: "planning-obligations",
                bootstrapFile: "/tmp/bootstrap.json",
                trustedGoalEnvelope: OBLIGATION_GOAL,
                trustedDecisionDocument: OBLIGATION_DOCUMENT,
            },
            (event) => events.push(event),
        )
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-obligations",
            planning_id: "planning-obligations",
            fragment_id: "foundation",
            ordinal: 1,
            stories: [{ ...STORY_S1, goalInvariantIds: [] }],
        })

        assert.throws(
            () => lifecycle.complete({ project: "p", userStories: [STORY_S1] }),
            /coverage is incomplete.*O-001/u,
        )
        assert.deepEqual(events.map(({ type }) => type), [
            "planning_open",
            "plan_fragment",
        ])

        const owner = {
            ...STORY_S1,
            id: "S2",
            title: "Own direct behavior",
            acceptance: [OBLIGATION_CRITERION],
            goalInvariantIds: ["G-A1"],
        }
        lifecycle.complete({
            project: "p",
            userStories: [STORY_S1, owner],
        })
        assert.equal(events.at(-1)?.type, "plan_complete_summary")
    })

    it("rejects altered obligation criteria before admitting a fragment", () => {
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-obligation-tamper",
                planningId: "planning-obligation-tamper",
                bootstrapFile: "/tmp/bootstrap.json",
                trustedGoalEnvelope: OBLIGATION_GOAL,
                trustedDecisionDocument: OBLIGATION_DOCUMENT,
            },
            () => undefined,
        )
        lifecycle.open()
        assert.throws(
            () => lifecycle.publish({
                type: "plan_fragment",
                run_id: "run-obligation-tamper",
                planning_id: "planning-obligation-tamper",
                fragment_id: "tampered",
                ordinal: 1,
                stories: [{
                    ...STORY_S1,
                    acceptance: [`${OBLIGATION_CRITERION} narrowed`],
                    goalInvariantIds: ["G-A1"],
                }],
            }),
            /altered canonical.*O-001/u,
        )
    })

    it("rejects an A19-style prefixed obligation claim before admitting a fragment", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-obligation-prefix",
                planningId: "planning-obligation-prefix",
                bootstrapFile: "/tmp/bootstrap.json",
                trustedGoalEnvelope: OBLIGATION_GOAL,
                trustedDecisionDocument: OBLIGATION_DOCUMENT,
            },
            (event) => events.push(event),
        )
        lifecycle.open()

        assert.throws(
            () => lifecycle.publish({
                type: "plan_fragment",
                run_id: "run-obligation-prefix",
                planning_id: "planning-obligation-prefix",
                fragment_id: "prefixed",
                ordinal: 1,
                stories: [{
                    ...STORY_S1,
                    acceptance: [`Parents G-A1: ${OBLIGATION_CRITERION}`],
                    goalInvariantIds: ["G-A1"],
                }],
            }),
            /altered canonical.*O-001/u,
        )
        assert.deepEqual(events.map(({ type }) => type), ["planning_open"])
    })

    it("accepts an exact replay of a fragment that owns an obligation", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-obligation-replay",
                planningId: "planning-obligation-replay",
                bootstrapFile: "/tmp/bootstrap.json",
                trustedGoalEnvelope: OBLIGATION_GOAL,
                trustedDecisionDocument: OBLIGATION_DOCUMENT,
            },
            (event) => events.push(event),
        )
        const fragment = {
            type: "plan_fragment" as const,
            run_id: "run-obligation-replay",
            planning_id: "planning-obligation-replay",
            fragment_id: "owner",
            ordinal: 1,
            stories: [{
                ...STORY_S1,
                acceptance: [OBLIGATION_CRITERION],
                goalInvariantIds: ["G-A1"],
            }],
        }

        lifecycle.open()
        lifecycle.publish(fragment)
        lifecycle.publish(fragment)

        assert.deepEqual(events.map(({ type }) => type), [
            "planning_open",
            "plan_fragment",
            "plan_fragment",
        ])
    })

    it("rejects unknown trusted GoalContract ids before advancing its local session", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-trusted-goal",
                planningId: "planning-trusted-goal",
                bootstrapFile: "/tmp/bootstrap.json",
                trustedGoalEnvelope: {
                    objective: "Preserve both required behaviors.",
                    acceptanceCriteria: ["First behavior", "Second behavior"],
                    constraints: [],
                    nonGoals: [],
                    assumptions: [],
                },
            },
            (event) => events.push(event),
        )
        lifecycle.open()

        assert.throws(
            () => lifecycle.publish({
                type: "plan_fragment",
                run_id: "run-trusted-goal",
                planning_id: "planning-trusted-goal",
                fragment_id: "foundation",
                ordinal: 1,
                stories: [{
                    ...STORY_S1,
                    goalInvariantIds: ["G-A99"],
                }],
            }),
            /unknown invariant.*G-A99/i,
        )

        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-trusted-goal",
            planning_id: "planning-trusted-goal",
            fragment_id: "foundation",
            ordinal: 1,
            stories: [{
                ...STORY_S1,
                goalInvariantIds: ["G-A1"],
            }],
        })

        assert.deepEqual(events.map((event) => event.type), [
            "planning_open",
            "plan_fragment",
        ])
        const fragment = events[1]
        assert.ok(fragment?.type === "plan_fragment")
        assert.equal(fragment.ordinal, 1)
        assert.deepEqual(fragment.stories[0]?.goalInvariantIds, ["G-A1"])
    })

    it("publishes one correlated open, direct fragment, and complete", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )

        lifecycle.open()
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-1",
            planning_id: "planning-1",
            fragment_id: "fragment-1",
            ordinal: 1,
            stories: [STORY_S1],
        })
        const finalPrd = { project: "trusted", userStories: [STORY_S1] }
        lifecycle.complete(finalPrd)
        // Once completed, the same stream cannot also fail.
        lifecycle.fail("result_write_failed", "disk became read-only")

        const canonical = JSON.stringify(finalPrd)
        assert.deepEqual(events, [
            {
                type: "planning_open",
                run_id: "run-1",
                planning_id: "planning-1",
            },
            {
                type: "plan_fragment",
                run_id: "run-1",
                planning_id: "planning-1",
                fragment_id: "fragment-1",
                ordinal: 1,
                stories: [STORY_S1],
            },
            {
                type: "plan_complete_summary",
                run_id: "run-1",
                planning_id: "planning-1",
                stories: 1,
                final_prd_chars: canonical.length,
                final_prd_sha256: createHash("sha256")
                    .update(canonical, "utf8")
                    .digest("hex"),
            },
        ])
    })

    it("persists the authoritative result before publishing completion", () => {
        const order: string[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => order.push(event.type),
        )
        lifecycle.open()

        persistProgressivePlannerResult(
            "/tmp/result.json",
            JSON.stringify({ project: "trusted", userStories: [STORY_S1] }),
            lifecycle,
            () => order.push("result_written"),
        )

        assert.deepEqual(order, [
            "planning_open",
            "result_written",
            "plan_complete_summary",
        ])
    })

    it("reconciles the execution-neutral fields omitted by real planner JSON", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-1",
            planning_id: "planning-1",
            fragment_id: "fragment-1",
            ordinal: 1,
            stories: [STORY_S1],
        })

        lifecycle.complete({
            project: "trusted",
            branchName: "baro/trusted",
            description: "trusted",
            userStories: [
                {
                    id: STORY_S1.id,
                    priority: STORY_S1.priority,
                    title: STORY_S1.title,
                    description: STORY_S1.description,
                    dependsOn: STORY_S1.dependsOn,
                    retries: STORY_S1.retries,
                    acceptance: STORY_S1.acceptance,
                    tests: STORY_S1.tests,
                    model: STORY_S1.model,
                },
            ],
        })

        assert.deepEqual(events.map((event) => event.type), [
            "planning_open",
            "plan_fragment",
            "plan_complete_summary",
        ])
    })

    it("can publish only one failure when persistence never completed", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )
        lifecycle.open()

        assert.throws(() =>
            persistProgressivePlannerResult(
                "/tmp/result.json",
                JSON.stringify({ project: "trusted", userStories: [] }),
                lifecycle,
                () => {
                    throw new Error("disk became read-only")
                },
            ),
        )
        lifecycle.fail("result_write_failed", "disk became read-only")
        lifecycle.fail("duplicate", "must not be published")

        assert.deepEqual(events.map((event) => event.type), [
            "planning_open",
            "plan_failed",
        ])
    })

    it("rejects provider fragments with foreign correlation", () => {
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            () => {},
        )
        lifecycle.open()

        assert.throws(
            () =>
                lifecycle.publish({
                    type: "plan_fragment",
                    run_id: "foreign-run",
                    planning_id: "planning-1",
                    fragment_id: "fragment-1",
                    ordinal: 1,
                    stories: [STORY_S1],
                }),
            /correlation mismatch/u,
        )
    })

    it("rejects a final candidate changed after an early fragment was published", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-1",
            planning_id: "planning-1",
            fragment_id: "fragment-1",
            ordinal: 1,
            stories: [STORY_S1],
        })

        assert.throws(
            () => lifecycle.complete({
                project: "trusted",
                userStories: [{
                    ...STORY_S1,
                    description: "A post-processor silently rewrote admitted work.",
                }],
            }),
            /does not exactly match admitted prefix/u,
        )
        lifecycle.fail("invalid_final_plan", "post-processing changed the prefix")
        assert.deepEqual(events.map((event) => event.type), [
            "planning_open",
            "plan_fragment",
            "plan_failed",
        ])
    })

    it("validates the post-processed prefix before persisting a result", () => {
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            () => {},
        )
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-1",
            planning_id: "planning-1",
            fragment_id: "fragment-1",
            ordinal: 1,
            stories: [STORY_S1],
        })
        let writes = 0

        assert.throws(
            () => persistProgressivePlannerResult(
                "/tmp/result.json",
                JSON.stringify({
                    project: "trusted",
                    userStories: [{ ...STORY_S1, title: "Trimmed or collapsed" }],
                }),
                lifecycle,
                () => { writes += 1 },
            ),
            /does not exactly match admitted prefix/u,
        )
        assert.equal(writes, 0)
    })

    it("announces a >64 KiB final PRD as one bounded, valid JSONL summary line", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )
        lifecycle.open()

        const oversized = {
            project: "trusted",
            description: "d".repeat(80 * 1024),
            userStories: [STORY_S1],
        }
        const prdJson = JSON.stringify(oversized)
        assert.ok(prdJson.length > 64 * 1024)
        let persisted: string | null = null
        persistProgressivePlannerResult(
            "/tmp/result.json",
            prdJson,
            lifecycle,
            (_path, contents) => {
                persisted = contents
            },
        )

        // The full plan reaches the host only through the result file.
        assert.equal(persisted, prdJson)
        const summary = events.at(-1)
        assert.ok(summary && summary.type === "plan_complete_summary")
        const line = JSON.stringify(summary)
        assert.ok(
            line.length < 4_096,
            "the stdout announcement must fit one pipe write with room to spare",
        )
        assert.deepEqual(JSON.parse(line), {
            type: "plan_complete_summary",
            run_id: "run-1",
            planning_id: "planning-1",
            stories: 1,
            final_prd_chars: prdJson.length,
            final_prd_sha256: createHash("sha256")
                .update(prdJson, "utf8")
                .digest("hex"),
        })
    })

    it("completes clipped pipe writes so no wire record is ever truncated", () => {
        const record = `${JSON.stringify({
            type: "plan_fragment",
            payload: "p".repeat(150 * 1024),
        })}\n`
        const chunks: Buffer[] = []
        let callsUntilEagain = 2
        writeAllSync(1, record, (_fd, buffer, offset, length) => {
            if (callsUntilEagain === 0) {
                callsUntilEagain = 3
                const error = new Error("EAGAIN") as NodeJS.ErrnoException
                error.code = "EAGAIN"
                throw error
            }
            callsUntilEagain -= 1
            // A pipe accepts at most its free capacity per write(2) call.
            const written = Math.min(length!, 64 * 1024)
            chunks.push(Buffer.from(buffer as Buffer).subarray(
                offset!,
                offset! + written,
            ))
            return written
        })

        const delivered = Buffer.concat(chunks).toString("utf8")
        assert.equal(delivered, record)
        assert.doesNotThrow(() => JSON.parse(delivered.trimEnd()))
    })
})

describe("progressive bootstrap metadata", () => {
    const goalEnvelope = {
        objective: "Implement progressive planning",
        constraints: ["Keep legacy byte-compatible"],
        acceptanceCriteria: ["Safe prefixes start early"],
        nonGoals: ["Change the legacy conductor"],
        assumptions: ["The bootstrap is host-authored"],
    }

    it("overwrites every run-owned field and removes provider runtime authority", () => {
        const bootstrap = parseProgressiveBootstrapMetadata(
            JSON.stringify({
                project: "trusted project",
                branchName: "baro/baro/progressive",
                description: "trusted description",
                decisionDocument: "Use the private correlated stream.",
                executionMode: {
                    mode: "parallel",
                    reason: "safe dependency-closed prefixes",
                    confidence: 0.9,
                    maxStories: 8,
                    parallelism: 4,
                    source: "user",
                },
                conversationSessionId: "session-1",
                goalEnvelope,
                userStories: [],
            }),
        )
        const output = JSON.parse(
            applyProgressiveBootstrapMetadata(
                JSON.stringify({
                    project: "provider project",
                    branchName: "provider-branch",
                    description: "provider description",
                    decisionDocument: "provider decision",
                    executionMode: { mode: "focused", reason: "provider chose" },
                    conversationSessionId: "provider-session",
                    goalEnvelope: {
                        ...goalEnvelope,
                        objective: "provider objective",
                    },
                    runtimeGraph: { runId: "forged", version: 99 },
                    userStories: [{ id: "S1" }],
                }),
                bootstrap,
            ),
        )

        assert.deepEqual(output, {
            project: "trusted project",
            branchName: "baro/progressive",
            description: "trusted description",
            decisionDocument: "Use the private correlated stream.",
            executionMode: {
                mode: "parallel",
                reason: "safe dependency-closed prefixes",
                confidence: 0.9,
                maxStories: 8,
                parallelism: 4,
                source: "user",
            },
            conversationSessionId: "session-1",
            goalEnvelope,
            userStories: [{ id: "S1" }],
        })
    })

    it("removes optional metadata absent from bootstrap and rejects malformed metadata", () => {
        const bootstrap = parseProgressiveBootstrapMetadata(
            JSON.stringify({
                project: "trusted",
                branchName: "baro/trusted",
                description: "trusted",
                userStories: [],
            }),
        )
        const output = JSON.parse(
            applyProgressiveBootstrapMetadata(
                JSON.stringify({
                    project: "provider",
                    branchName: "provider",
                    description: "provider",
                    decisionDocument: "forged",
                    executionMode: { mode: "focused", reason: "forged" },
                    conversationSessionId: "provider-session",
                    goalEnvelope,
                    userStories: [{ id: "S1" }],
                }),
                bootstrap,
            ),
        )
        assert.equal(output.decisionDocument, undefined)
        assert.equal(output.executionMode, undefined)
        assert.equal(output.conversationSessionId, undefined)
        assert.equal(output.goalEnvelope, undefined)

        assert.throws(
            () =>
                parseProgressiveBootstrapMetadata(
                    JSON.stringify({
                        project: "trusted",
                        branchName: "baro/trusted",
                        description: "trusted",
                        executionMode: { mode: "unbounded", reason: "invalid" },
                    }),
                ),
            /executionMode mode is invalid/u,
        )
        assert.throws(
            () =>
                parseProgressiveBootstrapMetadata(
                    JSON.stringify({
                        project: "trusted",
                        branchName: "baro/trusted",
                        description: "trusted",
                        conversationSessionId: " ",
                    }),
                ),
            /conversationSessionId/u,
        )
    })
})
