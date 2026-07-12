import assert from "node:assert/strict"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    InputTokenDetails,
    OutputTokenDetails,
    TokenUsage,
} from "@mozaik-ai/core"

import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
} from "../../src/model-telemetry.js"
import { DialogueResponderInvocationError } from "../../src/participants/dialogue-agent.js"
import { createDialogueResponder } from "../../src/participants/dialogue-responder.js"
import { withTempDir } from "./helpers.js"

describe("dialogue responders", () => {
    it("runs Claude without tools and returns CLI usage evidence", async () => {
        await withTempDir("dialogue-responder-", async (dir) => {
            const binary = join(dir, "claude")
            const argvPath = join(dir, "argv.txt")
            writeFileSync(
                binary,
                "#!/bin/sh\n" +
                    "printf '%s\\n' \"$@\" > \"$BARO_DIALOGUE_ARGV\"\n" +
                    "printf '%s' '{\"result\":\"{\\\"message\\\":\\\"All good.\\\",\\\"messages\\\":[]}\",\"session_id\":\"not-a-request-id\",\"duration_ms\":123,\"total_cost_usd\":0.004,\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":4,\"cache_creation_input_tokens\":2,\"output_tokens\":3}}'\n",
            )
            chmodSync(binary, 0o755)
            const previous = process.env.BARO_DIALOGUE_ARGV
            process.env.BARO_DIALOGUE_ARGV = argvPath
            try {
                const responder = createDialogueResponder({
                    backend: "claude",
                    cwd: dir,
                    claudeBin: binary,
                    model: "haiku",
                })
                const output = await responder(
                    {
                        runId: "run-1",
                        messageId: "message-1",
                        systemPrompt: "system",
                        userPrompt: "status",
                    },
                    new AbortController().signal,
                )
                assert.notEqual(typeof output, "string")
                if (typeof output === "string") {
                    throw new Error("expected telemetry result")
                }
                assert.match(output.text, /All good/)
                assert.equal(output.invocation.backend, "claude")
                assert.equal(output.invocation.requestedModel, "haiku")
                const observation = output.invocation.observation
                assert.equal(observation.sequence, 1)
                assert.equal(observation.status, "succeeded")
                assert.equal(observation.granularity, "process")
                assert.equal(observation.providerRequestId, null)
                assert.deepEqual(
                    observation.durationMs,
                    knownMetric(123, "cli_result"),
                )
                assert.deepEqual(
                    observation.tokens.inputTotal,
                    knownMetric(16, "derived"),
                )
                assert.deepEqual(
                    observation.tokens.cachedInput,
                    knownMetric(4, "provider_response"),
                )
                assert.deepEqual(
                    observation.tokens.cacheWriteInput,
                    knownMetric(2, "provider_response"),
                )
                assert.deepEqual(
                    observation.tokens.outputTotal,
                    knownMetric(3, "provider_response"),
                )
                assert.deepEqual(
                    observation.cost.equivalentUsd,
                    knownMetric(0.004, "cli_result"),
                )
                const args = readFileSync(argvPath, "utf8").split("\n")
                const tools = args.indexOf("--tools")
                assert.ok(tools >= 0)
                assert.equal(args[tools + 1], "")
                assert.equal(
                    args.includes("--dangerously-skip-permissions"),
                    false,
                )
                assert.equal(args.includes("--permission-mode"), false)
            } finally {
                if (previous === undefined) {
                    delete process.env.BARO_DIALOGUE_ARGV
                } else {
                    process.env.BARO_DIALOGUE_ARGV = previous
                }
            }
        })
    })

    it("maps OpenAI TokenUsage without inventing generic-endpoint cache or cost", async () => {
        const responder = createDialogueResponder({
            backend: "openai",
            cwd: process.cwd(),
            model: "deepseek-chat",
            openaiConnection: { baseURL: "https://compatible.invalid/v1" },
            openaiRunRound: async () => ({
                items: [
                    {
                        type: "message",
                        toJSON: () => ({
                            content: [{
                                text: "{\"message\":\"Ready.\",\"messages\":[]}",
                            }],
                        }),
                    },
                ] as never,
                usage: new TokenUsage(
                    20,
                    7,
                    27,
                    new InputTokenDetails(0),
                    new OutputTokenDetails(2),
                ),
            }),
        })

        const output = await responder(
            {
                runId: "run-openai",
                messageId: "message-openai",
                systemPrompt: "system",
                userPrompt: "status",
            },
            new AbortController().signal,
        )
        assert.notEqual(typeof output, "string")
        if (typeof output === "string") {
            throw new Error("expected telemetry result")
        }
        const observation = output.invocation.observation
        assert.equal(output.invocation.backend, "openai")
        assert.equal(observation.status, "succeeded")
        assert.equal(observation.granularity, "round")
        assert.deepEqual(
            observation.tokens.inputTotal,
            knownMetric(20, "provider_response"),
        )
        assert.deepEqual(
            observation.tokens.cachedInput,
            unknownMetric("not_reported"),
        )
        assert.deepEqual(
            observation.tokens.reasoningOutput,
            knownMetric(2, "provider_response"),
        )
        assert.deepEqual(
            observation.cost.providerUsd,
            unknownMetric("pending_gateway_meter"),
        )
        assert.deepEqual(
            observation.cost.customerUsd,
            unknownMetric("pending_gateway_meter"),
        )
        assert.deepEqual(
            observation.cost.equivalentUsd,
            notApplicableMetric(),
        )
    })

    it("attaches one unknown observation to attributable provider failures", async () => {
        await withTempDir("dialogue-responder-failure-", async (dir) => {
            const binary = join(dir, "claude")
            writeFileSync(binary, "#!/bin/sh\nexit 7\n")
            chmodSync(binary, 0o755)
            const claude = createDialogueResponder({
                backend: "claude",
                cwd: dir,
                claudeBin: binary,
            })
            await assert.rejects(
                claude(
                    {
                        runId: "run-failure",
                        messageId: "message-failure",
                        systemPrompt: "system",
                        userPrompt: "status",
                    },
                    new AbortController().signal,
                ),
                (error: unknown) => {
                    assert.ok(error instanceof DialogueResponderInvocationError)
                    assert.equal(error.invocation.observation.status, "failed")
                    assert.deepEqual(
                        error.invocation.observation.tokens.total,
                        unknownMetric("not_reported"),
                    )
                    return true
                },
            )

            const neverStarted = createDialogueResponder({
                backend: "claude",
                cwd: dir,
                claudeBin: join(dir, "missing-claude"),
            })
            await assert.rejects(
                neverStarted(
                    {
                        runId: "run-not-started",
                        messageId: "message-not-started",
                        systemPrompt: "system",
                        userPrompt: "status",
                    },
                    new AbortController().signal,
                ),
                (error: unknown) => {
                    assert.equal(
                        error instanceof DialogueResponderInvocationError,
                        false,
                    )
                    return true
                },
            )
        })

        const openai = createDialogueResponder({
            backend: "openai",
            cwd: process.cwd(),
            openaiRunRound: async () => {
                throw Object.assign(new Error("request timed out"), {
                    code: "ETIMEDOUT",
                })
            },
        })
        await assert.rejects(
            openai(
                {
                    runId: "run-timeout",
                    messageId: "message-timeout",
                    systemPrompt: "system",
                    userPrompt: "status",
                },
                new AbortController().signal,
            ),
            (error: unknown) => {
                assert.ok(error instanceof DialogueResponderInvocationError)
                assert.equal(error.invocation.observation.status, "timed_out")
                assert.deepEqual(
                    error.invocation.observation.durationMs,
                    unknownMetric("timed_out"),
                )
                return true
            },
        )
    })
})
