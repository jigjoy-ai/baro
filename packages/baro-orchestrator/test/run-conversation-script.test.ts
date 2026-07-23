import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, it } from "node:test"

import { withTempDir } from "./participants/helpers.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const RUN_CONVERSATION = join(
    REPO_ROOT,
    "packages/baro-orchestrator/scripts/run-conversation.ts",
)
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx")

interface TurnInput {
    schemaVersion: 1
    sessionId: string
    requestId: string
    intent: "goal" | "clarification" | "chat"
    text: string
    history: Array<{
        requestId: string
        role: "user" | "assistant"
        text: string
    }>
}

interface ScriptResult {
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
}

describe("run-conversation isolated turn", () => {
    it("does not use ambient collective run identity for pre-PRD billing", () => {
        const source = readFileSync(RUN_CONVERSATION, "utf8")
        assert.doesNotMatch(source, /process\.env\.BARO_RUN_ID/u)
        assert.match(
            source,
            /trustedFrontDoorBillingRunId\(input\.sessionId\)/u,
        )
    })

    it("requires the per-provider deadline to be shorter than the whole turn", async () => {
        await withTempDir("baro-conversation-timeout-order-", async (dir) => {
            const input = turnInput({
                sessionId: "session-timeout-order",
                requestId: "request-timeout-order",
                text: "Keep timeout attribution deterministic.",
            })
            const binary = writeFakeClaude(
                dir,
                readyResponse(input.sessionId, input.requestId),
                join(dir, "unused-capture.json"),
            )
            const run = await runConversation(
                dir,
                input,
                ["--llm", "claude", "--claude-bin", binary],
                { provider: "20", turn: "20" },
            )

            assert.equal(run.code, 1)
            assert.match(
                run.stderr,
                /must fit two provider deadlines plus 30000ms cleanup/u,
            )
        })
    })

    it("routes autonomous RepoScout and Conversation through the selected backend", async () => {
        await withTempDir("baro-conversation-autonomous-scout-", async (dir) => {
            const input = turnInput({
                sessionId: "session-autonomous-wire",
                requestId: "request-autonomous-wire",
                text: "Inspect the durable conversation boundary.",
            })
            const capture = join(dir, "claude-autonomous-calls.json")
            const binary = writeAdaptiveFakeClaude(dir, capture)

            const run = await runConversation(dir, input, [
                "--llm",
                "claude",
                "--claude-bin",
                binary,
                "--model",
                "claude-autonomous-fixture",
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.equal((readResult(dir) as { kind: string }).kind, "ready")
            const sidecar = readRepositoryBriefSidecar(dir)
            assert.deepEqual(Object.keys(sidecar).sort(), [
                "repositoryBrief",
                "requestId",
                "schemaVersion",
                "sessionId",
            ])
            assert.equal(sidecar.schemaVersion, 1)
            assert.equal(sidecar.sessionId, input.sessionId)
            assert.equal(sidecar.requestId, input.requestId)
            assert.equal(
                sidecar.repositoryBrief.summary,
                "Autonomous scout inspected the deep cancellation coordinator.",
            )
            assert.equal(
                sidecar.repositoryBrief.relevantPaths[0],
                "src/runtime/cancellation/abort-coordinator.ts",
            )
            assert.ok(sidecar.repositoryBrief.relevantPaths.includes("README.md"))
            assert.ok(sidecar.repositoryBrief.relevantPaths.includes("package.json"))
            assert.equal(
                sidecar.repositoryBrief.facts[0]?.evidencePath,
                "src/runtime/cancellation/abort-coordinator.ts",
            )
            const calls = readJson<Array<{
                backend: string
                role: string
                correlation: string
                prompt: string
            }>>(capture)
            assert.equal(calls.length, 4)
            assert.deepEqual(calls.map((call) => call.backend), [
                "claude",
                "claude",
                "claude",
                "claude",
            ])
            assert.deepEqual(calls.map((call) => call.role), [
                "repository-scout",
                "repository-scout",
                "repository-scout",
                "conversation",
            ])
            for (const call of calls.slice(0, 3)) {
                assert.match(call.correlation, /^repository:[a-f0-9]{64}$/u)
                assert.equal(call.correlation, calls[0]!.correlation)
            }
            assert.equal(calls[3]!.correlation, input.requestId)
            assert.notEqual(calls[0]!.correlation, calls[3]!.correlation)
            assert.match(calls[0]!.prompt, /CURRENT STEP: 1/)
            assert.match(calls[0]!.prompt, /CURRENT ATTEMPT: 1/)
            assert.match(calls[1]!.prompt, /CURRENT STEP: 2/)
            assert.match(
                calls[1]!.prompt,
                /src\/runtime\/cancellation\/abort-coordinator\.ts/u,
            )
            assert.match(calls[2]!.prompt, /CURRENT STEP: 3/)
            assert.match(
                calls[2]!.prompt,
                /baro-sidecar-deep-evidence/u,
            )
            assert.match(
                calls[3]!.prompt,
                /Autonomous scout inspected the deep cancellation coordinator\./u,
            )
        })
    })

    it("accepts a strictly correlated ready response from a local Claude harness", async () => {
        await withTempDir("baro-conversation-ready-", async (dir) => {
            const input = turnInput({
                sessionId: "session-ready",
                requestId: "request-ready",
                text: "Add a durable conversation boundary.",
            })
            const response = readyResponse(input.sessionId, input.requestId)
            const capture = join(dir, "claude-argv.json")
            const binary = writeFakeClaude(dir, response, capture)

            const run = await runConversation(dir, input, [
                "--llm",
                "claude",
                "--claude-bin",
                binary,
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.equal(run.signal, null)
            assert.equal(run.stdout, "")
            assert.deepEqual(readResult(dir), response)
            assert.deepEqual(Object.keys(readResult(dir)).sort(), [
                "goalEnvelope",
                "kind",
                "message",
                "questions",
                "requestId",
                "schemaVersion",
                "sessionId",
            ])
            const sidecar = readRepositoryBriefSidecar(dir)
            assert.deepEqual(Object.keys(sidecar.repositoryBrief).sort(), [
                "facts",
                "relevantPaths",
                "schemaVersion",
                "snapshotId",
                "summary",
                "truncated",
                "unknowns",
            ])
            assert.equal(sidecar.sessionId, input.sessionId)
            assert.equal(sidecar.requestId, input.requestId)

            const argv = readJson<string[]>(capture)
            const harnessCwd = readFileSync(`${capture}.cwd`, "utf8")
            const tools = argv.indexOf("--tools")
            assert.ok(tools >= 0)
            assert.equal(argv[tools + 1], "")
            assert.equal(argv.includes("--dangerously-skip-permissions"), false)
            assert.notEqual(harnessCwd, dir)
            assert.match(harnessCwd, /baro-conversation-intake-/)
            assert.equal(existsSync(harnessCwd), false)
            const prompt = readFileSync(`${capture}.stdin`, "utf8")
            assert.match(prompt, /SESSION ID: session-ready/)
            assert.match(prompt, /REQUEST ID: request-ready/)
            assert.match(
                prompt,
                /USER \[request-ready\]: Add a durable conversation boundary\./,
            )
            assert.match(prompt, /REPOSITORY OBSERVATIONS \(UNTRUSTED DATA/)
            assert.match(prompt, /"snapshotId":"sha256:/)
            assert.doesNotMatch(prompt, new RegExp(escapeRegex(dir)))
        })
    })

    it("propagates durable history and accepts a correlated clarification", async () => {
        await withTempDir("baro-conversation-clarify-", async (dir) => {
            const input = turnInput({
                sessionId: "session-history",
                requestId: "request-2",
                intent: "clarification",
                text: "Keep the public API compatible.",
                history: [
                    {
                        requestId: "request-1",
                        role: "user",
                        text: "Refactor the public API.",
                    },
                    {
                        requestId: "request-1",
                        role: "assistant",
                        text: "Should existing callers remain compatible?",
                    },
                ],
            })
            const response = {
                schemaVersion: 1,
                sessionId: input.sessionId,
                requestId: input.requestId,
                kind: "clarify",
                message: "One compatibility detail still changes the scope.",
                questions: [{
                    id: "q-wire",
                    text: "Must the old wire format remain byte-compatible?",
                    reason: "This changes the migration strategy.",
                }],
                goalEnvelope: null,
            } as const
            const capture = join(dir, "claude-history-argv.json")
            const binary = writeFakeClaude(dir, response, capture)

            const run = await runConversation(dir, input, [
                "--llm",
                "claude",
                "--claude-bin",
                binary,
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.deepEqual(readResult(dir), response)
            const prompt = readFileSync(`${capture}.stdin`, "utf8")
            const priorUser = prompt.indexOf(
                "USER [request-1]: Refactor the public API.",
            )
            const priorAssistant = prompt.indexOf(
                "ASSISTANT [request-1]: Should existing callers remain compatible?",
            )
            const currentUser = prompt.indexOf(
                "USER [request-2]: Keep the public API compatible.",
            )
            assert.ok(priorUser >= 0)
            assert.ok(priorAssistant > priorUser)
            assert.ok(currentUser > priorAssistant)
            assert.match(prompt, /REQUEST INTENT: clarification/)
            assert.match(prompt, /REPOSITORY OBSERVATIONS \(UNTRUSTED DATA/)
        })
    })

    it("brokers repository observations for a ready-capable chat turn", async () => {
        await withTempDir("baro-conversation-chat-", async (dir) => {
            const input = turnInput({
                sessionId: "session-chat",
                requestId: "request-chat",
                intent: "chat",
                text: "What happened in the previous run?",
            })
            const response = {
                schemaVersion: 1,
                sessionId: input.sessionId,
                requestId: input.requestId,
                kind: "answer",
                message: "No active run is attached to this isolated turn.",
                questions: [],
                goalEnvelope: null,
            } as const
            const capture = join(dir, "claude-chat-argv.json")
            const binary = writeFakeClaude(dir, response, capture)

            const run = await runConversation(dir, input, [
                "--llm",
                "claude",
                "--claude-bin",
                binary,
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.deepEqual(readResult(dir), response)
            const prompt = readFileSync(`${capture}.stdin`, "utf8")
            assert.match(prompt, /REQUEST INTENT: chat/)
            assert.match(prompt, /REPOSITORY OBSERVATIONS/)
        })
    })

    it("fails closed on malformed and mismatched provider responses", async () => {
        const cases = [
            {
                // Framing is unwrapped; the empty object then fails the
                // exact schema, not the JSON parse.
                name: "malformed",
                raw: "```json\n{}\n```",
                error: /conversation response must use the exact v1 schema/,
            },
            {
                name: "no-json-at-all",
                raw: "I refuse to answer with JSON.",
                error: /conversation response is not valid JSON/,
            },
            {
                name: "mismatched-session",
                raw: JSON.stringify(readyResponse(
                    "foreign-session",
                    "request-mismatched-session",
                )),
                error: /conversation sessionId correlation mismatch/,
            },
            {
                name: "mismatched-request",
                raw: JSON.stringify(readyResponse(
                    "session-expected",
                    "foreign-request",
                )),
                error: /conversation requestId correlation mismatch/,
            },
        ]

        for (const fixture of cases) {
            await withTempDir(`baro-conversation-${fixture.name}-`, async (dir) => {
                const input = turnInput({
                    sessionId: "session-expected",
                    requestId: `request-${fixture.name}`,
                    text: "Do not accept an untrusted response.",
                })
                const binary = writeFakeClaudeRaw(dir, fixture.raw)

                const run = await runConversation(dir, input, [
                    "--llm",
                    "claude",
                    "--claude-bin",
                    binary,
                ])

                assert.equal(run.code, 1)
                assert.equal(run.signal, null)
                assert.match(run.stderr, fixture.error)
                assert.equal(
                    existsSync(join(dir, "result.json")),
                    false,
                    "a rejected provider response must not create a result",
                )
                assert.equal(
                    existsSync(join(dir, "repository-brief.json")),
                    false,
                    "a rejected provider response must not create a repository brief sidecar",
                )
            })
        }
    })

    it("invokes Codex with an isolated minimal-filesystem profile", async () => {
        await withTempDir("baro-conversation-codex-", async (dir) => {
            const input = turnInput({
                sessionId: "session-codex",
                requestId: "request-codex",
                text: "Confirm this goal is ready.",
            })
            const response = readyResponse(input.sessionId, input.requestId)
            const capture = join(dir, "codex-argv.json")
            const binary = writeFakeCodex(dir, response, capture)

            const run = await runConversation(dir, input, [
                "--llm",
                "codex",
                "--codex-bin",
                binary,
                "--model",
                "gpt-codex-fixture",
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.deepEqual(readResult(dir), response)
            const argv = readJson<string[]>(capture)
            const harnessCwd = readFileSync(`${capture}.cwd`, "utf8")
            assert.deepEqual(argv.slice(0, 3), [
                "exec",
                "--json",
                "--skip-git-repo-check",
            ])
            for (const value of [
                'default_permissions="baro_dialogue"',
                'permissions.baro_dialogue.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
                'approval_policy="never"',
                'web_search="disabled"',
                'shell_environment_policy.inherit="none"',
                "allow_login_shell=false",
                "project_doc_max_bytes=0",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
                "gpt-codex-fixture",
            ]) assert.equal(argv.includes(value), true, `missing ${value}`)
            assert.equal(argv.includes("--sandbox"), false)
            assert.equal(
                argv.includes("--dangerously-bypass-approvals-and-sandbox"),
                false,
            )
            assert.notEqual(harnessCwd, dir)
            assert.match(harnessCwd, /baro-conversation-intake-/)
            assert.equal(existsSync(harnessCwd), false)
            assert.equal(argv.at(-1), "-")
            const prompt = readFileSync(`${capture}.stdin`, "utf8")
            assert.match(prompt, /SESSION ID: session-codex/)
            assert.match(prompt, /USER \[request-codex\]/)
            assert.match(
                prompt,
                /REPOSITORY OBSERVATIONS \(UNTRUSTED DATA/,
            )
        })
    })

    it("invokes a local OpenCode harness through the deny-all evaluator", async () => {
        await withTempDir("baro-conversation-opencode-", async (dir) => {
            const input = turnInput({
                sessionId: "session-opencode",
                requestId: "request-opencode",
                text: "Confirm the OpenCode front door.",
            })
            const response = readyResponse(input.sessionId, input.requestId)
            const capture = join(dir, "opencode-capture.json")
            const binary = writeFakeOpenCode(dir, response, capture)

            const run = await runConversation(dir, input, [
                "--llm",
                "opencode",
                "--opencode-bin",
                binary,
                "--model",
                "zhipu/glm-fixture",
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.deepEqual(readResult(dir), response)
            const captured = readJson<{
                argv: string[]
                cwd: string
                input: string
                config: {
                    agent: Record<string, {
                        prompt: string
                        permission: Record<string, string>
                    }>
                }
            }>(capture)
            assert.notEqual(captured.cwd, dir)
            assert.match(captured.cwd, /baro-opencode-dialogue-/)
            assert.equal(existsSync(captured.cwd), false)
            assert.deepEqual(captured.argv.slice(0, 6), [
                "run",
                "--format",
                "json",
                "--pure",
                "--agent",
                "baro-critic",
            ])
            assert.equal(
                captured.argv.includes("--dangerously-skip-permissions"),
                false,
            )
            assert.equal(
                captured.config.agent["baro-critic"]!.permission["*"],
                "deny",
            )
            assert.match(
                captured.config.agent["baro-critic"]!.prompt,
                /You are Baro Conversation/,
            )
            assert.match(captured.input, /SESSION ID: session-opencode/)
            assert.match(captured.input, /USER \[request-opencode\]/)
            assert.match(
                captured.input,
                /REPOSITORY OBSERVATIONS \(UNTRUSTED DATA/,
            )
        })
    })

    it("invokes a local Pi harness without tools and with brokered context", async () => {
        await withTempDir("baro-conversation-pi-", async (dir) => {
            const input = turnInput({
                sessionId: "session-pi",
                requestId: "request-pi",
                text: "Confirm the Pi front door.",
            })
            const response = readyResponse(input.sessionId, input.requestId)
            const capture = join(dir, "pi-capture.json")
            const binary = writeFakePi(dir, response, capture)

            const run = await runConversation(dir, input, [
                "--llm",
                "pi",
                "--pi-bin",
                binary,
                "--model",
                "deepseek-fixture",
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.deepEqual(readResult(dir), response)
            const captured = readJson<{
                argv: string[]
                cwd: string
                input: string
            }>(capture)
            assert.notEqual(captured.cwd, dir)
            assert.match(captured.cwd, /baro-pi-dialogue-/)
            assert.equal(existsSync(captured.cwd), false)
            assert.equal(captured.argv.includes("--no-tools"), true)
            assert.equal(captured.argv.includes("--no-extensions"), true)
            assert.equal(captured.argv.includes("--no-context-files"), true)
            assert.match(
                valueAfter(captured.argv, "--system-prompt"),
                /You are Baro Conversation/,
            )
            assert.match(captured.input, /SESSION ID: session-pi/)
            assert.match(captured.input, /USER \[request-pi\]/)
            assert.match(
                captured.input,
                /REPOSITORY OBSERVATIONS \(UNTRUSTED DATA/,
            )
        })
    })
})

function turnInput(
    overrides: Partial<TurnInput> & Pick<TurnInput, "sessionId" | "requestId" | "text">,
): TurnInput {
    return {
        schemaVersion: 1,
        intent: "goal",
        history: [],
        ...overrides,
    }
}

function readyResponse(sessionId: string, requestId: string) {
    return {
        schemaVersion: 1,
        sessionId,
        requestId,
        kind: "ready",
        message: "The goal is clear and ready for planning.",
        questions: [],
        goalEnvelope: {
            objective: "Implement the requested durable conversation boundary.",
            constraints: ["Preserve downstream planning authority."],
            acceptanceCriteria: ["Strictly correlated responses are accepted."],
            nonGoals: [],
            assumptions: [],
        },
    } as const
}

async function runConversation(
    dir: string,
    input: TurnInput,
    providerArgs: readonly string[],
    timeouts: Readonly<{ provider: string; turn: string }> = {
        provider: "30000",
        turn: "120000",
    },
): Promise<ScriptResult> {
    const inputFile = join(dir, "input.json")
    const resultFile = join(dir, "result.json")
    const repositoryBriefFile = join(dir, "repository-brief.json")
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    mkdirSync(join(project, "src/runtime/cancellation"), { recursive: true })
    writeFileSync(
        join(project, "README.md"),
        "Conversation boundary and durable repository planning fixture.\n",
    )
    writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "conversation-fixture", private: true }),
    )
    writeFileSync(
        join(project, "src/runtime/cancellation/abort-coordinator.ts"),
        'export const abortCoordinatorSentinel = "baro-sidecar-deep-evidence"\n',
    )
    writeFileSync(inputFile, JSON.stringify(input))
    return await runProcess(TSX, [
        RUN_CONVERSATION,
        "--input-file",
        inputFile,
        "--result-file",
        resultFile,
        "--repository-brief-file",
        repositoryBriefFile,
        "--cwd",
        project,
        "--timeout-ms",
        timeouts.provider,
        "--turn-timeout-ms",
        timeouts.turn,
        ...providerArgs,
    ])
}

function runProcess(command: string, args: readonly string[]): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
            cwd: REPO_ROOT,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => { stdout += chunk })
        child.stderr.on("data", (chunk: string) => { stderr += chunk })
        child.once("error", reject)
        child.once("close", (code, signal) => {
            resolve({ code, signal, stdout, stderr })
        })
    })
}

function writeFakeClaude(dir: string, response: unknown, capture: string): string {
    return writeFakeClaudeRaw(dir, JSON.stringify(response), capture)
}

function writeAdaptiveFakeClaude(dir: string, capture: string): string {
    const binary = join(dir, "fake-adaptive-claude.mjs")
    writeFileSync(binary, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const after = (flag) => argv[argv.indexOf(flag) + 1] ?? "";
const system = after("--system-prompt");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const field = (label) => {
    const match = new RegExp("^" + label + ": (.+)$", "m").exec(prompt);
    if (!match) throw new Error("missing " + label);
    return match[1];
};
const scout = system.includes("You are Baro RepoScout");
const previous = existsSync(${JSON.stringify(capture)})
    ? JSON.parse(readFileSync(${JSON.stringify(capture)}, "utf8"))
    : [];
let response;
let record;
if (scout) {
    const base = {
        schemaVersion: 1,
        sessionId: field("SESSION ID"),
        requestId: field("REQUEST ID"),
        contextRequestId: field("CONTEXT REQUEST ID"),
        step: Number(field("CURRENT STEP")),
    };
    const scoutCalls = previous.filter((call) => call.role === "repository-scout").length;
    if (scoutCalls === 0) {
        response = {
            ...base,
            action: "glob",
            pattern: "src/runtime/cancellation/abort-coordinator.ts",
        };
    } else if (scoutCalls === 1) {
        response = {
            ...base,
            action: "read",
            path: "src/runtime/cancellation/abort-coordinator.ts",
        };
    } else {
        response = {
            ...base,
            action: "finish",
            summary: "Autonomous scout inspected the deep cancellation coordinator.",
            facts: [{
                statement: "The coordinator contains the baro-sidecar-deep-evidence sentinel.",
                evidencePath: "src/runtime/cancellation/abort-coordinator.ts",
                line: 1,
                confidence: "high",
            }],
            relevantPaths: ["src/runtime/cancellation/abort-coordinator.ts"],
            unknowns: [],
            truncated: false,
        };
    }
    record = {
        backend: "claude",
        role: "repository-scout",
        correlation: response.contextRequestId,
        prompt,
    };
} else {
    response = {
        schemaVersion: 1,
        sessionId: field("SESSION ID"),
        requestId: field("REQUEST ID"),
        kind: "ready",
        message: "Autonomous evidence made the goal ready for planning.",
        questions: [],
        goalEnvelope: {
            objective: "Implement the durable conversation boundary.",
            constraints: [],
            acceptanceCriteria: ["The boundary remains strictly correlated."],
            nonGoals: [],
            assumptions: [],
        },
    };
    record = {
        backend: "claude",
        role: "conversation",
        correlation: response.requestId,
        prompt,
    };
}
previous.push(record);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(previous));
process.stdout.write(JSON.stringify({
    result: JSON.stringify(response),
    duration_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
}));
`)
    chmodSync(binary, 0o755)
    return binary
}

function writeFakeClaudeRaw(dir: string, raw: string, capture?: string): string {
    const binary = join(dir, "fake-claude.mjs")
    writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
${capture ? `writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));` : ""}
${capture ? `writeFileSync(${JSON.stringify(`${capture}.cwd`)}, process.cwd());` : ""}
${capture ? `writeFileSync(${JSON.stringify(`${capture}.stdin`)}, input);` : ""}
process.stdout.write(JSON.stringify({
    result: ${JSON.stringify(raw)},
    duration_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
}));
`)
    chmodSync(binary, 0o755)
    return binary
}

function writeFakeCodex(dir: string, response: unknown, capture: string): string {
    const binary = join(dir, "fake-codex.mjs")
    writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(`${capture}.cwd`)}, process.cwd());
writeFileSync(${JSON.stringify(`${capture}.stdin`)}, input);
console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: ${JSON.stringify(JSON.stringify(response))} },
}));
console.log(JSON.stringify({
    type: "turn.completed",
    model: "gpt-codex-fixture",
    usage: { input_tokens: 1, output_tokens: 1 },
}));
`)
    chmodSync(binary, 0o755)
    return binary
}

function writeFakeOpenCode(
    dir: string,
    response: unknown,
    capture: string,
): string {
    const binary = join(dir, "fake-opencode.mjs")
    writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        input,
        config: JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, "utf8")),
    }));
    console.log(JSON.stringify({
        type: "text",
        part: { text: ${JSON.stringify(JSON.stringify(response))} },
    }));
    console.log(JSON.stringify({
        type: "step_finish",
        part: {
            providerID: "zhipu",
            modelID: "glm-fixture",
            tokens: { total: 2, input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
        },
    }));
});
`)
    chmodSync(binary, 0o755)
    return binary
}

function writeFakePi(
    dir: string,
    response: unknown,
    capture: string,
): string {
    const binary = join(dir, "fake-pi.mjs")
    writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        input,
    }));
    console.log(JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            provider: "deepseek",
            model: "deepseek-fixture",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            content: [{ type: "text", text: ${JSON.stringify(JSON.stringify(response))} }],
        },
    }));
});
`)
    chmodSync(binary, 0o755)
    return binary
}

function readResult(dir: string): unknown {
    return readJson(join(dir, "result.json"))
}

function readRepositoryBriefSidecar(dir: string): {
    schemaVersion: number
    sessionId: string
    requestId: string
    repositoryBrief: {
        schemaVersion: number
        snapshotId: string
        summary: string
        facts: Array<{ evidencePath: string }>
        relevantPaths: string[]
        unknowns: string[]
        truncated: boolean
    }
} {
    return readJson(join(dir, "repository-brief.json"))
}

function readJson<T = unknown>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T
}

function valueAfter(argv: readonly string[], flag: string): string {
    const index = argv.indexOf(flag)
    assert.ok(index >= 0, `missing ${flag}`)
    const value = argv[index + 1]
    assert.notEqual(value, undefined, `missing value after ${flag}`)
    return value!
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}
