import assert from "node:assert/strict"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"

import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
} from "../src/model-telemetry.js"
import { runPiOneShot } from "../src/pi-one-shot.js"
import type { RunnerInvocationObservation } from "../src/runner-invocation.js"
import { withTempDir } from "./participants/helpers.js"

function writeFakePi(
    dir: string,
    events: ReadonlyArray<Record<string, unknown>>,
    exitCode = 0,
): string {
    const bin = join(dir, "fake-pi.mjs")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
process.exit(${exitCode});
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("runPiOneShot invocation telemetry", () => {
    it("observes assistant message_end with cache-inclusive input and provider evidence", async () => {
        await withTempDir("baro-pi-usage-", async (dir) => {
            const bin = writeFakePi(dir, [
                {
                    type: "message_end",
                    message: {
                        role: "user",
                        usage: { input: 999, output: 999 },
                        content: [{ type: "text", text: "goal" }],
                    },
                },
                {
                    type: "message_end",
                    message: {
                        role: "assistant",
                        provider: "deepseek",
                        model: "deepseek-v4-live",
                        responseId: "provider-response-1",
                        usage: {
                            input: 10,
                            output: 5,
                            cacheRead: 4,
                            cacheWrite: 1,
                            totalTokens: 20,
                            cost: { total: 0.002 },
                        },
                        content: [{ type: "text", text: "answer" }],
                    },
                },
            ])
            const observations: RunnerInvocationObservation[] = []

            const result = await runPiOneShot({
                prompt: "goal",
                cwd: dir,
                piBin: bin,
                provider: "fallback-provider",
                model: "fallback-model",
                onInvocation: (item) => observations.push(item),
            })

            assert.equal(result, "answer")
            assert.equal(observations.length, 1)
            const observation = observations[0]!
            assert.equal(observation.sequence, 1)
            assert.equal(observation.granularity, "turn")
            assert.equal(observation.status, "succeeded")
            assert.equal(observation.provider, "deepseek")
            assert.equal(observation.resolvedModel, "deepseek-v4-live")
            assert.equal(observation.providerRequestId, "provider-response-1")
            assert.deepEqual(
                observation.tokens.inputTotal,
                knownMetric(15, "derived"),
            )
            assert.deepEqual(
                observation.tokens.cachedInput,
                knownMetric(4, "provider_response"),
            )
            assert.deepEqual(
                observation.tokens.cacheWriteInput,
                knownMetric(1, "provider_response"),
            )
            assert.deepEqual(
                observation.tokens.outputTotal,
                knownMetric(5, "provider_response"),
            )
            assert.deepEqual(
                observation.tokens.reasoningOutput,
                notApplicableMetric(),
            )
            assert.deepEqual(
                observation.tokens.total,
                knownMetric(20, "provider_response"),
            )
            assert.deepEqual(
                observation.cost.equivalentUsd,
                knownMetric(0.002, "cli_result"),
            )
        })
    })

    it("emits one failed unknown observation when no assistant message ends", async () => {
        await withTempDir("baro-pi-failure-", async (dir) => {
            const bin = writeFakePi(
                dir,
                [
                    {
                        type: "message_end",
                        message: {
                            role: "user",
                            content: [{ type: "text", text: "goal" }],
                        },
                    },
                ],
                2,
            )
            const observations: RunnerInvocationObservation[] = []

            await assert.rejects(
                runPiOneShot({
                    prompt: "goal",
                    cwd: dir,
                    piBin: bin,
                    onInvocation: (item) => observations.push(item),
                }),
                /terminated abnormally.*exit=2/,
            )

            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.sequence, 1)
            assert.equal(observations[0]!.status, "failed")
            assert.deepEqual(
                observations[0]!.tokens.inputTotal,
                unknownMetric("not_reported"),
            )
            assert.deepEqual(
                observations[0]!.tokens.reasoningOutput,
                notApplicableMetric(),
            )
        })
    })

    it("aborts the child and records a timed-out terminal observation", async () => {
        await withTempDir("baro-pi-abort-", async (dir) => {
            const bin = join(dir, "slow-pi.mjs")
            writeFileSync(bin, `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`)
            chmodSync(bin, 0o755)
            const controller = new AbortController()
            const observations: RunnerInvocationObservation[] = []
            const result = runPiOneShot({
                prompt: "goal",
                cwd: dir,
                piBin: bin,
                signal: controller.signal,
                onInvocation: (item) => observations.push(item),
            })
            setTimeout(() => controller.abort(), 100)

            await assert.rejects(result, { name: "AbortError" })
            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.status, "timed_out")
            assert.deepEqual(
                observations[0]!.tokens.total,
                unknownMetric("timed_out"),
            )
        })
    })

    it("kills a TERM-resistant provider descendant before cancellation settles", async () => {
        await withTempDir("baro-pi-tree-", async (dir) => {
            const started = join(dir, "descendant-started")
            const escaped = join(dir, "descendant-escaped")
            const bin = join(dir, "tree-pi.mjs")
            const descendantSource = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "yes");
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(${JSON.stringify(escaped)}, "yes"), 700);
setInterval(() => {}, 10_000);
`
            writeFileSync(bin, `#!/usr/bin/env node
import { spawn } from "node:child_process";
spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
setInterval(() => {}, 10_000);
`)
            chmodSync(bin, 0o755)

            const controller = new AbortController()
            const result = runPiOneShot({
                prompt: "goal",
                cwd: dir,
                piBin: bin,
                terminationGraceMs: 50,
                safeEvaluatorSystemPrompt: "No tools.",
                signal: controller.signal,
            })

            try {
                await waitForFile(started)
                controller.abort()
                await assert.rejects(result, { name: "AbortError" })
            } finally {
                controller.abort()
            }

            await delay(750)
            assert.equal(
                existsSync(escaped),
                false,
                "Pi descendant survived timeout escalation",
            )
        })
    })
})

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error("descendant never started")
        await delay(25)
    }
}
