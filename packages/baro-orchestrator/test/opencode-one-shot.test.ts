import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

    it("aborts the child and records a timed-out terminal observation", async () => {
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
            assert.equal(observations[0]!.status, "timed_out")
            assert.deepEqual(
                observations[0]!.tokens.total,
                unknownMetric("timed_out"),
            )
        })
    })
})
