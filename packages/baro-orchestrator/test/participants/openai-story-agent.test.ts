import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    FunctionCallItem,
    ModelMessageItem,
    type ModelContext,
    type Tool,
} from "@mozaik-ai/core"

import { OpenAIStoryAgent } from "../../src/participants/openai-story-agent.js"
import {
    AgentResult,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RuntimeReplanRejected,
    StoryResult,
    type RuntimeReplanMutation,
} from "../../src/semantic-events.js"
import { captureEnv, source, withTempDir } from "./helpers.js"

describe("OpenAIStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake OpenAI-compatible backend", async () => {
        await withTempDir("openai-story-agent-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const server = await startFakeOpenAIServer()

            try {
                const address = server.address()
                assert.notEqual(address, null)
                assert.notEqual(typeof address, "string")
                const port = typeof address === "object" ? address.port : 0
                const env = captureEnv()
                const agent = new OpenAIStoryAgent(
                    {
                        id: "story-openai",
                        prompt: "finish the story",
                        cwd,
                        retries: 0,
                        quietTimeoutMs: 5,
                        maxTurns: 1,
                    },
                    {
                        model: "fake-model",
                        baseUrl: `http://127.0.0.1:${port}/v1`,
                        apiKey: "test-key",
                        maxRoundsPerTurn: 1,
                        perRoundTimeoutSecs: 1,
                    },
                )

                const outcome = await agent.run(env)
                const event = env.events.find(StoryResult.is)
                const terminal = env.events.find(AgentResult.is)

                assert.equal(outcome.success, true)
                assert.equal(outcome.storyId, "story-openai")
                assert.equal(outcome.attempts, 1)
                assert.ok(event)
                assert.equal(event.data.storyId, "story-openai")
                assert.equal(event.data.success, true)
                assert.equal(event.data.attempts, 1)
                assert.equal(event.data.error, null)
                assert.ok(terminal?.data.terminalId)
                assert.match(
                    terminal.data.terminalId,
                    /^openai:local:unleased:legacy:story-openai:/,
                )
            } finally {
                await closeServer(server)
            }
        })
    })

    it("emits a failed terminal StoryResult after exhausting OpenAI retries", async () => {
        await withTempDir("openai-story-agent-retry-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const env = captureEnv()
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-openai-retry",
                    prompt: "finish the story",
                    cwd,
                    retries: 1,
                    retryDelayMs: 0,
                    quietTimeoutMs: 5,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 0,
                    perRoundTimeoutSecs: 1,
                },
            )

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-openai-retry")
            assert.equal(outcome.attempts, 2)
            assert.equal(outcome.error, "exceeded maxRoundsPerTurn=0")
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-openai-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, "exceeded maxRoundsPerTurn=0")
        })
    })

    it("classifies quota errors and skips same-route story retries", async () => {
        await withTempDir("openai-story-agent-capacity-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            let requests = 0
            const server = createServer((_req, res) => {
                requests += 1
                res.writeHead(400, { "content-type": "application/json" })
                res.end(
                    JSON.stringify({
                        error: {
                            message: "You exceeded your current quota.",
                            type: "invalid_request_error",
                            code: "insufficient_quota",
                        },
                    }),
                )
            })
            await new Promise<void>((resolve) =>
                server.listen(0, "127.0.0.1", resolve),
            )

            try {
                const address = server.address()
                assert.notEqual(address, null)
                assert.notEqual(typeof address, "string")
                const port = typeof address === "object" ? address.port : 0
                const env = captureEnv()
                const agent = new OpenAIStoryAgent(
                    {
                        id: "story-openai-capacity",
                        prompt: "finish the story",
                        cwd,
                        retries: 2,
                        retryDelayMs: 0,
                        quietTimeoutMs: 5,
                        maxTurns: 1,
                    },
                    {
                        model: "fake-model",
                        baseUrl: `http://127.0.0.1:${port}/v1`,
                        apiKey: "test-key",
                        maxRoundsPerTurn: 1,
                        perRoundTimeoutSecs: 1,
                    },
                )

                const outcome = await agent.run(env)
                const events = env.events.filter(StoryResult.is)

                assert.equal(requests, 1)
                assert.equal(outcome.success, false)
                assert.equal(outcome.attempts, 1)
                assert.deepEqual(outcome.failure, {
                    kind: "provider_capacity",
                    code: "quota_exhausted",
                })
                assert.match(
                    outcome.error ?? "",
                    /provider capacity unavailable in inference round 1/i,
                )
                assert.equal(events.length, 1)
                assert.equal(events[0]?.data.attempts, 1)
                assert.deepEqual(events[0]?.data.failure, outcome.failure)
            } finally {
                await closeServer(server)
            }
        })
    })

    it("enforces the story attempt timeout across a pending native inference", async () => {
        await withTempDir("openai-story-agent-attempt-timeout-", async (dir) => {
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-openai-attempt-timeout",
                    prompt: "finish the story",
                    cwd: dir,
                    retries: 2,
                    timeoutSecs: 0.01,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 2,
                    perRoundTimeoutSecs: 60,
                },
            )
            Object.defineProperty(agent, "runRound", {
                value: () => new Promise<never>(() => {}),
            })
            const env = captureEnv()

            const outcome = await Promise.race([
                agent.run(env),
                new Promise<never>((_resolve, reject) =>
                    setTimeout(
                        () => reject(new Error("attempt timeout did not settle")),
                        500,
                    ),
                ),
            ])

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.error, "attempt 1 timeout after 0.01s")
            assert.equal(agent.getPhase(), "aborted")
        })
    })

    it("does not overlap retries after a Mozaik inference-round timeout", async () => {
        await withTempDir("openai-story-agent-round-timeout-", async (dir) => {
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-openai-round-timeout",
                    prompt: "finish the story",
                    cwd: dir,
                    retries: 2,
                    timeoutSecs: 1,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 2,
                    perRoundTimeoutSecs: 0.01,
                },
            )
            let requests = 0
            Object.defineProperty(agent, "runRound", {
                value: () => {
                    requests += 1
                    return new Promise<never>(() => {})
                },
            })
            const env = captureEnv()

            const outcome = await agent.run(env)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.equal(requests, 1)
            assert.match(outcome.error ?? "", /round 1 timed out/)
        })
    })

    it("cancels a native bash child and skips later writes when the story attempt times out", async () => {
        await withTempDir("openai-story-agent-bash-timeout-", async (dir) => {
            const marker = join(dir, "must-not-run-after-abort.txt")
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-openai-bash-timeout",
                    prompt: "run a slow command",
                    cwd: dir,
                    retries: 0,
                    timeoutSecs: 0.03,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 2,
                    perRoundTimeoutSecs: 60,
                },
            )
            stubInferenceRounds(agent, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-slow-bash",
                        name: "bash",
                        args: JSON.stringify({
                            command:
                                `${JSON.stringify(process.execPath)} -e ` +
                                '"setTimeout(() => {}, 5000)"',
                        }),
                    }),
                    FunctionCallItem.rehydrate({
                        callId: "call-write-after-abort",
                        name: "write_file",
                        args: JSON.stringify({
                            path: "must-not-run-after-abort.txt",
                            content: "unsafe late side effect\n",
                        }),
                    }),
                ],
            ])
            const env = captureEnv()

            const outcome = await Promise.race([
                agent.run(env),
                new Promise<never>((_resolve, reject) =>
                    setTimeout(
                        () => reject(new Error("bash timeout did not settle")),
                        1_000,
                    ),
                ),
            ])

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.error, "attempt 1 timeout after 0.03s")
            assert.equal(agent.getPhase(), "aborted")
            assert.equal(existsSync(marker), false)
        })
    })

    it("returns output from the signal-aware native bash tool", async () => {
        await withTempDir("openai-story-agent-bash-output-", async (dir) => {
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-openai-bash-output",
                    prompt: "run a command",
                    cwd: dir,
                    retries: 0,
                    timeoutSecs: 1,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 2,
                    perRoundTimeoutSecs: 1,
                },
            )
            const contexts = stubInferenceRounds(agent, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-bash-output",
                        name: "bash",
                        args: JSON.stringify({
                            command: "printf 'baro-bash\\n'",
                        }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "command complete" })],
            ])
            const env = captureEnv()

            const outcome = await agent.run(env)

            assert.equal(outcome.success, true)
            assert.equal(
                functionOutput(contexts[1]!, "call-bash-output"),
                "baro-bash\n",
            )
        })
    })

    it("closes bash stdin and bounds stderr returned to the model", async () => {
        await withTempDir("openai-story-agent-bash-bounds-", async (dir) => {
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-openai-bash-bounds",
                    prompt: "run commands",
                    cwd: dir,
                    retries: 0,
                    timeoutSecs: 1,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 2,
                    perRoundTimeoutSecs: 1,
                },
            )
            const contexts = stubInferenceRounds(agent, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-stdin-eof",
                        name: "bash",
                        args: JSON.stringify({ command: "cat" }),
                    }),
                    FunctionCallItem.rehydrate({
                        callId: "call-bounded-stderr",
                        name: "bash",
                        args: JSON.stringify({
                            command:
                                `${JSON.stringify(process.execPath)} -e ` +
                                '"process.stderr.write(\'x\'.repeat(100000)); process.exit(1)"',
                        }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "commands observed" })],
            ])
            const env = captureEnv()

            const outcome = await agent.run(env)

            assert.equal(outcome.success, true)
            assert.equal(
                functionOutput(contexts[1]!, "call-stdin-eof"),
                "(empty output)",
            )
            const errorOutput = functionOutput(
                contexts[1]!,
                "call-bounded-stderr",
            )
            assert.match(errorOutput, /bytes elided/)
            assert.ok(errorOutput.length < 8_500)
        })
    })

    it("executes the last exploration call, refuses later writes, and accepts a final summary", async () => {
        await withTempDir("openai-story-finalization-", async (dir) => {
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-finalization",
                    prompt: "finish, test, and summarize",
                    cwd: dir,
                    retries: 0,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 5,
                    perRoundTimeoutSecs: 1,
                },
            )
            const contexts = stubInferenceRounds(agent, [
                [writeCall("call-explore-1", "explore-1.txt")],
                [writeCall("call-last-explore", "last-explore.txt")],
                [writeCall("call-refused-write", "must-not-exist.txt")],
                [ModelMessageItem.rehydrate({ text: "Implemented and tested." })],
            ])

            const outcome = await agent.run(captureEnv())

            assert.equal(outcome.success, true)
            assert.equal(existsSync(join(dir, "explore-1.txt")), true)
            assert.equal(existsSync(join(dir, "last-explore.txt")), true)
            assert.equal(existsSync(join(dir, "must-not-exist.txt")), false)
            assert.match(
                JSON.stringify(contexts[2]!.toJSON()),
                /tool-execution budget.*closed/i,
            )
            assert.deepEqual(
                JSON.parse(
                    functionOutput(contexts[3]!, "call-refused-write"),
                ),
                {
                    ok: false,
                    status: "refused",
                    code: "tool_budget_closed",
                    tool: "write_file",
                    reason:
                        "Tool execution is closed for this turn. Return the final story summary without calling tools.",
                },
            )
            assert.match(
                JSON.stringify(contexts[3]!.toJSON()),
                /previous tool call was refused/i,
            )
        })
    })

    it("refuses propose_replan during finalization without emitting or waiting for a Board decision", async () => {
        await withTempDir("openai-replan-finalization-", async (dir) => {
            const board = source("collective-board")
            const agent = new OpenAIStoryAgent(
                {
                    id: "S1",
                    prompt: "finish S1",
                    cwd: dir,
                    runId: "run-finalization",
                    leaseId: "lease-S1",
                    generation: 1,
                    graphVersion: 3,
                    retries: 0,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 3,
                    perRoundTimeoutSecs: 1,
                    runtimeReplanDecisionAuthority: board,
                    runtimeReplanDecisionTimeoutMs: 60_000,
                },
            )
            const contexts = stubInferenceRounds(agent, [
                [writeCall("call-last-explore", "completed.txt")],
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-refused-replan",
                        name: "propose_replan",
                        args: JSON.stringify({
                            baseGraphVersion: 3,
                            reason: "Try to add more work after the budget closed",
                            ...runtimeMutation(),
                        }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "S1 is complete." })],
            ])
            const env = captureEnv()
            const deliveredCalls: string[] = []
            const deliveredOutputs: string[] = []
            const deliverFunctionCall = env.deliverFunctionCall.bind(env)
            const deliverFunctionCallOutput =
                env.deliverFunctionCallOutput.bind(env)
            env.deliverFunctionCall = (sourceParticipant, item) => {
                deliveredCalls.push(item.callId)
                deliverFunctionCall(sourceParticipant, item)
            }
            env.deliverFunctionCallOutput = (sourceParticipant, item) => {
                deliveredOutputs.push(item.callId)
                deliverFunctionCallOutput(sourceParticipant, item)
            }
            agent.join(env)

            const outcome = await Promise.race([
                agent.run(env),
                new Promise<never>((_resolve, reject) =>
                    setTimeout(
                        () => reject(new Error("finalization replan waited for Board")),
                        500,
                    ),
                ),
            ])

            assert.equal(outcome.success, true)
            assert.equal(env.events.some(RuntimeReplanProposed.is), false)
            assert.deepEqual(deliveredCalls, ["call-last-explore"])
            assert.deepEqual(deliveredOutputs, ["call-last-explore"])
            assert.deepEqual(
                JSON.parse(
                    functionOutput(contexts[2]!, "call-refused-replan"),
                ),
                {
                    ok: false,
                    status: "refused",
                    code: "tool_budget_closed",
                    tool: "propose_replan",
                    reason:
                        "Tool execution is closed for this turn. Return the final story summary without calling tools.",
                },
            )
            agent.leave(env)
        })
    })

    it("bounds persistent finalization tool calls without executing them", async () => {
        await withTempDir("openai-story-finalization-bounded-", async (dir) => {
            const agent = new OpenAIStoryAgent(
                {
                    id: "story-finalization-bounded",
                    prompt: "keep trying tools",
                    cwd: dir,
                    retries: 0,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 5,
                    perRoundTimeoutSecs: 1,
                },
            )
            const contexts = stubInferenceRounds(agent, [
                [writeCall("call-1", "round-1.txt")],
                [writeCall("call-2", "round-2.txt")],
                [writeCall("call-3", "round-3.txt")],
                [writeCall("call-4", "round-4.txt")],
                [writeCall("call-5", "round-5.txt")],
            ])

            const outcome = await agent.run(captureEnv())

            assert.equal(outcome.success, false)
            assert.equal(outcome.error, "exceeded maxRoundsPerTurn=5")
            assert.equal(contexts.length, 5)
            assert.equal(existsSync(join(dir, "round-1.txt")), true)
            assert.equal(existsSync(join(dir, "round-2.txt")), true)
            assert.equal(existsSync(join(dir, "round-3.txt")), false)
            assert.equal(existsSync(join(dir, "round-4.txt")), false)
            assert.equal(existsSync(join(dir, "round-5.txt")), false)
        })
    })

    it("offers a closed-schema correlated propose_replan tool and waits for the exact applied decision", async () => {
        await withTempDir("openai-runtime-replan-", async (dir) => {
            const board = source("collective-board")
            const agent = new OpenAIStoryAgent(
                {
                    id: "S1",
                    prompt: "Implement S1",
                    cwd: dir,
                    runId: "run-replan-tool",
                    leaseId: "lease-S1",
                    generation: 4,
                    graphVersion: 7,
                    retries: 0,
                    quietTimeoutMs: 1,
                    maxTurns: 1,
                },
                {
                    model: "fake-model",
                    maxRoundsPerTurn: 2,
                    perRoundTimeoutSecs: 1,
                    runtimeReplanDecisionAuthority: board,
                    runtimeReplanDecisionTimeoutMs: 1_000,
                },
            )
            const mutation = runtimeMutation()
            const contexts = stubInferenceRounds(agent, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-runtime-1",
                        name: "propose_replan",
                        args: JSON.stringify({
                            baseGraphVersion: 7,
                            reason: "A migration is required first",
                            ...mutation,
                        }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "continued after Board decision" })],
            ])
            const tools = (agent as unknown as { tools: Tool[] }).tools
            const tool = tools.find((candidate) => candidate.name === "propose_replan")
            assert.ok(tool)
            assert.equal(tool.strict, true)
            assert.equal(tool.parameters.additionalProperties, false)
            assert.equal(tool.parameters.properties.baseGraphVersion.default, 7)

            const env = captureEnv()
            agent.join(env)
            const outcomePromise = agent.run(env)
            const proposed = await waitFor(env.events, RuntimeReplanProposed.is)

            assert.deepEqual(proposed.data, {
                runId: "run-replan-tool",
                proposalId:
                    "run-replan-tool:runtime-replan:S1:lease-S1:4:call-runtime-1",
                sourceStoryId: "S1",
                leaseId: "lease-S1",
                generation: 4,
                baseGraphVersion: 7,
                reason: "A migration is required first",
                mutation,
            })
            assert.match(
                JSON.stringify(contexts[0]?.getItems().map((item) => item.toJSON())),
                /launch graphVersion is 7/,
            )

            env.deliverSemanticEvent(
                source("forged-board"),
                RuntimeReplanApplied.create({
                    ...proposed.data,
                    previousGraphVersion: 7,
                    graphVersion: 99,
                }),
            )
            env.deliverSemanticEvent(
                board,
                RuntimeReplanApplied.create({
                    ...proposed.data,
                    leaseId: "wrong-lease",
                    previousGraphVersion: 7,
                    graphVersion: 98,
                }),
            )
            env.deliverSemanticEvent(
                board,
                RuntimeReplanApplied.create({
                    ...proposed.data,
                    baseGraphVersion: 999,
                    previousGraphVersion: 7,
                    graphVersion: 97,
                }),
            )
            env.deliverSemanticEvent(
                board,
                RuntimeReplanApplied.create({
                    ...proposed.data,
                    previousGraphVersion: 7,
                    graphVersion: 8,
                }),
            )

            const outcome = await outcomePromise
            assert.equal(outcome.success, true)
            const output = functionOutput(contexts[1]!, "call-runtime-1")
            assert.deepEqual(JSON.parse(output), {
                ok: true,
                status: "applied",
                proposalId: proposed.data.proposalId,
                previousGraphVersion: 7,
                graphVersion: 8,
                currentGraphVersion: 8,
                reason: "A migration is required first",
            })
            assert.equal(
                (agent as unknown as { tools: Tool[] }).tools
                    .find((candidate) => candidate.name === "propose_replan")
                    ?.parameters.properties.baseGraphVersion.default,
                8,
            )
            agent.leave(env)
        })
    })

    it("returns a structured rejected runtime replan decision to the next inference round", async () => {
        await withTempDir("openai-runtime-replan-rejected-", async (dir) => {
            const board = source("collective-board")
            const agent = runtimeReplanAgent(dir, board, 5, 1_000)
            const mutation = runtimeMutation()
            const contexts = stubInferenceRounds(agent, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-rejected",
                        name: "propose_replan",
                        args: JSON.stringify({
                            baseGraphVersion: 5,
                            reason: "Try a future-story rewire",
                            ...mutation,
                        }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "handled rejection" })],
            ])
            const env = captureEnv()
            agent.join(env)
            const outcomePromise = agent.run(env)
            const proposed = await waitFor(env.events, RuntimeReplanProposed.is)
            env.deliverSemanticEvent(
                board,
                RuntimeReplanRejected.create({
                    runId: proposed.data.runId,
                    proposalId: proposed.data.proposalId,
                    sourceStoryId: proposed.data.sourceStoryId,
                    leaseId: proposed.data.leaseId,
                    generation: proposed.data.generation,
                    baseGraphVersion: proposed.data.baseGraphVersion,
                    currentGraphVersion: 6,
                    code: "stale_graph_version",
                    reason: "another proposal already advanced the graph",
                }),
            )

            assert.equal((await outcomePromise).success, true)
            assert.deepEqual(
                JSON.parse(functionOutput(contexts[1]!, "call-rejected")),
                {
                    ok: false,
                    status: "rejected",
                    proposalId: proposed.data.proposalId,
                    code: "stale_graph_version",
                    reason: "another proposal already advanced the graph",
                    currentGraphVersion: 6,
                },
            )
            agent.leave(env)
        })
    })

    it("intercepts replan before same-batch writes and skips them when the Board rejects it", async () => {
        await withTempDir("openai-runtime-replan-order-", async (dir) => {
            const board = source("collective-board")
            const agent = runtimeReplanAgent(dir, board, 5, 1_000)
            const target = join(dir, "must-not-be-written.txt")
            const contexts = stubInferenceRounds(agent, [
                [
                    // Provider order is deliberately unsafe: the ordinary
                    // write appears before the control-plane proposal.
                    FunctionCallItem.rehydrate({
                        callId: "call-write-before-replan",
                        name: "write_file",
                        args: JSON.stringify({
                            path: "must-not-be-written.txt",
                            content: "unsafe before decision\n",
                        }),
                    }),
                    FunctionCallItem.rehydrate({
                        callId: "call-control-replan",
                        name: "propose_replan",
                        args: JSON.stringify({
                            baseGraphVersion: 5,
                            reason: "Need Board approval before continuing",
                            ...runtimeMutation(),
                        }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "observed the rejection" })],
            ])
            const env = captureEnv()
            agent.join(env)
            const outcomePromise = agent.run(env)
            const proposed = await waitFor(env.events, RuntimeReplanProposed.is)
            assert.equal(existsSync(target), false)

            env.deliverSemanticEvent(
                board,
                RuntimeReplanRejected.create({
                    runId: proposed.data.runId,
                    proposalId: proposed.data.proposalId,
                    sourceStoryId: proposed.data.sourceStoryId,
                    leaseId: proposed.data.leaseId,
                    generation: proposed.data.generation,
                    baseGraphVersion: proposed.data.baseGraphVersion,
                    currentGraphVersion: 5,
                    code: "immutable_story",
                    reason: "active work cannot be replaced",
                }),
            )

            assert.equal((await outcomePromise).success, true)
            assert.equal(existsSync(target), false)
            assert.deepEqual(
                functionOutputCallIds(contexts[1]!),
                ["call-write-before-replan", "call-control-replan"],
            )
            assert.deepEqual(
                JSON.parse(
                    functionOutput(
                        contexts[1]!,
                        "call-write-before-replan",
                    ),
                ),
                {
                    ok: false,
                    status: "skipped",
                    code: "replan_not_applied",
                    reason:
                        "Ordinary tool execution in this inference batch was skipped because its runtime replan was not applied. Reconsider the Board decision in the next round.",
                },
            )
            agent.leave(env)
        })
    })

    it("fails the tool call closed on invalid args or a missing decision and never enables it in legacy mode", async () => {
        await withTempDir("openai-runtime-replan-fail-closed-", async (dir) => {
            const board = source("collective-board")
            const invalid = runtimeReplanAgent(dir, board, 2, 1_000)
            const invalidContexts = stubInferenceRounds(invalid, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-invalid",
                        name: "propose_replan",
                        args: "{not-json",
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "fixed invalid proposal" })],
            ])
            const invalidEnv = captureEnv()
            invalid.join(invalidEnv)
            assert.equal((await invalid.run(invalidEnv)).success, true)
            assert.equal(invalidEnv.events.some(RuntimeReplanProposed.is), false)
            assert.equal(
                JSON.parse(functionOutput(invalidContexts[1]!, "call-invalid")).status,
                "invalid",
            )
            invalid.leave(invalidEnv)

            const timingOut = runtimeReplanAgent(dir, board, 2, 5)
            const timeoutContexts = stubInferenceRounds(timingOut, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-timeout",
                        name: "propose_replan",
                        args: JSON.stringify({
                            baseGraphVersion: 2,
                            reason: "No Board response",
                            ...runtimeMutation(),
                        }),
                    }),
                ],
                [ModelMessageItem.rehydrate({ text: "continued after timeout" })],
            ])
            const timeoutEnv = captureEnv()
            timingOut.join(timeoutEnv)
            const timedOutOutcome = await timingOut.run(timeoutEnv)
            assert.equal(timedOutOutcome.success, false)
            assert.match(timedOutOutcome.error ?? "", /outcome is unknown/)
            assert.equal(timeoutEnv.events.filter(RuntimeReplanProposed.is).length, 1)
            assert.equal(timeoutContexts.length, 1)
            timingOut.leave(timeoutEnv)

            const legacy = new OpenAIStoryAgent(
                {
                    id: "legacy-story",
                    prompt: "legacy",
                    cwd: dir,
                    graphVersion: 2,
                },
                {
                    model: "fake-model",
                    runtimeReplanDecisionAuthority: board,
                },
            )
            const tools = (legacy as unknown as { tools: Tool[] }).tools
            assert.equal(tools.some((tool) => tool.name === "propose_replan"), false)
        })
    })

    it("aborts a pending runtime replan promptly and ignores a late decision", async () => {
        await withTempDir("openai-runtime-replan-abort-", async (dir) => {
            const board = source("collective-board")
            const agent = runtimeReplanAgent(dir, board, 4, 60_000)
            stubInferenceRounds(agent, [
                [
                    FunctionCallItem.rehydrate({
                        callId: "call-aborted",
                        name: "propose_replan",
                        args: JSON.stringify({
                            baseGraphVersion: 4,
                            reason: "Wait for a Board decision",
                            ...runtimeMutation(),
                        }),
                    }),
                ],
            ])
            const env = captureEnv()
            agent.join(env)
            const outcomePromise = agent.run(env)
            const proposed = await waitFor(env.events, RuntimeReplanProposed.is)

            agent.abort()
            const outcome = await Promise.race([
                outcomePromise,
                new Promise<never>((_resolve, reject) =>
                    setTimeout(
                        () => reject(new Error("abort did not settle promptly")),
                        500,
                    ),
                ),
            ])
            assert.equal(outcome.success, false)
            assert.equal(outcome.error, "story was aborted")
            assert.equal(agent.getPhase(), "aborted")

            env.deliverSemanticEvent(
                board,
                RuntimeReplanApplied.create({
                    ...proposed.data,
                    previousGraphVersion: 4,
                    graphVersion: 5,
                    currentGraphVersion: 5,
                }),
            )
            await new Promise<void>((resolve) => setImmediate(resolve))
            assert.equal(agent.getPhase(), "aborted")
            agent.leave(env)
        })
    })
})

function runtimeMutation(): RuntimeReplanMutation {
    return {
        addedStories: [
            {
                id: "S2",
                priority: 2,
                title: "Add prerequisite migration",
                description: "Create the migration required by S1.",
                dependsOn: [],
                acceptance: ["migration exists"],
                tests: ["npm test"],
            },
        ],
        removedStoryIds: [],
        modifiedDeps: {},
    }
}

function writeCall(callId: string, path: string): FunctionCallItem {
    return FunctionCallItem.rehydrate({
        callId,
        name: "write_file",
        args: JSON.stringify({ path, content: `${callId}\n` }),
    })
}

function runtimeReplanAgent(
    cwd: string,
    board: ReturnType<typeof source>,
    graphVersion: number,
    timeoutMs: number,
): OpenAIStoryAgent {
    return new OpenAIStoryAgent(
        {
            id: "S1",
            prompt: "Implement S1",
            cwd,
            runId: "run-runtime-tool",
            leaseId: "lease-S1",
            generation: 3,
            graphVersion,
            retries: 0,
            quietTimeoutMs: 1,
            maxTurns: 1,
        },
        {
            model: "fake-model",
            maxRoundsPerTurn: 2,
            perRoundTimeoutSecs: 1,
            runtimeReplanDecisionAuthority: board,
            runtimeReplanDecisionTimeoutMs: timeoutMs,
        },
    )
}

function stubInferenceRounds(
    agent: OpenAIStoryAgent,
    rounds: Array<Array<FunctionCallItem | ModelMessageItem>>,
): ModelContext[] {
    const contexts: ModelContext[] = []
    let index = 0
    Object.defineProperty(agent, "runRound", {
        value: async (context: ModelContext) => {
            contexts.push(context)
            const items = rounds[index++]
            assert.ok(items, `unexpected inference round ${index}`)
            return { items, usage: undefined }
        },
    })
    return contexts
}

function functionOutput(context: ModelContext, callId: string): string {
    for (const item of context.getItems()) {
        const json = item.toJSON() as {
            type?: string
            call_id?: string
            output?: Array<{ text?: string }>
        }
        if (json.type === "function_call_output" && json.call_id === callId) {
            assert.equal(typeof json.output?.[0]?.text, "string")
            return json.output![0]!.text!
        }
    }
    assert.fail(`missing function output for ${callId}`)
}

function functionOutputCallIds(context: ModelContext): string[] {
    return context
        .getItems()
        .map((item) => item.toJSON() as { type?: string; call_id?: string })
        .filter(
            (item): item is { type: "function_call_output"; call_id: string } =>
                item.type === "function_call_output" &&
                typeof item.call_id === "string",
        )
        .map((item) => item.call_id)
}

async function waitFor<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const event = events.find(guard)
        if (event) return event
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.fail("timed out waiting for semantic event")
}

async function startFakeOpenAIServer(): Promise<Server> {
    const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
            JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: "story complete",
                        },
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 2,
                    total_tokens: 3,
                },
            }),
        )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return server
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
}
