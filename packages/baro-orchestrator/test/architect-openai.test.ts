import assert from "node:assert/strict"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { createCodebaseTools } from "../src/planning/codebase-tools.js"

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

const OBLIGATION_DOCUMENT = `${DECISION_DOCUMENT}

## Semantic obligation contract

\`\`\`baro-obligations-v1
{"schemaVersion":1,"obligations":[{"id":"O-001","invariantIds":["G-A1"],"subject":"each directly callable affected boundary","scenario":"the changed operation is invoked","expectedOutcome":"the required behavior is observable without relying on an outer wrapper","evidence":["focused direct-boundary tests"]}]}
\`\`\``

function namedTool(tools: Tool[], name: string): Tool {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `missing ${name} tool`)
    return tool
}

describe("ArchitectOpenAI bounded finalization", () => {
    it("accepts ArchitectOutcomeV1 and exposes no bash tool in read-only mode", async () => {
        const outcome = {
            schemaVersion: 1,
            kind: "needsInput",
            message: "One compatibility choice needs user input.",
            questions: [{ id: "compat", text: "Must v1 remain compatible?" }],
            evidence: [{
                path: "src/protocol.ts",
                line: 10,
                fact: "The v1 serializer remains publicly exported.",
            }],
            decisionDocument: null,
        }
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([[message(JSON.stringify(outcome))]], tool)

        const result = await runArchitectOpenAI({
            goal: "Change the public protocol",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            outcomeMode: true,
            readOnly: true,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), outcome)
        assert.doesNotMatch(
            JSON.stringify(sequence.contexts[0]!.toJSON()),
            /output ONLY the markdown decision document/i,
        )
        assert.deepEqual(
            createCodebaseTools("/unused", { includeBash: false }).map((item) => item.name),
            ["read_file", "list_files", "file_tree", "grep", "glob"],
        )
    })

    it("repairs a non-trivial ready outcome that omits semantic obligations", async () => {
        const withoutObligations = {
            schemaVersion: 1,
            kind: "ready",
            message: "Planning may proceed.",
            questions: [],
            evidence: [],
            decisionDocument: DECISION_DOCUMENT,
        }
        const withObligations = {
            ...withoutObligations,
            decisionDocument: OBLIGATION_DOCUMENT,
        }
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [message(JSON.stringify(withoutObligations))],
            [message(JSON.stringify(withObligations))],
        ], tool)

        const result = await runArchitectOpenAI({
            goal: "Implement a non-trivial cross-boundary behavior",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            outcomeMode: true,
            readOnly: true,
            maxRounds: 3,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), withObligations)
        assert.match(
            JSON.stringify(sequence.contexts[1]!.toJSON()),
            /requires a baro-obligations-v1 appendix/u,
        )
    })

    it("repairs obligation parents that do not bind to the trusted goal", async () => {
        const wrongParents = {
            schemaVersion: 1,
            kind: "ready",
            message: "Planning may proceed.",
            questions: [],
            evidence: [],
            decisionDocument: OBLIGATION_DOCUMENT.replace("G-A1", "G-A2"),
        }
        const corrected = {
            ...wrongParents,
            decisionDocument: OBLIGATION_DOCUMENT,
        }
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [message(JSON.stringify(wrongParents))],
            [message(JSON.stringify(corrected))],
        ], tool)

        const result = await runArchitectOpenAI({
            goal: "Implement a non-trivial cross-boundary behavior",
            goalEnvelope: {
                objective: "Preserve the affected boundary.",
                acceptanceCriteria: ["The behavior remains observable."],
                constraints: [],
                nonGoals: [],
                assumptions: [],
            },
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            outcomeMode: true,
            readOnly: true,
            maxRounds: 3,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), corrected)
        assert.match(
            JSON.stringify(sequence.contexts[1]!.toJSON()),
            /unknown GoalContract invariant.*G-A2/u,
        )
    })

    it("uses shell-free, portable literal grep and shell-free glob", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "baro-architect-readonly-tools-"))
        try {
            mkdirSync(join(cwd, "src"))
            writeFileSync(join(cwd, "src/example.ts"), "export const needle = true\n")
            const grep = namedTool(
                createCodebaseTools(cwd, { includeBash: false }),
                "grep",
            )
            const glob = namedTool(
                createCodebaseTools(cwd, { includeBash: false }),
                "glob",
            )
            const grepMarker = join(cwd, "grep-injection-marker")
            const includeMarker = join(cwd, "include-injection-marker")
            const globMarker = join(cwd, "glob-injection-marker")

            await grep.invoke({
                pattern: `needle$(touch '${grepMarker}')`,
                path: ".",
                file_pattern: "*.ts",
            })
            await grep.invoke({
                pattern: "needle",
                path: ".",
                file_pattern: `*.ts'; touch '${includeMarker}'; #`,
            })
            await glob.invoke({
                pattern: `src/**/\`touch '${globMarker}'\`*.ts`,
            })

            assert.equal(existsSync(grepMarker), false)
            assert.equal(existsSync(includeMarker), false)
            assert.equal(existsSync(globMarker), false)
            assert.match(
                String(await grep.invoke({
                    pattern: "needle",
                    path: ".",
                    file_pattern: "*.ts",
                })),
                /src\/example\.ts:1/,
            )
            assert.equal(
                String(await grep.invoke({
                    pattern: "needle[",
                    path: ".",
                    file_pattern: "*.ts",
                })),
                "No matches found.",
                "grep patterns are bounded literal text, not host regex syntax",
            )

            const originalPath = process.env.PATH
            try {
                // The read-only search must work on Windows and minimal images
                // that do not ship a `grep` executable.
                process.env.PATH = ""
                assert.match(
                    String(await grep.invoke({
                        pattern: "NEEDLE",
                        path: ".",
                        file_pattern: "*.ts",
                    })),
                    /src\/example\.ts:1:export const needle = true/,
                )
            } finally {
                if (originalPath === undefined) delete process.env.PATH
                else process.env.PATH = originalPath
            }
            assert.match(
                String(await glob.invoke({ pattern: "src/**/*.ts" })),
                /src\/example\.ts/,
            )

            mkdirSync(join(cwd, "wide"))
            for (let index = 0; index < 200; index += 1) {
                writeFileSync(
                    join(cwd, "wide", `${"a".repeat(180)}${String(index).padStart(3, "0")}`),
                    "bounded\n",
                )
            }
            assert.match(
                String(await glob.invoke({ pattern: "?".repeat(512) })),
                /glob matching limit reached/,
                "model-controlled globs have a deterministic total work budget",
            )
        } finally {
            rmSync(cwd, { recursive: true, force: true })
        }
    })

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
