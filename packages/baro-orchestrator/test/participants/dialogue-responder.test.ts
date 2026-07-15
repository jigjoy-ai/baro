import assert from "node:assert/strict"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
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
import {
    assertHarnessEnvironmentWasSanitized,
    harnessEnvironmentCaptureProgram,
    withInjectedJigJoyEnvironment,
    withTempDir,
} from "./helpers.js"

describe("dialogue responders", () => {
    it("keeps Baro's injected Gateway credential out of the Claude dialogue process", async () => {
        await withTempDir("dialogue-responder-env-", async (dir) => {
            const capture = join(dir, "environment.json")
            const binary = join(dir, "claude-env.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
process.stdout.write(JSON.stringify({ result: "{\\\"message\\\":\\\"Ready.\\\",\\\"messages\\\":[]}", usage: { input_tokens: 1, output_tokens: 1 } }));
`)
            chmodSync(binary, 0o755)

            await withInjectedJigJoyEnvironment(async () => {
                const responder = createDialogueResponder({
                    backend: "claude",
                    cwd: dir,
                    claudeBin: binary,
                })
                await responder(
                    {
                        runId: "run-dialogue-env",
                        messageId: "message-env",
                        systemPrompt: "system",
                        userPrompt: "status",
                    },
                    new AbortController().signal,
                )
            })
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

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

    it("runs Codex as an ephemeral read-only conversation backend", async () => {
        await withTempDir("dialogue-codex-", async (dir) => {
            const capture = join(dir, "environment.json")
            const argvPath = join(dir, "argv.json")
            const binary = join(dir, "codex.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\\"message\\":\\"Ready.\\",\\"messages\\":[]}" } }));
console.log(JSON.stringify({ type: "turn.completed", model: "gpt-codex-test", usage: { input_tokens: 9, output_tokens: 3 } }));
`)
            chmodSync(binary, 0o755)

            let output: Awaited<ReturnType<ReturnType<typeof createDialogueResponder>>>
            await withInjectedJigJoyEnvironment(async () => {
                const responder = createDialogueResponder({
                    backend: "codex",
                    cwd: dir,
                    codexBin: binary,
                })
                output = await responder(
                    {
                        runId: "run-codex-dialogue",
                        messageId: "message-codex-dialogue",
                        systemPrompt: "system",
                        userPrompt: "status",
                    },
                    new AbortController().signal,
                )
            })

            assert.notEqual(typeof output!, "string")
            if (typeof output! === "string") throw new Error("expected telemetry result")
            assert.equal(output!.invocation.backend, "codex")
            assert.equal(output!.invocation.observation.status, "succeeded")
            assert.equal(output!.invocation.observation.granularity, "turn")
            assert.deepEqual(
                output!.invocation.observation.tokens.total,
                knownMetric(12, "derived"),
            )
            const argv = JSON.parse(readFileSync(argvPath, "utf8")) as string[]
            assert.deepEqual(argv.slice(0, 5), [
                "exec",
                "--json",
                "--sandbox",
                "read-only",
                "--ephemeral",
            ])
            assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false)
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

    it("runs repeatable OpenCode dialogue turns in fresh deny-all directories", async () => {
        await withTempDir("dialogue-opencode-", async (dir) => {
            const capture = join(dir, "opencode-captures.jsonl")
            const binary = join(dir, "opencode.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
    const configPath = process.env.OPENCODE_CONFIG;
    appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        input,
        config: JSON.parse(readFileSync(configPath, "utf8")),
    }) + "\\n");
    console.log(JSON.stringify({ type: "text", part: { text: "{\\"message\\":\\"Ready.\\",\\"messages\\":[]}" } }));
    console.log(JSON.stringify({
        type: "step_finish",
        part: {
            providerID: "zhipu",
            modelID: "glm-test",
            tokens: { total: 4, input: 2, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.001,
        },
    }));
});
`)
            chmodSync(binary, 0o755)
            const responder = createDialogueResponder({
                backend: "opencode",
                cwd: dir,
                opencodeBin: binary,
                model: "zhipu/glm-test",
            })

            for (const messageId of ["message-1", "message-2"]) {
                const output = await responder(
                    {
                        runId: "run-opencode-dialogue",
                        messageId,
                        systemPrompt: "deny every repository tool",
                        userPrompt: `status ${messageId}`,
                    },
                    new AbortController().signal,
                )
                assert.notEqual(typeof output, "string")
                if (typeof output === "string") throw new Error("expected telemetry result")
                assert.equal(output.invocation.backend, "opencode")
                assert.equal(output.invocation.observation.status, "succeeded")
                assert.equal(output.invocation.observation.provider, "zhipu")
            }

            const captures = readFileSync(capture, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as {
                    argv: string[]
                    cwd: string
                    input: string
                    config: {
                        agent: Record<string, {
                            prompt: string
                            permission: Record<string, string>
                            tools: Record<string, boolean>
                        }>
                    }
                })
            assert.equal(captures.length, 2)
            assert.notEqual(captures[0]!.cwd, captures[1]!.cwd)
            for (const [index, item] of captures.entries()) {
                assert.notEqual(item.cwd, dir)
                assert.match(item.cwd, /baro-opencode-dialogue-/)
                assert.equal(existsSync(item.cwd), false)
                assert.equal(item.input, `status message-${index + 1}`)
                assert.deepEqual(item.argv.slice(0, 6), [
                    "run",
                    "--format",
                    "json",
                    "--pure",
                    "--agent",
                    "baro-critic",
                ])
                assert.equal(
                    item.argv.includes("--dangerously-skip-permissions"),
                    false,
                )
                const safeAgent = item.config.agent["baro-critic"]!
                assert.equal(safeAgent.prompt, "deny every repository tool")
                assert.equal(safeAgent.permission["*"], "deny")
                assert.ok(Object.values(safeAgent.tools).every((value) => !value))
            }
        })
    })

    it("runs Pi dialogue without tools, extensions, or repository context", async () => {
        await withTempDir("dialogue-pi-", async (dir) => {
            const capture = join(dir, "pi-capture.json")
            const binary = join(dir, "pi.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }));
    console.log(JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            provider: "deepseek",
            model: "deepseek-test",
            usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
            content: [{ type: "text", text: "{\\"message\\":\\"Ready.\\",\\"messages\\":[]}" }],
        },
    }));
});
`)
            chmodSync(binary, 0o755)
            const responder = createDialogueResponder({
                backend: "pi",
                cwd: dir,
                piBin: binary,
                model: "deepseek-test",
            })

            const output = await responder(
                {
                    runId: "run-pi-dialogue",
                    messageId: "message-pi-dialogue",
                    systemPrompt: "text only system prompt",
                    userPrompt: "status please",
                },
                new AbortController().signal,
            )
            assert.notEqual(typeof output, "string")
            if (typeof output === "string") throw new Error("expected telemetry result")
            assert.equal(output.invocation.backend, "pi")
            assert.equal(output.invocation.observation.provider, "deepseek")

            const captured = JSON.parse(readFileSync(capture, "utf8")) as {
                argv: string[]
                cwd: string
                input: string
            }
            assert.notEqual(captured.cwd, dir)
            assert.match(captured.cwd, /baro-pi-dialogue-/)
            assert.equal(existsSync(captured.cwd), false)
            assert.equal(captured.input, "status please")
            for (const flag of [
                "--no-tools",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
            ]) {
                assert.equal(captured.argv.includes(flag), true, `missing ${flag}`)
            }
            assert.equal(
                captured.argv[captured.argv.indexOf("--system-prompt") + 1],
                "text only system prompt",
            )
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
