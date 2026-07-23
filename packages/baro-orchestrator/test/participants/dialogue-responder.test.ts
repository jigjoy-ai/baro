import assert from "node:assert/strict"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"

import {
    InputTokenDetails,
    OutputTokenDetails,
    TokenUsage,
} from "../../src/runtime/mozaik.js"

import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
} from "../../src/model-telemetry.js"
import { GatewayBillingCoordinator } from "../../src/billing/index.js"
import { DialogueResponderInvocationError } from "../../src/participants/dialogue-agent.js"
import { createDialogueResponder } from "../../src/participants/dialogue-responder.js"
import { providerCallTimeoutError } from "../../src/planning/openai-runtime.js"
import { ConversationIntake } from "../../src/session/conversation-intake.js"
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
                assert.equal(args.includes("--effort"), false)
            } finally {
                if (previous === undefined) {
                    delete process.env.BARO_DIALOGUE_ARGV
                } else {
                    process.env.BARO_DIALOGUE_ARGV = previous
                }
            }
        })
    })

    it("hardens Claude when reused as a safe read-only evaluator", async () => {
        await withTempDir("dialogue-claude-safe-evaluator-", async (dir) => {
            const capture = join(dir, "argv.json")
            const binary = join(dir, "claude-safe.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({
  result: ${JSON.stringify(JSON.stringify({ message: "Ready.", messages: [] }))},
  usage: { input_tokens: 1, output_tokens: 1 }
}));
`)
            chmodSync(binary, 0o755)
            const responder = createDialogueResponder({
                backend: "claude",
                cwd: dir,
                claudeBin: binary,
                safeReadOnlyEvaluator: true,
            })
            await responder(
                {
                    runId: "safe-claude-evaluator",
                    messageId: "obligations-1",
                    systemPrompt: "Evaluate only the supplied text.",
                    userPrompt: "Return JSON.",
                },
                new AbortController().signal,
            )

            const argv = JSON.parse(readFileSync(capture, "utf8")) as string[]
            for (const flag of [
                "--safe-mode",
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--no-session-persistence",
            ]) {
                assert.equal(argv.includes(flag), true, `missing ${flag}`)
            }
            assert.equal(argv[argv.indexOf("--tools") + 1], "")
            assert.equal(
                argv[argv.indexOf("--mcp-config") + 1],
                '{"mcpServers":{}}',
            )
            assert.equal(
                argv[argv.indexOf("--permission-mode") + 1],
                "dontAsk",
            )
        })
    })

    it("kills a TERM-resistant Claude descendant before cancellation returns", async () => {
        await withTempDir("dialogue-claude-tree-", async (dir) => {
            const started = join(dir, "descendant-started")
            const escaped = join(dir, "descendant-escaped")
            const binary = join(dir, "tree-claude.mjs")
            const descendantSource = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "yes");
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(${JSON.stringify(escaped)}, "yes"), 700);
setInterval(() => {}, 10_000);
`
            writeFileSync(binary, `#!/usr/bin/env node
import { spawn } from "node:child_process";
spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
setInterval(() => {}, 10_000);
`)
            chmodSync(binary, 0o755)
            const responder = createDialogueResponder({
                backend: "claude",
                cwd: dir,
                claudeBin: binary,
                terminationGraceMs: 50,
            })
            const controller = new AbortController()
            const result = responder(
                {
                    runId: "run-claude-tree",
                    messageId: "message-claude-tree",
                    systemPrompt: "No tools.",
                    userPrompt: "status",
                },
                controller.signal,
            )

            try {
                await waitForFile(started)
                controller.abort()
                await assert.rejects(result, (error: unknown) => {
                    assert.ok(error instanceof DialogueResponderInvocationError)
                    assert.equal(error.invocation.observation.status, "cancelled")
                    assert.deepEqual(
                        error.invocation.observation.tokens.total,
                        unknownMetric("not_reported"),
                    )
                    return true
                })
            } finally {
                controller.abort()
            }

            await delay(750)
            assert.equal(
                existsSync(escaped),
                false,
                "Claude descendant survived cancellation escalation",
            )
        })
    })

    it("runs Codex read-only and ignores ambient config/rules for conversation", async () => {
        await withTempDir("dialogue-codex-", async (dir) => {
            const capture = join(dir, "environment.json")
            const argvPath = join(dir, "argv.json")
            const binary = join(dir, "codex.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(`${argvPath}.stdin`)}, input);
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
            assert.deepEqual(argv.slice(0, 2), ["exec", "--json"])
            for (const value of [
                'default_permissions="baro_dialogue"',
                'permissions.baro_dialogue.description="Baro brokered text-only front door"',
                'permissions.baro_dialogue.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
                'approval_policy="never"',
                'web_search="disabled"',
                'shell_environment_policy.inherit="none"',
                "allow_login_shell=false",
                "project_doc_max_bytes=0",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
            ]) {
                assert.equal(argv.includes(value), true, `missing ${value}`)
            }
            assert.equal(argv.filter((value) => value === "--strict-config").length, 1)
            assert.equal(
                argv.some((value) => value.startsWith("model_reasoning_effort=")),
                false,
            )
            assert.equal(argv.includes("--sandbox"), false)
            assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false)
            assert.equal(argv.at(-1), "-")
            assert.equal(readFileSync(`${argvPath}.stdin`, "utf8"), "system\n\nstatus")
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

    it("forwards optional effort and a safe diagnostic label to text-only harnesses", async () => {
        await withTempDir("dialogue-responder-options-", async (dir) => {
            const claudeArgv = join(dir, "claude-argv.json")
            const claude = join(dir, "claude-options.mjs")
            writeFileSync(claude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(claudeArgv)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ result: "ready", usage: { input_tokens: 1, output_tokens: 1 } }));
`)
            chmodSync(claude, 0o755)
            const claudeResponder = createDialogueResponder({
                backend: "claude",
                cwd: dir,
                claudeBin: claude,
                effort: "high",
            })
            await claudeResponder({
                runId: "run-claude-options",
                messageId: "message-claude-options",
                systemPrompt: "system",
                userPrompt: "status",
            }, new AbortController().signal)
            const claudeArgs = JSON.parse(
                readFileSync(claudeArgv, "utf8"),
            ) as string[]
            assert.equal(
                claudeArgs[claudeArgs.indexOf("--effort") + 1],
                "high",
            )

            const codexArgv = join(dir, "codex-argv.json")
            const codex = join(dir, "codex-options.mjs")
            writeFileSync(codex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(codexArgv)}, JSON.stringify(process.argv.slice(2)));
process.stderr.write("provider diagnostic marker\\n");
console.log(JSON.stringify({ type: "turn.failed", error: { code: "max_output_tokens", message: "maximum output tokens reached" } }));
process.exitCode = 1;
`)
            chmodSync(codex, 0o755)
            const stderrWrite = process.stderr.write
            let capturedStderr = ""
            process.stderr.write = ((chunk: string | Uint8Array) => {
                capturedStderr += typeof chunk === "string"
                    ? chunk
                    : Buffer.from(chunk).toString("utf8")
                return true
            }) as typeof process.stderr.write
            try {
                const codexResponder = createDialogueResponder({
                    backend: "codex",
                    cwd: dir,
                    codexBin: codex,
                    codexSkipGitRepoCheck: true,
                    diagnosticLabel: "codex-architect",
                    effort: "xhigh",
                })
                await assert.rejects(
                    codexResponder({
                        runId: "run-codex-options",
                        messageId: "message-codex-options",
                        systemPrompt: "system",
                        userPrompt: "status",
                    }, new AbortController().signal),
                    (error: unknown) => {
                        assert.ok(
                            error instanceof DialogueResponderInvocationError,
                        )
                        assert.ok(error.cause instanceof Error)
                        assert.match(error.cause.message, /max_output_tokens/u)
                        return true
                    },
                )
            } finally {
                process.stderr.write = stderrWrite
            }
            const codexArgs = JSON.parse(
                readFileSync(codexArgv, "utf8"),
            ) as string[]
            assert.equal(
                codexArgs.includes('model_reasoning_effort="xhigh"'),
                true,
            )
            assert.match(
                capturedStderr,
                /\[codex-architect\/stderr\] provider diagnostic marker/u,
            )
            assert.match(
                capturedStderr,
                /\[codex-architect\] diagnostic .*max_output_tokens/u,
            )

            assert.throws(
                () => createDialogueResponder({
                    backend: "openai",
                    cwd: dir,
                    diagnosticLabel: "unsafe\nlabel",
                }),
                /diagnosticLabel must be 1-128 safe label characters/u,
            )
        })
    })

    it("transports Windows-unsafe large Claude and Codex prompts over stdin", async () => {
        await withTempDir("dialogue-large-stdin-", async (dir) => {
            const large = `large:${"x".repeat(40_000)}`
            const claudeCapture = join(dir, "claude-large.json")
            const claude = join(dir, "claude-large.mjs")
            writeFileSync(claude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(claudeCapture)}, JSON.stringify({ argv: process.argv.slice(2), input }));
process.stdout.write(JSON.stringify({
  result: ${JSON.stringify(JSON.stringify({ message: "Ready.", messages: [] }))},
  usage: { input_tokens: 1, output_tokens: 1 }
}));
`)
            chmodSync(claude, 0o755)
            const claudeResponder = createDialogueResponder({
                backend: "claude",
                cwd: dir,
                claudeBin: claude,
            })
            await claudeResponder({
                runId: "run-large-claude",
                messageId: "message-large-claude",
                systemPrompt: "system",
                userPrompt: large,
            }, new AbortController().signal)
            const claudeObserved = JSON.parse(
                readFileSync(claudeCapture, "utf8"),
            ) as { argv: string[]; input: string }
            assert.equal(claudeObserved.input, large)
            assert.equal(claudeObserved.argv.includes(large), false)
            assert.equal(claudeObserved.argv.includes("-p"), false)

            const codexCapture = join(dir, "codex-large.json")
            const codex = join(dir, "codex-large.mjs")
            writeFileSync(codex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(codexCapture)}, JSON.stringify({ argv: process.argv.slice(2), input }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(JSON.stringify({ message: "Ready.", messages: [] }))} } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`)
            chmodSync(codex, 0o755)
            const codexResponder = createDialogueResponder({
                backend: "codex",
                cwd: dir,
                codexBin: codex,
                codexSkipGitRepoCheck: true,
            })
            await codexResponder({
                runId: "run-large-codex",
                messageId: "message-large-codex",
                systemPrompt: "system",
                userPrompt: large,
            }, new AbortController().signal)
            const codexObserved = JSON.parse(
                readFileSync(codexCapture, "utf8"),
            ) as { argv: string[]; input: string }
            assert.equal(codexObserved.input, `system\n\n${large}`)
            assert.equal(codexObserved.argv.at(-1), "-")
            assert.equal(codexObserved.argv.includes(large), false)
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

    it("keeps front-door roles distinct and accepts an explicit runtime phase", async () => {
        const phases: string[] = []
        const attempts: Array<number | null> = []
        const billing = new GatewayBillingCoordinator({
            runId: "session-front-door-billing",
            gatewayBaseUrl: "https://gateway.example/v1",
            apiKey: "test-gateway-key",
            publishMeasurement: () => undefined,
            drainTimeoutMs: 0,
        })
        try {
            const responder = createDialogueResponder({
                backend: "openai",
                cwd: process.cwd(),
                model: "deepseek-chat",
                openaiConnection: {
                    baseURL: "https://gateway.example/v1",
                    apiKey: "test-gateway-key",
                },
                billingCoordinator: billing,
                openaiRunRound: async (_context, _model, options) => {
                    phases.push(options.billing?.context.phase ?? "missing")
                    attempts.push(options.billing?.context.attempt ?? null)
                    return {
                        items: [{
                            type: "message",
                            toJSON: () => ({
                                content: [{
                                    text: "{\"message\":\"Ready.\",\"messages\":[]}",
                                }],
                            }),
                        }] as never,
                        usage: new TokenUsage(1, 1, 2),
                        billingInvocationId: null,
                    }
                },
            })

            for (const billingRole of [
                "conversation",
                "repository_scout",
            ] as const) {
                await responder(
                    {
                        runId: "session-front-door-billing",
                        messageId: `message-${billingRole}`,
                        billingRole,
                        systemPrompt: "system",
                        userPrompt: "status",
                    },
                    new AbortController().signal,
                )
            }
            for (const billingAttempt of [1, 2]) {
                await responder(
                    {
                        runId: "runtime-goal-review",
                        messageId: `message-goal-review-${billingAttempt}`,
                        billingPhase: "verifier",
                        billingAttempt,
                        systemPrompt: "system",
                        userPrompt: "review",
                    },
                    new AbortController().signal,
                )
            }
            assert.deepEqual(phases, [
                "dialogue",
                "intake",
                "verifier",
                "verifier",
            ])
            assert.deepEqual(attempts, [null, null, 1, 2])
        } finally {
            billing.close()
        }
    })

    it("threads cancellation into OpenAI inference and awaits provider settlement", async () => {
        let providerSettled = false
        const responder = createDialogueResponder({
            backend: "openai",
            cwd: process.cwd(),
            openaiRunRound: async (_context, _model, options) =>
                new Promise((_resolve, reject) => {
                    const signal = options.signal
                    assert.ok(signal)
                    signal.addEventListener(
                        "abort",
                        () => {
                            setTimeout(() => {
                                providerSettled = true
                                reject(
                                    Object.assign(new Error("provider aborted"), {
                                        name: "AbortError",
                                    }),
                                )
                            }, 25)
                        },
                        { once: true },
                    )
                }),
        })
        const controller = new AbortController()
        const pending = responder(
            {
                runId: "run-openai-abort",
                messageId: "message-openai-abort",
                systemPrompt: "system",
                userPrompt: "status",
            },
            controller.signal,
        )

        controller.abort()
        await assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof DialogueResponderInvocationError)
            assert.equal(error.invocation.observation.status, "cancelled")
            assert.deepEqual(
                error.invocation.observation.durationMs,
                unknownMetric("not_reported"),
            )
            return true
        })
        assert.equal(providerSettled, true)
    })

    it("overrides local one-shot timeout attribution for caller cancellation", async () => {
        await withTempDir("dialogue-local-cancel-", async (dir) => {
            const binary = join(dir, "hanging-provider.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 10_000);
`)
            chmodSync(binary, 0o755)

            for (const backend of ["codex", "opencode", "pi"] as const) {
                const responder = createDialogueResponder({
                    backend,
                    cwd: dir,
                    terminationGraceMs: 50,
                    ...(backend === "codex"
                        ? { codexBin: binary, codexSkipGitRepoCheck: true }
                        : backend === "opencode"
                          ? { opencodeBin: binary }
                          : { piBin: binary }),
                })
                const controller = new AbortController()
                const pending = responder(
                    {
                        runId: `run-${backend}-cancel`,
                        messageId: `message-${backend}-cancel`,
                        systemPrompt: "No tools.",
                        userPrompt: "status",
                    },
                    controller.signal,
                )
                controller.abort()

                await assert.rejects(pending, (error: unknown) => {
                    assert.ok(error instanceof DialogueResponderInvocationError)
                    assert.equal(error.invocation.observation.status, "cancelled")
                    assert.deepEqual(
                        error.invocation.observation.tokens.total,
                        unknownMetric("not_reported"),
                    )
                    return true
                })
            }
        })
    })

    it("keeps a typed caller timeout authoritative over local runner cancellation", async () => {
        await withTempDir("dialogue-local-typed-timeout-", async (dir) => {
            const binary = join(dir, "hanging-provider.mjs")
            writeFileSync(binary, `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 10_000);
`)
            chmodSync(binary, 0o755)

            for (const backend of ["codex", "opencode", "pi"] as const) {
                const responder = createDialogueResponder({
                    backend,
                    cwd: dir,
                    terminationGraceMs: 50,
                    ...(backend === "codex"
                        ? { codexBin: binary, codexSkipGitRepoCheck: true }
                        : backend === "opencode"
                          ? { opencodeBin: binary }
                          : { piBin: binary }),
                })
                const controller = new AbortController()
                const pending = responder(
                    {
                        runId: `run-${backend}-typed-timeout`,
                        messageId: `message-${backend}-typed-timeout`,
                        systemPrompt: "No tools.",
                        userPrompt: "status",
                    },
                    controller.signal,
                )
                controller.abort(providerCallTimeoutError(20))

                await assert.rejects(pending, (error: unknown) => {
                    assert.ok(error instanceof DialogueResponderInvocationError)
                    assert.equal(error.invocation.observation.status, "timed_out")
                    assert.deepEqual(
                        error.invocation.observation.tokens.total,
                        unknownMetric("timed_out"),
                    )
                    return true
                })
            }
        })
    })

    it("times out one OpenAI provider call without aborting the caller turn", async () => {
        const caller = new AbortController()
        let providerSignal: AbortSignal | undefined
        const responder = createDialogueResponder({
            backend: "openai",
            cwd: process.cwd(),
            timeoutMs: 20,
            openaiRunRound: async (_context, _model, options) => {
                providerSignal = options.signal
                return await new Promise((_resolve, reject) => {
                    options.signal?.addEventListener(
                        "abort",
                        () => reject(options.signal?.reason),
                        { once: true },
                    )
                })
            },
        })

        await assert.rejects(
            responder(
                {
                    runId: "run-openai-call-timeout",
                    messageId: "message-openai-call-timeout",
                    systemPrompt: "system",
                    userPrompt: "status",
                },
                caller.signal,
            ),
            (error: unknown) => {
                assert.ok(error instanceof DialogueResponderInvocationError)
                assert.equal(error.invocation.observation.status, "timed_out")
                return true
            },
        )
        assert.equal(providerSignal?.aborted, true)
        assert.equal(caller.signal.aborted, false)
    })

    it("preserves provider-timeout versus explicit-cancel attribution through intake", async () => {
        const createIntake = (
            providerTimeoutMs: number,
            onStarted?: () => void,
        ) => {
            const dialogue = createDialogueResponder({
                backend: "openai",
                cwd: process.cwd(),
                timeoutMs: providerTimeoutMs,
                openaiRunRound: async (_context, _model, options) => {
                    onStarted?.()
                    return await new Promise((_resolve, reject) => {
                        options.signal?.addEventListener(
                            "abort",
                            () => reject(options.signal?.reason),
                            { once: true },
                        )
                    })
                },
            })
            return new ConversationIntake({
                sessionId: "session-dialogue-intake-timeout",
                timeoutMs: providerTimeoutMs + 1_000,
                responder: {
                    backend: "openai",
                    async respond(input, signal) {
                        const result = await dialogue({
                            runId: "frontdoor:dialogue-intake-timeout",
                            messageId: input.requestId,
                            billingRole: "conversation",
                            systemPrompt: input.systemPrompt,
                            userPrompt: input.userPrompt,
                        }, signal)
                        return result.text
                    },
                },
            })
        }

        const timedOut = createIntake(20)
        await assert.rejects(
            timedOut.submit({
                requestId: "request-provider-timeout",
                text: "status",
                intent: "chat",
            }),
            (error: unknown) => {
                assert.ok(error instanceof DialogueResponderInvocationError)
                assert.equal(error.invocation.observation.status, "timed_out")
                return true
            },
        )
        timedOut.close()

        let markStarted: (() => void) | undefined
        const started = new Promise<void>((resolve) => { markStarted = resolve })
        const cancelled = createIntake(10_000, () => markStarted?.())
        const pending = cancelled.submit({
            requestId: "request-explicit-cancel",
            text: "status",
            intent: "chat",
        })
        await started
        cancelled.close()
        await assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof DialogueResponderInvocationError)
            assert.equal(error.invocation.observation.status, "cancelled")
            return true
        })
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

    it("preserves the exact provider cause through invocation telemetry wrappers", async () => {
        const providerError = Object.assign(
            new Error("response failed because max_output_tokens was reached"),
            { code: "max_output_tokens" },
        )
        const responder = createDialogueResponder({
            backend: "openai",
            cwd: process.cwd(),
            openaiRunRound: async () => {
                throw providerError
            },
        })

        await assert.rejects(
            responder(
                {
                    runId: "run-provider-cause",
                    messageId: "message-provider-cause",
                    systemPrompt: "system",
                    userPrompt: "status",
                },
                new AbortController().signal,
            ),
            (error: unknown) => {
                assert.ok(error instanceof DialogueResponderInvocationError)
                assert.equal(error.cause, providerError)
                assert.equal(
                    (error.cause as { code?: unknown }).code,
                    "max_output_tokens",
                )
                return true
            },
        )
    })
})

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error("descendant never started")
        await delay(25)
    }
}
