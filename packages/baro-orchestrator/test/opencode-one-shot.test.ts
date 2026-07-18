import assert from "node:assert/strict"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"

import { knownMetric, unknownMetric } from "../src/model-telemetry.js"
import { runOpenCodeOneShot } from "../src/opencode-one-shot.js"
import type { RunnerInvocationObservation } from "../src/runner-invocation.js"
import { withTempDir } from "./participants/helpers.js"

function writeFakeOpenCode(
    dir: string,
    events: ReadonlyArray<Record<string, unknown>>,
    exitCode = 0,
): string {
    const bin = join(dir, "fake-opencode.mjs")
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

describe("runOpenCodeOneShot invocation telemetry", () => {
    it("emits one normalized observation for every step_finish", async () => {
        await withTempDir("baro-opencode-usage-", async (dir) => {
            const bin = writeFakeOpenCode(dir, [
                {
                    type: "text",
                    sessionID: "harness-session",
                    part: { text: "answer" },
                },
                {
                    type: "step_finish",
                    sessionID: "harness-session",
                    part: {
                        providerID: "zhipu",
                        modelID: "glm-5-live",
                        tokens: {
                            total: 100,
                            input: 70,
                            output: 7,
                            reasoning: 3,
                            cache: { read: 20, write: 0 },
                        },
                        cost: 0.001,
                    },
                },
                {
                    type: "step_finish",
                    sessionID: "harness-session",
                    part: {
                        tokens: {
                            total: 7,
                            input: 3,
                            output: 2,
                            reasoning: 0,
                            cache: { read: 1, write: 1 },
                        },
                        cost: 0.0002,
                    },
                },
            ])
            const observations: RunnerInvocationObservation[] = []

            const result = await runOpenCodeOneShot({
                prompt: "goal",
                cwd: dir,
                opencodeBin: bin,
                model: "zhipu/glm-5",
                onInvocation: (item) => observations.push(item),
            })

            assert.equal(result, "answer")
            assert.deepEqual(
                observations.map((item) => item.sequence),
                [1, 2],
            )
            assert.ok(
                observations.every(
                    (item) =>
                        item.granularity === "round" &&
                        item.status === "succeeded" &&
                        item.providerRequestId === null,
                ),
            )
            const first = observations[0]!
            assert.equal(first.provider, "zhipu")
            assert.equal(first.resolvedModel, "glm-5-live")
            assert.deepEqual(
                first.tokens.inputTotal,
                knownMetric(90, "derived"),
            )
            assert.deepEqual(
                first.tokens.cachedInput,
                knownMetric(20, "provider_response"),
            )
            assert.deepEqual(
                first.tokens.cacheWriteInput,
                knownMetric(0, "provider_response"),
            )
            assert.deepEqual(
                first.tokens.outputTotal,
                knownMetric(10, "derived"),
            )
            assert.deepEqual(
                first.tokens.reasoningOutput,
                knownMetric(3, "provider_response"),
            )
            assert.deepEqual(
                first.cost.equivalentUsd,
                knownMetric(0.001, "cli_result"),
            )
            assert.deepEqual(
                observations[1]!.tokens.inputTotal,
                knownMetric(5, "derived"),
            )
        })
    })

    it("flushes terminal output and usage when the final NDJSON record has no newline", async () => {
        await withTempDir("baro-opencode-final-fragment-", async (dir) => {
            const bin = join(dir, "fragment-opencode.mjs")
            writeFileSync(
                bin,
                `#!/usr/bin/env node
const events = [
    { type: "text", part: { text: "final answer" } },
    { type: "step_finish", part: { tokens: { input: 11, output: 7, total: 18 }, cost: 0.001 } },
];
process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n"));
`,
            )
            chmodSync(bin, 0o755)
            const observations: RunnerInvocationObservation[] = []

            const result = await runOpenCodeOneShot({
                prompt: "goal",
                cwd: dir,
                opencodeBin: bin,
                onInvocation: (item) => observations.push(item),
            })

            assert.equal(result, "final answer")
            assert.equal(observations.length, 1)
            assert.deepEqual(
                observations[0]!.tokens.total,
                knownMetric(18, "provider_response"),
            )
        })
    })

    it("discards an entire oversized stdout line before parsing later NDJSON", async () => {
        await withTempDir("baro-opencode-stdout-bound-", async (dir) => {
            const bin = join(dir, "oversized-opencode.mjs")
            writeFileSync(
                bin,
                `#!/usr/bin/env node
process.stdout.write("x".repeat(1025));
await new Promise((resolve) => setTimeout(resolve, 25));
process.stdout.write(JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 99, output: 1, total: 100 } },
}));
await new Promise((resolve) => setTimeout(resolve, 25));
process.stdout.write("\\n");
process.stdout.write("\\u3000".repeat(342) + JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 199, output: 1, total: 200 } },
}) + "\\n");
console.log(JSON.stringify({
    type: "text",
    part: { text: "recovered after oversized fragment" },
}));
`,
            )
            chmodSync(bin, 0o755)
            const observations: RunnerInvocationObservation[] = []

            const result = await runOpenCodeOneShot({
                prompt: "goal",
                cwd: dir,
                opencodeBin: bin,
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

    it("emits one failed unknown observation when no step finishes", async () => {
        await withTempDir("baro-opencode-failure-", async (dir) => {
            const bin = writeFakeOpenCode(
                dir,
                [{ type: "text", part: { text: "partial" } }],
                3,
            )
            const observations: RunnerInvocationObservation[] = []

            await assert.rejects(
                runOpenCodeOneShot({
                    prompt: "goal",
                    cwd: dir,
                    opencodeBin: bin,
                    onInvocation: (item) => observations.push(item),
                }),
                /terminated abnormally.*exit=3/,
            )

            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.sequence, 1)
            assert.equal(observations[0]!.status, "failed")
            assert.deepEqual(
                observations[0]!.cost.equivalentUsd,
                unknownMetric("not_reported"),
            )
        })
    })

    it("settles an asynchronous spawn error exactly once", async () => {
        await withTempDir("baro-opencode-spawn-error-", async (dir) => {
            const observations: RunnerInvocationObservation[] = []

            await assert.rejects(
                runOpenCodeOneShot({
                    prompt: "goal",
                    cwd: dir,
                    opencodeBin: join(dir, "missing-opencode"),
                    onInvocation: (item) => observations.push(item),
                }),
                { code: "ENOENT" },
            )

            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.status, "failed")
        })
    })

    it("aborts the child and records a cancelled terminal observation", async () => {
        await withTempDir("baro-opencode-abort-", async (dir) => {
            const bin = join(dir, "slow-opencode.mjs")
            writeFileSync(bin, `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`)
            chmodSync(bin, 0o755)
            const controller = new AbortController()
            const observations: RunnerInvocationObservation[] = []
            const result = runOpenCodeOneShot({
                prompt: "goal",
                cwd: dir,
                opencodeBin: bin,
                signal: controller.signal,
                onInvocation: (item) => observations.push(item),
            })
            setTimeout(() => controller.abort(), 100)

            await assert.rejects(result, { name: "AbortError" })
            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.status, "cancelled")
            assert.deepEqual(
                observations[0]!.tokens.total,
                unknownMetric("not_reported"),
            )
        })
    })

    it("keeps a wall-clock timeout distinct from caller cancellation", async () => {
        await withTempDir("baro-opencode-timeout-", async (dir) => {
            const bin = join(dir, "slow-opencode.mjs")
            writeFileSync(bin, `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`)
            chmodSync(bin, 0o755)
            const observations: RunnerInvocationObservation[] = []

            await assert.rejects(
                runOpenCodeOneShot({
                    prompt: "goal",
                    cwd: dir,
                    opencodeBin: bin,
                    timeoutMs: 100,
                    onInvocation: (item) => observations.push(item),
                }),
                /terminated abnormally.*timedOut=true/,
            )
            assert.equal(observations.length, 1)
            assert.equal(observations[0]!.status, "timed_out")
            assert.deepEqual(
                observations[0]!.tokens.total,
                unknownMetric("timed_out"),
            )
        })
    })

    it("kills an inherited-stdio, TERM-resistant descendant before cancellation settles", async () => {
        await withTempDir("baro-opencode-tree-", async (dir) => {
            const started = join(dir, "descendant-started")
            const escaped = join(dir, "descendant-escaped")
            const bin = join(dir, "tree-opencode.mjs")
            const descendantSource = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "yes");
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(${JSON.stringify(escaped)}, "yes"), 700);
setInterval(() => {}, 10_000);
`
            writeFileSync(bin, `#!/usr/bin/env node
import { spawn } from "node:child_process";
spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], {
    stdio: ["ignore", "inherit", "inherit"],
});
console.log(JSON.stringify({ type: "text", part: { text: "partial" } }));
setInterval(() => {}, 10_000);
`)
            chmodSync(bin, 0o755)

            const controller = new AbortController()
            const result = runOpenCodeOneShot({
                prompt: "goal",
                cwd: dir,
                opencodeBin: bin,
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
                "OpenCode descendant survived timeout escalation",
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
