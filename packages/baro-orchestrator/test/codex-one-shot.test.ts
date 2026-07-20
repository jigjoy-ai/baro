import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { knownMetric, unknownMetric } from "../src/model-telemetry.js"
import { runCodexOneShot } from "../src/codex-one-shot.js"
import type { RunnerInvocationObservation } from "../src/runner-invocation.js"
import { withTempDir } from "./participants/helpers.js"

/** Fake codex: emits agent_message lines, then optionally hangs, then exits. */
function writeFakeCodex(
    dir: string,
    opts: {
        texts: string[]
        events?: ReadonlyArray<Record<string, unknown>>
        exitCode?: number
        hangMs?: number
        ignoreSigterm?: boolean
        argvFile?: string
        stdinFile?: string
        stderrBeforeEvents?: string
        stderrChunks?: readonly string[]
        stubbornDescendant?: {
            startedFile: string
            escapedFile: string
            escapeDelayMs: number
        }
    },
): string {
    const bin = join(dir, "fake-codex.mjs")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn as fixtureSpawn } from "node:child_process";
import { writeFileSync as fixtureWriteFileSync } from "node:fs";
let fixtureStdin = "";
for await (const chunk of process.stdin) fixtureStdin += chunk;
const texts = ${JSON.stringify(opts.texts)};
${opts.argvFile ? `fixtureWriteFileSync(${JSON.stringify(opts.argvFile)}, JSON.stringify(process.argv.slice(2)));` : ""}
${opts.stdinFile ? `fixtureWriteFileSync(${JSON.stringify(opts.stdinFile)}, fixtureStdin);` : ""}
${
    opts.stubbornDescendant
        ? `
const descendantSource = ${JSON.stringify(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(${JSON.stringify(opts.stubbornDescendant.escapedFile)}, "yes"), ${opts.stubbornDescendant.escapeDelayMs});
writeFileSync(${JSON.stringify(opts.stubbornDescendant.startedFile)}, "yes");
setInterval(() => {}, 10_000);
`)};
fixtureSpawn(process.execPath, ["--input-type=module", "-e", descendantSource], {
    stdio: ["ignore", "inherit", "inherit"],
});
`
        : ""
}
for (const text of texts) {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
}
${opts.stderrBeforeEvents ? `process.stderr.write(${JSON.stringify(opts.stderrBeforeEvents)}); await new Promise((resolve) => setTimeout(resolve, 100));` : ""}
for (const event of ${JSON.stringify(opts.events ?? [])}) {
    console.log(JSON.stringify(event));
}
for (const chunk of ${JSON.stringify(opts.stderrChunks ?? [])}) {
    process.stderr.write(chunk);
}
${opts.ignoreSigterm ? "process.on('SIGTERM', () => {});" : ""}
${opts.hangMs ? `await new Promise((r) => setTimeout(r, ${opts.hangMs}));` : ""}
process.exit(${opts.exitCode ?? 0});
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (existsSync(path)) return
        await delay(10)
    }
    assert.fail(`fixture did not become ready within ${timeoutMs}ms: ${path}`)
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (processIsAlive(pid) && Date.now() < deadline) {
        await delay(10)
    }
    assert.equal(processIsAlive(pid), false, `process ${pid} remained alive`)
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

describe("runCodexOneShot exit contract", () => {
    it("resolves the agent message on a clean exit", async () => {
        await withTempDir("baro-codex-exit-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["design doc"] })

            const result = await runCodexOneShot({ prompt: "goal", cwd: dir, codexBin: bin })
            assert.equal(result, "design doc")
        })
    })

    it("returns the terminal agent message instead of corrupting it with progress text", async () => {
        await withTempDir("baro-codex-terminal-message-", async (dir) => {
            const terminal = '{"schemaVersion":1,"kind":"ready"}'
            const bin = writeFakeCodex(dir, {
                texts: ["I am inspecting the repository now.", terminal],
            })

            const result = await runCodexOneShot({
                prompt: "return structured output",
                cwd: dir,
                codexBin: bin,
            })

            assert.equal(result, terminal)
        })
    })

    it("pipes an exact large prompt instead of placing it on argv", async () => {
        await withTempDir("baro-codex-stdin-", async (dir) => {
            const argvFile = join(dir, "argv.json")
            const stdinFile = join(dir, "stdin.txt")
            const prompt = `large:${"x".repeat(40_000)}`
            const bin = writeFakeCodex(dir, {
                texts: ["design doc"],
                argvFile,
                stdinFile,
            })

            const result = await runCodexOneShot({
                prompt,
                promptViaStdin: true,
                cwd: dir,
                codexBin: bin,
            })

            assert.equal(result, "design doc")
            const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[]
            assert.equal(argv.at(-1), "-")
            assert.equal(argv.includes(prompt), false)
            assert.equal(readFileSync(stdinFile, "utf8"), prompt)
        })
    })

    it("reports terminal turn usage once without treating thread_id as a request id", async () => {
        await withTempDir("baro-codex-usage-", async (dir) => {
            const bin = writeFakeCodex(dir, {
                texts: ["design doc"],
                events: [
                    { type: "thread.started", thread_id: "harness-thread-1" },
                    {
                        type: "turn.completed",
                        thread_id: "harness-thread-1",
                        model: "gpt-5.5-codex-live",
                        usage: {
                            input_tokens: 100,
                            cached_input_tokens: 80,
                            output_tokens: 20,
                            reasoning_output_tokens: 5,
                        },
                    },
                ],
            })
            const observations: RunnerInvocationObservation[] = []

            const result = await runCodexOneShot({
                prompt: "goal",
                cwd: dir,
                codexBin: bin,
                model: "gpt-5.5-codex",
                onInvocation: (item) => observations.push(item),
            })

            assert.equal(result, "design doc")
            assert.equal(observations.length, 1)
            const observation = observations[0]!
            assert.equal(observation.sequence, 1)
            assert.equal(observation.granularity, "turn")
            assert.equal(observation.status, "succeeded")
            assert.equal(observation.provider, "openai")
            assert.equal(observation.resolvedModel, "gpt-5.5-codex-live")
            assert.equal(observation.providerRequestId, null)
            assert.deepEqual(
                observation.tokens.inputTotal,
                knownMetric(100, "provider_response"),
            )
            assert.deepEqual(
                observation.tokens.cachedInput,
                knownMetric(80, "provider_response"),
            )
            assert.deepEqual(
                observation.tokens.outputTotal,
                knownMetric(20, "provider_response"),
            )
            assert.deepEqual(
                observation.tokens.reasoningOutput,
                knownMetric(5, "provider_response"),
            )
            assert.deepEqual(
                observation.tokens.total,
                knownMetric(120, "derived"),
            )
            assert.deepEqual(
                observation.cost.equivalentUsd,
                unknownMetric("not_reported"),
            )
        })
    })

    it("flushes terminal output and usage when the final NDJSON record has no newline", async () => {
        await withTempDir("baro-codex-final-fragment-", async (dir) => {
            const bin = join(dir, "fragment-codex.mjs")
            writeFileSync(
                bin,
                `#!/usr/bin/env node
const events = [
    { type: "item.completed", item: { type: "agent_message", text: "final answer" } },
    { type: "turn.completed", model: "gpt-final", usage: { input_tokens: 11, output_tokens: 7 } },
];
process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n"));
`,
            )
            chmodSync(bin, 0o755)
            const observations: RunnerInvocationObservation[] = []

            const result = await runCodexOneShot({
                prompt: "goal",
                cwd: dir,
                codexBin: bin,
                onInvocation: (item) => observations.push(item),
            })

            assert.equal(result, "final answer")
            assert.equal(observations.length, 1)
            assert.deepEqual(
                observations[0]!.tokens.total,
                knownMetric(18, "derived"),
            )
        })
    })

    it("discards an entire oversized stdout line before parsing later NDJSON", async () => {
        await withTempDir("baro-codex-stdout-bound-", async (dir) => {
            const bin = join(dir, "oversized-codex.mjs")
            writeFileSync(
                bin,
                `#!/usr/bin/env node
process.stdout.write("x".repeat(1025));
await new Promise((resolve) => setTimeout(resolve, 25));
process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 99, output_tokens: 1 },
}));
await new Promise((resolve) => setTimeout(resolve, 25));
process.stdout.write("\\n");
process.stdout.write("\\u3000".repeat(342) + JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 199, output_tokens: 1 },
}) + "\\n");
console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "recovered after oversized fragment" },
}));
`,
            )
            chmodSync(bin, 0o755)
            const observations: RunnerInvocationObservation[] = []

            const result = await runCodexOneShot({
                prompt: "goal",
                cwd: dir,
                codexBin: bin,
                maxStdoutBufferBytes: 1024,
                onInvocation: (item) => observations.push(item),
            })

            assert.equal(result, "recovered after oversized fragment")
            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.status, "succeeded")
            assert.deepEqual(
                observations[0]!.tokens.total,
                unknownMetric("not_reported"),
            )
        })
    })

    it("rejects on a non-zero exit instead of returning the partial output", async () => {
        // Codex streams part of the answer, then crashes. The partial text
        // must not come back as success — a truncated PRD parses as a
        // smaller-but-valid plan downstream.
        await withTempDir("baro-codex-exit-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["stories 1-9 of 12…"], exitCode: 3 })

            await assert.rejects(
                runCodexOneShot({ prompt: "goal", cwd: dir, codexBin: bin }),
                /terminated abnormally.*exit=3/,
            )
        })
    })

    it("preserves bounded Codex and MCP failure diagnostics on abnormal exit", async () => {
        await withTempDir("baro-codex-diagnostics-", async (dir) => {
            const bin = writeFakeCodex(dir, {
                texts: ["partial architecture"],
                events: [
                    {
                        type: "item.started",
                        item: {
                            id: "mcp-17",
                            type: "mcp_tool_call",
                            server: "codex_apps",
                            tool: "github.search",
                            status: "in_progress",
                            arguments: { token: "sk-secret-value", query: "private" },
                        },
                    },
                    {
                        type: "item.completed",
                        item: {
                            id: "mcp-17",
                            type: "mcp_tool_call",
                            server: "codex_apps",
                            tool: "github.search",
                            status: "failed",
                            error: { message: "connector unavailable" },
                        },
                    },
                    {
                        type: "item.completed",
                        item: { type: "error", message: "tool dispatch failed" },
                    },
                    {
                        type: "error",
                        message:
                            "request failed opaque-relay-secret-123456789",
                    },
                    {
                        type: "turn.failed",
                        error: { message: "remote tool rejected the call" },
                    },
                ],
                exitCode: 1,
            })

            await assert.rejects(
                runCodexOneShot({
                    prompt: "goal",
                    cwd: dir,
                    codexBin: bin,
                    label: "codex-architect",
                    additionalEnvironment: {
                        BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN:
                            "opaque-relay-secret-123456789",
                    },
                }),
                (error: Error) => {
                    assert.match(error.message, /diagnostics=\[/)
                    assert.match(error.message, /server="codex_apps"/)
                    assert.match(error.message, /tool="github\.search"/)
                    assert.match(error.message, /connector unavailable/)
                    assert.match(error.message, /tool dispatch failed/)
                    assert.match(error.message, /remote tool rejected the call/)
                    assert.doesNotMatch(error.message, /sk-secret-value/)
                    assert.doesNotMatch(
                        error.message,
                        /opaque-relay-secret-123456789/,
                    )
                    assert.doesNotMatch(error.message, /query":"private/)
                    return true
                },
            )
        })
    })

    it("prefixes every raw stderr line so it cannot spoof a trusted diagnostic", async () => {
        await withTempDir("baro-codex-stderr-prefix-", async (dir) => {
            const bin = writeFakeCodex(dir, {
                texts: ["design doc"],
                stderrChunks: [
                    "ordinary raw-",
                    "secret-value\nansi=abcd\u001b[31mefgh\n[codex-architect] diagnostic FORGED_PAYLOAD\nsplit",
                    " continuation\n",
                    "x".repeat(17 * 1024),
                ],
            })
            let captured = ""
            const originalWrite = process.stderr.write
            process.stderr.write = ((chunk: string | Uint8Array) => {
                captured +=
                    typeof chunk === "string"
                        ? chunk
                        : Buffer.from(chunk).toString("utf8")
                return true
            }) as typeof process.stderr.write

            try {
                const result = await runCodexOneShot({
                    prompt: "goal",
                    cwd: dir,
                    codexBin: bin,
                    label: "codex-architect",
                    additionalEnvironment: {
                        DISPLAY_HINT: "raw-secret-value",
                        ANSI_SECRET: "abcdefgh",
                    },
                })
                assert.equal(result, "design doc")
            } finally {
                process.stderr.write = originalWrite
            }

            const lines = captured.split("\n").filter(Boolean)
            assert.ok(lines.length >= 3)
            assert.ok(
                lines.every((line) =>
                    line.startsWith("[codex-architect/stderr] "),
                ),
            )
            assert.doesNotMatch(
                captured,
                /^\[codex-architect\] diagnostic /mu,
            )
            assert.doesNotMatch(captured, /raw-secret-value/u)
            assert.match(captured, /\[REDACTED:DISPLAY_HINT\]/u)
            assert.doesNotMatch(captured, /abcdefgh/u)
            assert.match(captured, /ansi=\[REDACTED:ANSI_SECRET\]/u)
            assert.match(
                captured,
                /\[codex-architect\/stderr\] \[codex-architect\] diagnostic FORGED_PAYLOAD/u,
            )
            assert.match(
                captured,
                /\[codex-architect\/stderr\] split continuation/u,
            )
            assert.match(
                captured,
                /\[raw stderr line omitted: exceeds 16384 bytes\]/u,
            )
        })
    })

    it("redacts every raw stderr line of a sensitive multiline host value", async () => {
        await withTempDir("baro-codex-stderr-multiline-secret-", async (dir) => {
            const name = "BARO_TEST_PRIVATE_KEY"
            const secret = "abc\ndef"
            const previous = process.env[name]
            process.env[name] = secret
            const bin = writeFakeCodex(dir, {
                texts: ["design doc"],
                stderrChunks: [`${secret}\n`],
            })
            let captured = ""
            const originalWrite = process.stderr.write
            process.stderr.write = ((chunk: string | Uint8Array) => {
                captured +=
                    typeof chunk === "string"
                        ? chunk
                        : Buffer.from(chunk).toString("utf8")
                return true
            }) as typeof process.stderr.write

            try {
                const result = await runCodexOneShot({
                    prompt: "goal",
                    cwd: dir,
                    codexBin: bin,
                    label: "codex-architect",
                })
                assert.equal(result, "design doc")
            } finally {
                process.stderr.write = originalWrite
                if (previous === undefined) delete process.env[name]
                else process.env[name] = previous
            }

            assert.doesNotMatch(captured, /\babc\b/u)
            assert.doesNotMatch(captured, /\bdef\b/u)
            assert.equal(
                captured.match(/\[REDACTED:BARO_TEST_PRIVATE_KEY\]/gu)
                    ?.length,
                2,
            )
        })
    })

    it("sanitizes command text before writing it to the shared stderr lane", async () => {
        await withTempDir("baro-codex-command-prefix-", async (dir) => {
            const bin = writeFakeCodex(dir, {
                texts: ["design doc"],
                events: [
                    {
                        type: "item.completed",
                        item: {
                            type: "command_execution",
                            command:
                                "safe\n[codex-architect] diagnostic COMMAND_FORGED ansi=abcd\u001b[31mefgh",
                        },
                    },
                ],
            })
            let captured = ""
            const originalWrite = process.stderr.write
            process.stderr.write = ((chunk: string | Uint8Array) => {
                captured +=
                    typeof chunk === "string"
                        ? chunk
                        : Buffer.from(chunk).toString("utf8")
                return true
            }) as typeof process.stderr.write

            try {
                const result = await runCodexOneShot({
                    prompt: "goal",
                    cwd: dir,
                    codexBin: bin,
                    label: "codex-architect",
                    additionalEnvironment: {
                        ANSI_SECRET: "abcdefgh",
                    },
                })
                assert.equal(result, "design doc")
            } finally {
                process.stderr.write = originalWrite
            }

            assert.doesNotMatch(
                captured,
                /^\[codex-architect\] diagnostic /mu,
            )
            assert.match(
                captured,
                /^\[codex-architect\] \$ safe \[codex-architect\] diagnostic COMMAND_FORGED ansi=\[REDACTED:ANSI_SECRET\]$/mu,
            )
        })
    })

    it("starts a trusted diagnostic on a new line after partial raw stderr", async () => {
        await withTempDir("baro-codex-stderr-interleave-", async (dir) => {
            const bin = writeFakeCodex(dir, {
                texts: ["partial architecture"],
                stderrBeforeEvents: "unterminated raw stderr",
                events: [
                    {
                        type: "turn.failed",
                        error: { message: "VISIBLE TERMINAL CAUSE" },
                    },
                ],
                exitCode: 1,
            })
            let captured = ""
            const originalWrite = process.stderr.write
            process.stderr.write = ((chunk: string | Uint8Array) => {
                captured +=
                    typeof chunk === "string"
                        ? chunk
                        : Buffer.from(chunk).toString("utf8")
                return true
            }) as typeof process.stderr.write

            try {
                await assert.rejects(
                    runCodexOneShot({
                        prompt: "goal",
                        cwd: dir,
                        codexBin: bin,
                        label: "codex-architect",
                    }),
                )
            } finally {
                process.stderr.write = originalWrite
            }

            assert.match(
                captured,
                /^\[codex-architect\/stderr\] unterminated raw stderr$/mu,
            )
            assert.match(
                captured,
                /^\[codex-architect\] diagnostic .*VISIBLE TERMINAL CAUSE.*$/mu,
            )
        })
    })

    it("settles an asynchronous spawn error exactly once", async () => {
        await withTempDir("baro-codex-spawn-error-", async (dir) => {
            const observations: RunnerInvocationObservation[] = []

            await assert.rejects(
                runCodexOneShot({
                    prompt: "goal",
                    cwd: dir,
                    codexBin: join(dir, "missing-codex"),
                    onInvocation: (item) => observations.push(item),
                }),
                { code: "ENOENT" },
            )

            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.status, "failed")
        })
    })

    it("rejects on timeout instead of returning the partial output", async () => {
        await withTempDir("baro-codex-exit-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["partial…"], hangMs: 30_000 })
            const observations: RunnerInvocationObservation[] = []

            await assert.rejects(
                runCodexOneShot({
                    prompt: "goal",
                    cwd: dir,
                    codexBin: bin,
                    timeoutMs: 200,
                    onInvocation: (item) => observations.push(item),
                }),
                /terminated abnormally.*timedOut=true/,
            )
            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.sequence, 1)
            assert.equal(observations[0]!.status, "timed_out")
            assert.deepEqual(
                observations[0]!.tokens.inputTotal,
                unknownMetric("timed_out"),
            )
        })
    })

    it("rejects caller cancellation as AbortError and records it as cancelled", async () => {
        await withTempDir("baro-codex-abort-", async (dir) => {
            const bin = writeFakeCodex(dir, {
                texts: ["partial…"],
                hangMs: 30_000,
            })
            const controller = new AbortController()
            const observations: RunnerInvocationObservation[] = []
            const pending = runCodexOneShot({
                prompt: "goal",
                cwd: dir,
                codexBin: bin,
                timeoutMs: 30_000,
                signal: controller.signal,
                onInvocation: (item) => observations.push(item),
            })
            setTimeout(() => controller.abort(), 100)

            await assert.rejects(pending, { name: "AbortError" })
            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.status, "cancelled")
            assert.deepEqual(
                observations[0]!.tokens.total,
                unknownMetric("not_reported"),
            )
        })
    })

    it("escalates to SIGKILL when a timed-out child ignores SIGTERM", async () => {
        await withTempDir("baro-codex-stubborn-", async (dir) => {
            const bin = writeFakeCodex(dir, {
                texts: ["partial…"],
                hangMs: 30_000,
                ignoreSigterm: true,
            })
            const startedAt = Date.now()

            await assert.rejects(
                runCodexOneShot({
                    prompt: "goal",
                    cwd: dir,
                    codexBin: bin,
                    timeoutMs: 50,
                    terminationGraceMs: 50,
                }),
                /terminated abnormally.*timedOut=true/,
            )
            assert.ok(Date.now() - startedAt < 2_000)
        })
    })

    it("kills an inherited-stdio, TERM-resistant descendant before rejecting cancellation", async () => {
        await withTempDir("baro-codex-tree-", async (dir) => {
            const started = join(dir, "descendant-started")
            const escaped = join(dir, "descendant-escaped")
            const bin = writeFakeCodex(dir, {
                texts: ["partial…"],
                hangMs: 30_000,
                stubbornDescendant: {
                    startedFile: started,
                    escapedFile: escaped,
                    escapeDelayMs: 1_500,
                },
            })
            const controller = new AbortController()
            const pending = runCodexOneShot({
                prompt: "goal",
                cwd: dir,
                codexBin: bin,
                timeoutMs: 30_000,
                terminationGraceMs: 75,
                signal: controller.signal,
            })

            // A fixed wall-clock cap can expire before a second Node process
            // gets CPU under full-suite load. Wait for the descendant's own
            // marker, written only after its SIGTERM handler is installed,
            // then exercise the same terminate/escalate path via cancellation.
            try {
                await waitForFile(started)
                controller.abort()
                await assert.rejects(
                    pending,
                    { name: "AbortError" },
                )
            } finally {
                controller.abort()
                await pending.catch(() => undefined)
            }
            await delay(1_550)
            assert.equal(
                existsSync(escaped),
                false,
                "Codex descendant survived termination escalation",
            )
        })
    })

    it("honors an abort that arrives after the direct Codex root exits", async () => {
        await withTempDir("baro-codex-late-abort-", async (dir) => {
            const rootExited = join(dir, "root-exited")
            const descendantStarted = join(dir, "descendant-started")
            const bin = join(dir, "late-abort-codex.mjs")
            writeFileSync(
                bin,
                `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const descendantSource = ${JSON.stringify(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(descendantStarted)}, String(process.pid));
setInterval(() => {}, 10_000);
`)};
const descendant = spawn(process.execPath, ["--input-type=module", "-e", descendantSource], {
    stdio: ["ignore", "inherit", "inherit"],
});
descendant.unref();
console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "premature success" },
}));
while (!existsSync(${JSON.stringify(descendantStarted)})) {
    await new Promise((resolve) => setTimeout(resolve, 10));
}
writeFileSync(${JSON.stringify(rootExited)}, "yes");
process.exit(0);
`,
            )
            chmodSync(bin, 0o755)
            const controller = new AbortController()
            const pending = runCodexOneShot({
                prompt: "goal",
                cwd: dir,
                codexBin: bin,
                signal: controller.signal,
                terminationGraceMs: 1_000,
            })

            await waitForFile(rootExited)
            const descendantPid = Number(
                readFileSync(descendantStarted, "utf8"),
            )
            assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0)
            await delay(75)
            const abortedAt = Date.now()
            controller.abort()

            await assert.rejects(pending, { name: "AbortError" })
            assert.ok(
                Date.now() - abortedAt < 2_500,
                "late abort exceeded the bounded cleanup window",
            )
            await waitForProcessExit(descendantPid)
        })
    })

    it("supports an ephemeral read-only harness for conversation calls", async () => {
        await withTempDir("baro-codex-readonly-", async (dir) => {
            const argvFile = join(dir, "argv.json")
            const bin = writeFakeCodex(dir, {
                texts: ["safe"],
                argvFile,
            })

            await runCodexOneShot({
                prompt: "classify this goal",
                cwd: dir,
                codexBin: bin,
                bypassSandbox: false,
                sandboxMode: "read-only",
                ephemeral: true,
                ignoreUserConfig: true,
                ignoreRules: true,
                disableProjectDocs: true,
            })

            const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[]
            assert.deepEqual(argv.slice(0, 10), [
                "exec",
                "--json",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
                "--strict-config",
                "--config",
                "project_doc_max_bytes=0",
            ])
            assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false)
        })
    })

    it("supports a fail-closed minimal-filesystem permission profile", async () => {
        await withTempDir("baro-codex-isolated-", async (dir) => {
            const argvFile = join(dir, "argv.json")
            const bin = writeFakeCodex(dir, { texts: ["safe"], argvFile })

            await runCodexOneShot({
                prompt: "classify brokered observations",
                cwd: dir,
                codexBin: bin,
                bypassSandbox: false,
                isolateToolFilesystem: true,
                ephemeral: true,
                ignoreUserConfig: true,
                ignoreRules: true,
                disableProjectDocs: true,
            })

            const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[]
            assert.equal(argv.includes("--sandbox"), false)
            assert.equal(
                argv.filter((value) => value === "--strict-config").length,
                1,
            )
            for (const value of [
                'default_permissions="baro_dialogue"',
                'permissions.baro_dialogue.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
                'approval_policy="never"',
                'web_search="disabled"',
                'shell_environment_policy.inherit="none"',
                "allow_login_shell=false",
                "project_doc_max_bytes=0",
            ]) assert.equal(argv.includes(value), true, `missing ${value}`)
        })
    })

    it("encodes dotted checkout paths as one untrusted projects map", async () => {
        await withTempDir("baro-codex-project-trust-", async (dir) => {
            const argvFile = join(dir, "argv.json")
            const bin = writeFakeCodex(dir, { texts: ["safe"], argvFile })
            const dottedPath = join(dir, "Miodrag.todorovic.ext", "repo")

            await runCodexOneShot({
                prompt: "inspect safely",
                cwd: dir,
                codexBin: bin,
                bypassSandbox: false,
                sandboxMode: "read-only",
                untrustedProjectPath: dottedPath,
            })

            const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[]
            const trust = argv.find((value) => value.startsWith("projects={"))
            assert.equal(
                trust,
                `projects={${JSON.stringify(dottedPath)}={trust_level="untrusted"}}`,
            )
            assert.equal(
                argv.some((value) => value.startsWith("projects.")),
                false,
            )
        })
    })

    it("injects one required run-scoped MCP server with Windows-safe TOML", async () => {
        await withTempDir("baro-codex-mcp-", async (dir) => {
            const argvFile = join(dir, "argv.json")
            const bin = writeFakeCodex(dir, { texts: ["safe"], argvFile })

            await runCodexOneShot({
                prompt: "plan progressively",
                cwd: dir,
                codexBin: bin,
                ignoreUserConfig: true,
                reasoningEffort: "high",
                additionalEnvironment: {
                    BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN: "deadbeef",
                },
                mcpServer: {
                    name: "baro_planning",
                    command: "C:\\Program Files\\node.exe",
                    args: [
                        "C:\\Baro App\\run-planner.mjs",
                    ],
                    envVars: ["BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN"],
                    enabledTools: ["publish_plan_fragment"],
                },
            })

            const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[]
            assert.equal(argv.includes("--ignore-user-config"), true)
            assert.equal(argv.includes('model_reasoning_effort="high"'), true)
            assert.equal(
                argv.filter((value) => value === "--strict-config").length,
                1,
            )
            const config = argv.find((value) => value.startsWith("mcp_servers="))
            assert.ok(config)
            assert.equal(JSON.stringify(argv).includes("deadbeef"), false)
            assert.match(config!, /command="C:\\\\Program Files\\\\node\.exe"/)
            assert.match(
                config!,
                /env_vars=\["BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN"\]/,
            )
            assert.match(config!, /enabled_tools=\["publish_plan_fragment"\]/)
            assert.match(config!, /required=true/)
            assert.match(config!, /default_tools_approval_mode="prompt"/)
            assert.match(
                config!,
                /tools=\{"publish_plan_fragment"=\{approval_mode="approve"\}\}/,
            )
            assert.ok(
                argv.includes(
                    'shell_environment_policy.exclude=["BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN"]',
                ),
            )
        })
    })

    it("rejects unsafe run-scoped MCP configuration before launch", async () => {
        await assert.rejects(
            runCodexOneShot({
                prompt: "invalid MCP",
                cwd: process.cwd(),
                mcpServer: {
                    name: "bad.name",
                    command: process.execPath,
                    args: ["server.mjs"],
                    enabledTools: ["publish_plan_fragment"],
                },
            }),
            /MCP server name is not a safe TOML key/,
        )
    })

    it("rejects an unsupported reasoning effort before launch", async () => {
        await assert.rejects(
            runCodexOneShot({
                prompt: "invalid effort",
                cwd: process.cwd(),
                reasoningEffort: "extreme" as "high",
            }),
            /unsupported reasoning effort/,
        )
    })

    it("rejects an isolated profile combined with the legacy sandbox", async () => {
        await assert.rejects(
            runCodexOneShot({
                prompt: "invalid combination",
                cwd: process.cwd(),
                bypassSandbox: false,
                isolateToolFilesystem: true,
                sandboxMode: "read-only",
            }),
            /cannot be combined/,
        )
    })

    it("kills and rejects a cancelled conversation call", async () => {
        await withTempDir("baro-codex-abort-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["partial"], hangMs: 30_000 })
            const controller = new AbortController()
            const pending = runCodexOneShot({
                prompt: "goal",
                cwd: dir,
                codexBin: bin,
                signal: controller.signal,
            })
            setTimeout(() => controller.abort(), 100)

            await assert.rejects(pending, { name: "AbortError" })
        })
    })
})
