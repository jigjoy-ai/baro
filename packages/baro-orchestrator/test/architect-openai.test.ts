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
    InputTokenDetails,
    ModelMessageItem,
    OutputTokenDetails,
    TokenUsage,
    type ContextItem,
    type ModelContext,
    type Tool,
} from "../src/runtime/mozaik.js"

import {
    runArchitectOpenAI,
    type ArchitectOpenAITestRuntime,
} from "../src/planning/architect-openai.js"
import {
    createOpenAIModel,
    GenericOpenAIModel,
} from "../src/planning/openai-runtime.js"
import { createDialogueResponder } from "../src/participants/dialogue-responder.js"
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
    it("keeps the native model specification and effort identical across architecture phases", async () => {
        const models: Array<{
            specification: { name: string; supportReasoningEffort: boolean }
            getReasoningEffort(): string
        }> = []
        const tool = fakeTool(async () => "unused")
        await runArchitectOpenAI({
            goal: "Preserve exact OpenAI phase continuity",
            cwd: "/unused",
            model: "gpt-5.4",
            effort: "high",
            modeContract: PARALLEL_MODE,
            testRuntime: {
                tools: [tool],
                inferRound: async (_context, model) => {
                    models.push(model)
                    return {
                        items: [message(DECISION_DOCUMENT)],
                        usage: undefined,
                        billingInvocationId: null,
                    }
                },
            },
        })

        const responder = createDialogueResponder({
            backend: "openai",
            cwd: "/unused",
            model: "gpt-5.4",
            effort: "high",
            openaiRunRound: async (_context, model) => {
                models.push(model)
                return {
                    items: [message('{"message":"Ready.","messages":[]}')],
                    usage: undefined,
                    billingInvocationId: null,
                }
            },
        })
        await responder(
            {
                runId: "phase-continuity",
                messageId: "obligations-1",
                systemPrompt: "Return JSON.",
                userPrompt: "Compile obligations.",
            },
            new AbortController().signal,
        )

        assert.equal(models.length, 2)
        assert.deepEqual(models[0]!.specification, models[1]!.specification)
        assert.equal(models[0]!.specification.name, "gpt-5.4")
        assert.equal(models[0]!.specification.supportReasoningEffort, true)
        assert.deepEqual(
            models.map((model) => model.getReasoningEffort()),
            ["high", "high"],
        )
    })

    it("uses the generic model without reasoning effort for custom endpoints and other model names", async () => {
        const models: GenericOpenAIModel[] = []
        const previousIntakeModel = process.env.BARO_INTAKE_MODEL
        process.env.BARO_INTAKE_MODEL = "gpt-5.4"
        try {
            let architectRound = 0
            await runArchitectOpenAI({
                goal: "Use an explicitly redirected endpoint",
                cwd: "/unused",
                model: "gpt-5.4",
                effort: "high",
                openaiConnection: {
                    baseURL: "https://compatible.invalid/v1",
                    apiKey: "test-key",
                },
                testRuntime: {
                    tools: [],
                    inferRound: async (_context, model) => {
                        assert.ok(model instanceof GenericOpenAIModel)
                        models.push(model)
                        architectRound += 1
                        return {
                            items: [message(architectRound === 1
                                ? JSON.stringify({
                                      mode: "parallel",
                                      confidence: 1,
                                      reason: "independent surfaces",
                                      maxStories: 4,
                                      parallelism: 2,
                                  })
                                : DECISION_DOCUMENT)],
                            usage: undefined,
                            billingInvocationId: null,
                        }
                    },
                },
            })

            const responder = createDialogueResponder({
                backend: "openai",
                cwd: "/unused",
                model: "gpt-5.4",
                effort: "high",
                openaiConnection: {
                    baseURL: "https://compatible.invalid/v1",
                    apiKey: "test-key",
                },
                openaiRunRound: async (_context, model) => {
                    assert.ok(model instanceof GenericOpenAIModel)
                    models.push(model)
                    return {
                        items: [message('{"message":"Ready.","messages":[]}')],
                        usage: undefined,
                        billingInvocationId: null,
                    }
                },
            })
            await responder(
                {
                    runId: "custom-phase-continuity",
                    messageId: "obligations-1",
                    systemPrompt: "Return JSON.",
                    userPrompt: "Compile obligations.",
                },
                new AbortController().signal,
            )

            assert.equal(models.length, 3)
            for (const model of models) {
                assert.equal(model.specification.name, "gpt-5.4")
                assert.equal(model.specification.supportReasoningEffort, false)
                // The requested high effort was deliberately not applied to a
                // generic Chat Completions model.
                assert.equal(model.getReasoningEffort(), "medium")
                assert.equal(
                    model.connection?.baseURL,
                    "https://compatible.invalid/v1",
                )
            }
            assert.ok(
                createOpenAIModel("deepseek-chat") instanceof GenericOpenAIModel,
            )
        } finally {
            if (previousIntakeModel === undefined) {
                delete process.env.BARO_INTAKE_MODEL
            } else {
                process.env.BARO_INTAKE_MODEL = previousIntakeModel
            }
        }
    })

    it("accepts a bounded ADR-only outcome in decision phase", async () => {
        const outcome = {
            schemaVersion: 1,
            kind: "ready",
            message: "The repository supports a concrete architecture.",
            questions: [],
            evidence: [],
            decisionDocument: DECISION_DOCUMENT,
        }
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([[message(JSON.stringify(outcome))]], tool)
        let resolvedModel: string | undefined

        const result = await runArchitectOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            outcomeMode: true,
            outcomeContractMode: "decision",
            readOnly: true,
            testRuntime: sequence.runtime,
            onArchitectModelResolved: (modelName) => {
                resolvedModel = modelName
            },
        })

        assert.deepEqual(JSON.parse(result), outcome)
        assert.equal(resolvedModel, "glm-5.2")
        const context = JSON.stringify(sequence.contexts[0]!.toJSON())
        assert.match(context, /DECISION PHASE — ADRs ONLY/u)
        assert.doesNotMatch(
            context,
            /SEMANTIC OBLIGATION APPENDIX — REQUIRED/u,
        )
    })

    it("reports every completed round without letting observers alter the run", async () => {
        const model = new GenericOpenAIModel("glm-5.2")
        const tool = fakeTool(async () => "file contents")
        let round = 0
        const runtime: ArchitectOpenAITestRuntime = {
            model,
            tools: [tool],
            inferRound: async () => {
                round += 1
                return {
                    items: round === 1
                        ? [call("inspect")]
                        : [message(DECISION_DOCUMENT)],
                    usage: new TokenUsage(
                        21,
                        8,
                        29,
                        new InputTokenDetails(5),
                        new OutputTokenDetails(3),
                    ),
                    billingInvocationId:
                        round === 1 ? "gateway-invocation-1" : null,
                }
            },
        }
        const invocations: Array<{
            sequence: number
            status: string
            totalState: string
            measurementPublished: boolean
        }> = []
        const resolvedModels: string[] = []

        const result = await runArchitectOpenAI({
            goal: "Observe every architecture round",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            maxRounds: 3,
            testRuntime: runtime,
            onArchitectModelResolved: (modelName) => {
                resolvedModels.push(modelName)
                throw new Error("model observer failure")
            },
            onInvocation: (observation, metadata) => {
                invocations.push({
                    sequence: observation.sequence,
                    status: observation.status,
                    totalState: observation.tokens.total.state,
                    measurementPublished: metadata.measurementPublished,
                })
                throw new Error("invocation observer failure")
            },
        })

        assert.equal(result, DECISION_DOCUMENT)
        assert.deepEqual(resolvedModels, ["glm-5.2"])
        assert.deepEqual(invocations, [
            {
                sequence: 1,
                status: "succeeded",
                totalState: "known",
                measurementPublished: true,
            },
            {
                sequence: 2,
                status: "succeeded",
                totalState: "known",
                measurementPublished: false,
            },
        ])
    })

    it("reports an embedded intake call with its exact model and phase", async () => {
        const previousIntakeModel = process.env.BARO_INTAKE_MODEL
        process.env.BARO_INTAKE_MODEL = "gpt-5.4-mini"
        try {
            let round = 0
            const dispatchedModels: string[] = []
            const observations: Array<{
                sequence: number
                status: string
                phase: string | undefined
                requestedModel: string | undefined
            }> = []
            const result = await runArchitectOpenAI({
                goal: "Observe intake and architecture",
                cwd: "/unused",
                model: "gpt-5.4",
                testRuntime: {
                    tools: [],
                    inferRound: async (_context, model) => {
                        dispatchedModels.push(model.specification.name)
                        round += 1
                        return {
                            items: [message(round === 1
                                ? JSON.stringify({
                                      mode: "parallel",
                                      confidence: 1,
                                      reason: "independent surfaces",
                                      maxStories: 4,
                                      parallelism: 2,
                                  })
                                : DECISION_DOCUMENT)],
                            usage: undefined,
                            billingInvocationId: null,
                        }
                    },
                },
                onInvocation: (observation, metadata) => {
                    observations.push({
                        sequence: observation.sequence,
                        status: observation.status,
                        phase: metadata.phase,
                        requestedModel: metadata.requestedModel,
                    })
                },
            })

            assert.equal(result, DECISION_DOCUMENT)
            assert.deepEqual(dispatchedModels, ["gpt-5.4-mini", "gpt-5.4"])
            assert.deepEqual(observations, [
                {
                    sequence: 1,
                    status: "succeeded",
                    phase: "intake",
                    requestedModel: "gpt-5.4-mini",
                },
                {
                    sequence: 2,
                    status: "succeeded",
                    phase: undefined,
                    requestedModel: undefined,
                },
            ])
        } finally {
            if (previousIntakeModel === undefined) {
                delete process.env.BARO_INTAKE_MODEL
            } else {
                process.env.BARO_INTAKE_MODEL = previousIntakeModel
            }
        }
    })

    it("repairs an obligation appendix emitted during decision phase", async () => {
        const withObligations = {
            schemaVersion: 1,
            kind: "ready",
            message: "Planning may proceed.",
            questions: [],
            evidence: [],
            decisionDocument: OBLIGATION_DOCUMENT,
        }
        const decisionOnly = {
            ...withObligations,
            decisionDocument: DECISION_DOCUMENT,
        }
        const tool = fakeTool(async () => "file contents")
        const sequence = fakeSequence([
            [message(JSON.stringify(withObligations))],
            [message(JSON.stringify(decisionOnly))],
        ], tool)

        const result = await runArchitectOpenAI({
            goal: "Implement cooperative cancellation",
            cwd: "/unused",
            model: "glm-5.2",
            modeContract: PARALLEL_MODE,
            outcomeMode: true,
            outcomeContractMode: "decision",
            readOnly: true,
            maxRounds: 3,
            maxFinalizationRetries: 1,
            testRuntime: sequence.runtime,
        })

        assert.deepEqual(JSON.parse(result), decisionOnly)
        assert.match(
            JSON.stringify(sequence.contexts[1]!.toJSON()),
            /decision-only.*obligation marker/u,
        )
    })

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

    it("uses the host-owned timeout instead of the native round default", async () => {
        const runtime: ArchitectOpenAITestRuntime = {
            model: new GenericOpenAIModel("glm-5.2"),
            tools: [fakeTool(async () => "unused")],
            inferRound: async () => await new Promise<never>(() => {}),
        }

        await assert.rejects(
            runArchitectOpenAI({
                goal: "Validate a complex architecture",
                cwd: "/unused",
                model: "glm-5.2",
                modeContract: PARALLEL_MODE,
                timeoutMs: 20,
                testRuntime: runtime,
            }),
            /phase timed out after 20ms/,
        )
    })

    it("emits failed and timed-out fallback observations for unbilled rounds", async () => {
        for (const scenario of [
            {
                expectedStatus: "failed",
                expectedReason: /provider failed/u,
                runtime: async () => {
                    throw new Error("provider failed")
                },
                perRoundTimeoutSecs: undefined,
            },
            {
                expectedStatus: "timed_out",
                expectedReason: /round 1 timed out/u,
                runtime: async () => await new Promise<never>(() => {}),
                perRoundTimeoutSecs: 0.005,
            },
        ] as const) {
            const observed: Array<{
                status: string
                reason: string | null
                measurementPublished: boolean
            }> = []
            await assert.rejects(
                runArchitectOpenAI({
                    goal: "Observe failed inference",
                    cwd: "/unused",
                    model: "glm-5.2",
                    modeContract: PARALLEL_MODE,
                    perRoundTimeoutSecs: scenario.perRoundTimeoutSecs,
                    testRuntime: {
                        model: new GenericOpenAIModel("glm-5.2"),
                        tools: [],
                        inferRound: scenario.runtime,
                    },
                    onInvocation: (observation, metadata) => {
                        observed.push({
                            status: observation.status,
                            reason:
                                observation.tokens.total.state === "unknown"
                                    ? observation.tokens.total.reason
                                    : null,
                            measurementPublished:
                                metadata.measurementPublished,
                        })
                    },
                }),
                scenario.expectedReason,
            )
            assert.deepEqual(observed, [{
                status: scenario.expectedStatus,
                reason:
                    scenario.expectedStatus === "timed_out"
                        ? "timed_out"
                        : "not_reported",
                measurementPublished: false,
            }])
        }
    })

    it("enforces the absolute phase deadline after a synchronous provider block", async () => {
        const observed: string[] = []
        await assert.rejects(
            runArchitectOpenAI({
                goal: "Do not let blocked event-loop work evade the deadline",
                cwd: "/unused",
                model: "glm-5.2",
                modeContract: PARALLEL_MODE,
                timeoutMs: 10,
                testRuntime: {
                    model: new GenericOpenAIModel("glm-5.2"),
                    tools: [],
                    inferRound: async () => {
                        const blockedUntil = Date.now() + 40
                        while (Date.now() < blockedUntil) {
                            // Reproduce a synchronous provider adapter that
                            // prevents the watchdog timer from firing.
                        }
                        return {
                            items: [message(DECISION_DOCUMENT)],
                            usage: undefined,
                            billingInvocationId: null,
                        }
                    },
                },
                onInvocation: (observation) => {
                    observed.push(observation.status)
                },
            }),
            /phase timed out after 10ms/u,
        )
        assert.deepEqual(observed, ["timed_out"])
    })

    it("shares one host deadline across multiple inference rounds", async () => {
        const model = new GenericOpenAIModel("glm-5.2")
        let round = 0
        const runtime: ArchitectOpenAITestRuntime = {
            model,
            tools: [fakeTool(async () => "file contents")],
            inferRound: async () => {
                round += 1
                if (round === 1) {
                    await new Promise((resolve) => setTimeout(resolve, 25))
                    return { items: [call("continue")], usage: undefined }
                }
                return await new Promise<never>(() => {})
            },
        }
        const startedAt = Date.now()

        await assert.rejects(
            runArchitectOpenAI({
                goal: "Validate a multi-round architecture",
                cwd: "/unused",
                model: "glm-5.2",
                modeContract: PARALLEL_MODE,
                timeoutMs: 60,
                testRuntime: runtime,
            }),
            /phase timed out after 60ms/,
        )

        assert.equal(round, 2)
        assert.ok(
            Date.now() - startedAt < 250,
            "each round must not receive a fresh full phase budget",
        )
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
