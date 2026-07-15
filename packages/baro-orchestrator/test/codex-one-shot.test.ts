import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
        argvFile?: string
    },
): string {
    const bin = join(dir, "fake-codex.mjs")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { writeFileSync as fixtureWriteFileSync } from "node:fs";
const texts = ${JSON.stringify(opts.texts)};
${opts.argvFile ? `fixtureWriteFileSync(${JSON.stringify(opts.argvFile)}, JSON.stringify(process.argv.slice(2)));` : ""}
for (const text of texts) {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
}
for (const event of ${JSON.stringify(opts.events ?? [])}) {
    console.log(JSON.stringify(event));
}
${opts.hangMs ? `await new Promise((r) => setTimeout(r, ${opts.hangMs}));` : ""}
process.exit(${opts.exitCode ?? 0});
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("runCodexOneShot exit contract", () => {
    it("resolves the agent message on a clean exit", async () => {
        await withTempDir("baro-codex-exit-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["design doc"] })

            const result = await runCodexOneShot({ prompt: "goal", cwd: dir, codexBin: bin })
            assert.equal(result, "design doc")
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
            })

            const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[]
            assert.deepEqual(argv.slice(0, 5), [
                "exec",
                "--json",
                "--sandbox",
                "read-only",
                "--ephemeral",
            ])
            assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false)
        })
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
