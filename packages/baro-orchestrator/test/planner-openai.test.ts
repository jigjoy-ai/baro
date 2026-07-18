import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    FunctionCallItem,
    ModelMessageItem,
    type ContextItem,
    type ModelContext,
    type Tool,
} from "@mozaik-ai/core"

import { GenericOpenAIModel } from "../src/planning/openai-runtime.js"
import {
    fallbackPrdJson,
    resolvePlannerModelName,
    runPlannerOpenAI,
    type PlannerOpenAIPlanFragmentEvent,
    type PlannerOpenAITestRuntime,
} from "../src/planning/planner-openai.js"

const PARALLEL_MODE = {
    mode: "parallel" as const,
    confidence: 1,
    reason: "test",
    source: "user",
}

const VALID_PRD = JSON.stringify({
    project: "mozaik",
    branchName: "cooperative-cancellation",
    description: "Implement cooperative cancellation",
    userStories: [
        {
            id: "S1",
            priority: 1,
            title: "Propagate cancellation",
            description: "Thread the signal through the provider boundary.",
            dependsOn: [],
            retries: 2,
            acceptance: ["The exact signal reaches providers."],
            tests: ["npm test"],
            goalInvariantIds: [],
            model: "heavy",
        },
    ],
})

const RAW_TAIL_STORY = {
    id: "S2",
    priority: 2,
    title: "Verify cancellation",
    description: "Cover cancellation across the integrated provider boundary.",
    dependsOn: ["S1"],
    retries: 2,
    acceptance: ["Cancellation remains observable after integration."],
    tests: ["npm test -- cancellation"],
    goalInvariantIds: [],
    model: "standard",
}

const FINAL_PRD_PUBLISHED_STORY = {
    ...(JSON.parse(VALID_PRD) as { userStories: Array<Record<string, unknown>> })
        .userStories[0]!,
}

const PUBLISHED_STORY = {
    ...FINAL_PRD_PUBLISHED_STORY,
    passes: false,
    completedAt: null,
    durationSecs: null,
}

const FINAL_WITH_TAIL = JSON.stringify({
    ...(JSON.parse(VALID_PRD) as Record<string, unknown>),
    userStories: [
        (JSON.parse(VALID_PRD) as { userStories: unknown[] }).userStories[0],
        RAW_TAIL_STORY,
    ],
})

describe("PlannerOpenAI fallback PRD", () => {
    it("returns a valid one-story PRD when planning cannot finalize", () => {
        const prd = JSON.parse(fallbackPrdJson("Redesign the execute screen into a run workspace", "test"))

        assert.equal(prd.project, "baro-run")
        assert.match(prd.branchName, /^baro\/redesign-the-execute-screen/)
        assert.equal(prd.userStories.length, 1)
        assert.equal(prd.userStories[0].id, "S1")
        assert.deepEqual(prd.userStories[0].dependsOn, [])
        assert.equal(prd.userStories[0].model, "heavy")
        assert.ok(prd.userStories[0].description.includes("Planner fallback: test"))
    })
})

describe("PlannerOpenAI complexity routing", () => {
    const saved = process.env.BARO_PLANNER_FOCUSED_MODEL
    afterEach(() => {
        if (saved === undefined) delete process.env.BARO_PLANNER_FOCUSED_MODEL
        else process.env.BARO_PLANNER_FOCUSED_MODEL = saved
    })

    it("routes a focused goal to the cheap floor model even on a high ceiling", () => {
        process.env.BARO_PLANNER_FOCUSED_MODEL = "deepseek-v4-pro"
        assert.equal(resolvePlannerModelName("focused", "gpt-5.5"), "deepseek-v4-pro")
    })

    it("routes a parallel goal to the tier ceiling model", () => {
        process.env.BARO_PLANNER_FOCUSED_MODEL = "deepseek-v4-pro"
        assert.equal(resolvePlannerModelName("parallel", "gpt-5.5"), "gpt-5.5")
    })

    it("routes a sequential goal to the tier ceiling model", () => {
        process.env.BARO_PLANNER_FOCUSED_MODEL = "deepseek-v4-pro"
        assert.equal(resolvePlannerModelName("sequential", "glm-5.2"), "glm-5.2")
    })

    it("does not downgrade a focused local run when the floor env is unset", () => {
        delete process.env.BARO_PLANNER_FOCUSED_MODEL
        assert.equal(resolvePlannerModelName("focused", "gpt-5.5"), "gpt-5.5")
    })
})

describe("PlannerOpenAI progressive fragments", () => {
    it("publishes a validated runtime-ordinal fragment before an exact-prefix final", async () => {
        const published: PlannerOpenAIPlanFragmentEvent[] = []
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence(
            [
                [
                    publishFragmentCall(
                        "publish-1",
                        "foundation",
                        [FINAL_PRD_PUBLISHED_STORY],
                    ),
                ],
                [message(FINAL_WITH_TAIL)],
            ],
            tool,
            (round) => {
                if (round === 2) assert.equal(published.length, 1)
            },
        )

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "gpt-5.5",
            modeContract: PARALLEL_MODE,
            maxRounds: 4,
            maxExplorationRounds: 2,
            progressive: {
                runId: "run-1",
                planningId: "planning-1",
                publish: (event) => published.push(event),
            },
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(FINAL_WITH_TAIL))
        assert.deepEqual(published, [
            {
                type: "plan_fragment",
                run_id: "run-1",
                planning_id: "planning-1",
                fragment_id: "foundation",
                ordinal: 1,
                stories: [PUBLISHED_STORY],
            },
        ])
        assert.deepEqual(sequence.toolCounts, [2, 2])
        assert.match(
            JSON.stringify(sequence.contexts[0]!.toJSON()),
            /immutable.*exact, same-order.*prefix/is,
        )
        assert.match(
            JSON.stringify(sequence.contexts[0]!.toJSON()),
            /moment.*safe to execute.*immediately.*do not wait for the full DAG/is,
        )
        assert.match(
            JSON.stringify(sequence.contexts[0]!.toJSON()),
            /Output ONLY JSON.*only.*terminal response/is,
        )
    })

    it("routes a changed published prefix through the existing repair loop", async () => {
        const changed = JSON.parse(FINAL_WITH_TAIL) as {
            userStories: Array<Record<string, unknown>>
        }
        changed.userStories[0]!.description = "Planner silently changed admitted work."
        const published: PlannerOpenAIPlanFragmentEvent[] = []
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [publishFragmentCall("publish-1", "foundation", [PUBLISHED_STORY])],
            [message(JSON.stringify(changed))],
            [message(FINAL_WITH_TAIL)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "gpt-5.5",
            modeContract: PARALLEL_MODE,
            maxRounds: 4,
            maxExplorationRounds: 2,
            maxFinalizationRetries: 1,
            progressive: {
                runId: "run-1",
                planningId: "planning-1",
                publish: (event) => published.push(event),
            },
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(FINAL_WITH_TAIL))
        assert.equal(published.length, 1)
        assert.equal(sequence.rounds(), 3)
        assert.match(
            JSON.stringify(sequence.contexts[2]!.toJSON()),
            /does not exactly match admitted prefix story/i,
        )
    })

    it("rejects a changed prefix when the bounded repair budget is exhausted", async () => {
        const changed = JSON.parse(VALID_PRD) as {
            userStories: Array<Record<string, unknown>>
        }
        changed.userStories[0]!.title = "Changed after early publication"
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [publishFragmentCall("publish-1", "foundation", [PUBLISHED_STORY])],
            [message(JSON.stringify(changed))],
        ], tool)

        await assert.rejects(
            runPlannerOpenAI({
                goal: "Implement cooperative cancellation",
                cwd: "/unused",
                model: "gpt-5.5",
                modeContract: PARALLEL_MODE,
                maxRounds: 3,
                maxExplorationRounds: 2,
                maxFinalizationRetries: 0,
                progressive: {
                    runId: "run-1",
                    planningId: "planning-1",
                    publish: () => undefined,
                },
                testRuntime: sequence.runtime,
            }),
            /final PRD rejected.*admitted prefix/is,
        )
    })

    it("closes fragment publishing with all other tools after exploration", async () => {
        const published: PlannerOpenAIPlanFragmentEvent[] = []
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [publishFragmentCall("publish-1", "foundation", [PUBLISHED_STORY])],
            [publishFragmentCall("publish-2", "late", [{
                ...RAW_TAIL_STORY,
                passes: false,
                completedAt: null,
                durationSecs: null,
            }])],
            [message(VALID_PRD)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "gpt-5.5",
            modeContract: PARALLEL_MODE,
            maxRounds: 4,
            maxExplorationRounds: 1,
            progressive: {
                runId: "run-1",
                planningId: "planning-1",
                publish: (event) => published.push(event),
            },
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(VALID_PRD))
        assert.equal(published.length, 1)
        assert.match(
            JSON.stringify(sequence.contexts[2]!.toJSON()),
            /this call was not executed/i,
        )
    })

    it("leaves a zero-fragment final response unchanged", async () => {
        const published: PlannerOpenAIPlanFragmentEvent[] = []
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([[message(VALID_PRD)]], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "gpt-5.5",
            modeContract: PARALLEL_MODE,
            progressive: {
                runId: "run-1",
                planningId: "planning-1",
                publish: (event) => published.push(event),
            },
            testRuntime: sequence.runtime,
        })

        assert.equal(result, VALID_PRD)
        assert.deepEqual(published, [])
        assert.match(
            JSON.stringify(sequence.contexts[0]!.toJSON()),
            /never force an unsafe or provisional split.*if no dependency-closed prefix becomes safe.*do not publish/is,
        )
    })
})

describe("PlannerOpenAI GLM-compatible finalization", () => {
    it("repairs the recorded literal GLM tool markup instead of collapsing to fallback", async () => {
        let invokes = 0
        const tool = fakeTool(async () => {
            invokes += 1
            return "file contents"
        })
        const sequence = fakeSequence([
            [call("c1")],
            [call("c2")],
            [message(
                "<tool_call>read_file<arg_key>path</arg_key>" +
                "<arg_value>src/domain/agentic-environment/inference/params.ts</arg_value></tool_call>",
            )],
            [message(`\`\`\`json\n${VALID_PRD}\n\`\`\``)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 6,
            maxExplorationRounds: 2,
            maxFinalizationRetries: 2,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(VALID_PRD))
        assert.equal(invokes, 2)
        assert.equal(sequence.rounds(), 4)
        assert.deepEqual(sequence.toolCounts, [1, 1, 1, 1])
        assert.match(
            JSON.stringify(sequence.contexts[3]!.toJSON()),
            /do not emit <tool_call> tags/i,
        )
    })

    it("keeps schemas visible but refuses structured tool calls after the budget", async () => {
        let invokes = 0
        const tool = fakeTool(async () => {
            invokes += 1
            return "file contents"
        })
        const sequence = fakeSequence([
            [call("allowed")],
            [call("refused")],
            [message(VALID_PRD)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 5,
            maxExplorationRounds: 1,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(VALID_PRD))
        assert.equal(invokes, 1)
        assert.deepEqual(sequence.toolCounts, [1, 1, 1])
        assert.match(
            JSON.stringify(sequence.contexts[2]!.toJSON()),
            /this call was not executed/i,
        )
    })

    it("falls back only after the bounded JSON repair budget is exhausted", async () => {
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [call("c1")],
            [message("<tool_call>read_file</tool_call>")],
            [message("still not JSON")],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 6,
            maxExplorationRounds: 1,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        const prd = JSON.parse(result)
        assert.equal(prd.project, "baro-run")
        assert.match(prd.userStories[0].description, /bounded repair attempts/)
        assert.equal(sequence.rounds(), 3)
    })

    it("repairs syntactically valid JSON that is not a runnable PRD", async () => {
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [call("c1")],
            [message("{}")],
            [message(VALID_PRD)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 5,
            maxExplorationRounds: 1,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(VALID_PRD))
        assert.match(
            JSON.stringify(sequence.contexts[2]!.toJSON()),
            /missing a non-empty project/i,
        )
    })

    it("repairs PRD array values that Rust cannot deserialize", async () => {
        const invalid = JSON.parse(VALID_PRD) as Record<string, unknown>
        const stories = invalid.userStories as Array<Record<string, unknown>>
        stories[0]!.tests = [42]
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [call("c1")],
            [message(JSON.stringify(invalid))],
            [message(VALID_PRD)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 5,
            maxExplorationRounds: 1,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(VALID_PRD))
        assert.match(
            JSON.stringify(sequence.contexts[2]!.toJSON()),
            /non-string values in tests/i,
        )
    })

    it("repairs stories with empty semantic acceptance or test evidence", async () => {
        const invalid = JSON.parse(VALID_PRD) as Record<string, unknown>
        const stories = invalid.userStories as Array<Record<string, unknown>>
        stories[0]!.acceptance = []
        stories[0]!.tests = ["   "]
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [call("c1")],
            [message(JSON.stringify(invalid))],
            [message(VALID_PRD)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 5,
            maxExplorationRounds: 1,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(VALID_PRD))
        assert.match(
            JSON.stringify(sequence.contexts[2]!.toJSON()),
            /must contain non-empty acceptance/i,
        )
    })

    it("skips an earlier tool-args object when the same response contains a valid PRD", async () => {
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [message(`Attempted args: {"path":"src/index.ts"}\n${VALID_PRD}`)],
        ], tool)

        const result = await runPlannerOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 3,
            maxFinalizationRetries: 0,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), JSON.parse(VALID_PRD))
        assert.equal(sequence.rounds(), 1)
    })
})

function call(callId: string): ContextItem {
    return FunctionCallItem.rehydrate({
        callId,
        name: "read_file",
        args: JSON.stringify({ path: "src/index.ts" }),
    })
}

function publishFragmentCall(
    callId: string,
    fragmentId: string,
    stories: unknown[],
): ContextItem {
    return FunctionCallItem.rehydrate({
        callId,
        name: "publish_plan_fragment",
        args: JSON.stringify({ fragmentId, stories }),
    })
}

function message(text: string): ContextItem {
    return ModelMessageItem.rehydrate({ text })
}

function fakeTool(invoke: Tool["invoke"]): Tool {
    return {
        type: "function",
        name: "read_file",
        description: "Read one file",
        parameters: { type: "object" },
        strict: true,
        invoke,
    }
}

function fakeSequence(
    roundItems: ContextItem[][],
    tool: Tool,
    beforeRound?: (round: number) => void,
): {
    runtime: PlannerOpenAITestRuntime
    contexts: ModelContext[]
    toolCounts: number[]
    rounds: () => number
} {
    const model = new GenericOpenAIModel("glm-5.2")
    const contexts: ModelContext[] = []
    const toolCounts: number[] = []
    let round = 0
    return {
        runtime: {
            model,
            tools: [tool],
            inferRound: async (context, activeModel) => {
                beforeRound?.(round + 1)
                contexts.push(context)
                toolCounts.push(activeModel.getTools().length)
                const items = roundItems[round]
                assert.ok(items, `unexpected inference round ${round + 1}`)
                round += 1
                return { items, usage: undefined }
            },
        },
        contexts,
        toolCounts,
        rounds: () => round,
    }
}
