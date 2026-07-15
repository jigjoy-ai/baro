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
fixtureSpawn(process.execPath, ["--input-type=module", "-e", descendantSource], { stdio: "ignore" });
`
        : ""
}
for (const text of texts) {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
}
for (const event of ${JSON.stringify(opts.events ?? [])}) {
    console.log(JSON.stringify(event));
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

    it("kills a ready TERM-resistant descendant before rejecting cancellation", async () => {
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
                    /terminated abnormally.*aborted=true/,
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

            await assert.rejects(pending, /terminated abnormally.*aborted=true/)
        })
    })
})
