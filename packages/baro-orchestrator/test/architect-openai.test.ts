import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    FunctionCallItem,
    ModelMessageItem,
    type ContextItem,
    type ModelContext,
    type Tool,
} from "@mozaik-ai/core"

import {
    runArchitectOpenAI,
    type ArchitectOpenAITestRuntime,
} from "../src/planning/architect-openai.js"
import { GenericOpenAIModel } from "../src/planning/openai-runtime.js"

const PARALLEL_MODE = {
    mode: "parallel" as const,
    confidence: 1,
    reason: "test",
    source: "user",
}

const DECISION_DOCUMENT = `## Existing context
Mozaik already exposes AbortSignal in its inference parameters.

## ADR-001: Propagate the exact signal
**Status:** Accepted
**Context:** Provider calls need cooperative cancellation.
**Decision:** Pass the same AbortSignal through every provider boundary.
**Consequences:** Existing calls without a signal remain unchanged.`

describe("ArchitectOpenAI bounded finalization", () => {
    it("refuses post-budget calls without hiding tool schemas, then accepts the document", async () => {
        let invokes = 0
        const tool = fakeTool(async () => {
            invokes += 1
            return "file contents"
        })
        const sequence = fakeSequence([
            [call("c1")],
            [call("c2")],
            [call("refused")],
            [message(DECISION_DOCUMENT)],
        ], tool)

        const result = await runArchitectOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 6,
            maxExplorationRounds: 2,
            testRuntime: sequence.runtime,
        })

        assert.equal(result, DECISION_DOCUMENT)
        assert.equal(invokes, 2)
        assert.deepEqual(sequence.toolCounts, [1, 1, 1, 1])
        assert.match(
            JSON.stringify(sequence.contexts[3]!.toJSON()),
            /this call was not executed/i,
        )
        assert.match(
            JSON.stringify(sequence.contexts[0]!.toJSON()),
            /mode: parallel/,
        )
    })

    it("repairs literal tool markup emitted during finalization", async () => {
        let invokes = 0
        const tool = fakeTool(async () => {
            invokes += 1
            return "file contents"
        })
        const sequence = fakeSequence([
            [call("c1")],
            [message("<tool_call>read_file<arg_key>path</arg_key><arg_value>src/index.ts</arg_value></tool_call>")],
            [message(DECISION_DOCUMENT)],
        ], tool)

        const result = await runArchitectOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 5,
            maxExplorationRounds: 1,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.equal(result, DECISION_DOCUMENT)
        assert.equal(invokes, 1)
        assert.deepEqual(sequence.toolCounts, [1, 1, 1])
    })

    it("repairs ordinary prose that is not the required ADR document", async () => {
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [call("c1")],
            [message("I should inspect a few more files before deciding.")],
            [message(DECISION_DOCUMENT)],
        ], tool)

        const result = await runArchitectOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 5,
            maxExplorationRounds: 1,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.equal(result, DECISION_DOCUMENT)
        assert.match(
            JSON.stringify(sequence.contexts[2]!.toJSON()),
            /not an ADR decision document/i,
        )
    })

    it("stops at maxRounds when the model keeps requesting tools", async () => {
        let invokes = 0
        const tool = fakeTool(async () => {
            invokes += 1
            return "file contents"
        })
        const sequence = fakeSequence([
            [call("c1")],
            [call("c2")],
            [call("refused-1")],
            [call("refused-2")],
        ], tool)

        await assert.rejects(
            runArchitectOpenAI({
                goal: "Implement cooperative cancellation",
                cwd: "/unused",
                model: "glm-5.2",
                modeContract: PARALLEL_MODE,
                maxRounds: 4,
                maxExplorationRounds: 2,
                testRuntime: sequence.runtime,
            }),
            /exceeded maxRounds=4/,
        )
        assert.equal(invokes, 2)
        assert.deepEqual(sequence.toolCounts, [1, 1, 1, 1])
    })
})

function call(callId: string): ContextItem {
    return FunctionCallItem.rehydrate({
        callId,
        name: "read_file",
        args: JSON.stringify({ path: "src/index.ts" }),
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

function fakeSequence(roundItems: ContextItem[][], tool: Tool): {
    runtime: ArchitectOpenAITestRuntime
    contexts: ModelContext[]
    toolCounts: number[]
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
    }
}
