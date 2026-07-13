import assert from "node:assert/strict"
import childProcess, { type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"

import {
    ModelInvocationMeasured,
    Replan,
    StoryResult,
    type ReplanStoryAdd,
} from "../../src/semantic-events.js"
import { SurgeonOpenCode } from "../../src/participants/surgeon-opencode.js"
import type { PrdSnapshot } from "../../src/participants/surgeon.js"
import { joinWithCapture, source } from "./helpers.js"

const snapshot = (): PrdSnapshot => ({
    project: "participant-tests",
    description: "Exercise surgeon provider behavior.",
    stories: [
        {
            id: "S1",
            title: "Failing story",
            description: "This story fails terminally.",
            dependsOn: [],
            passes: false,
            model: "sonnet",
        },
        {
            id: "S2",
            title: "Dependent story",
            description: "This story depends on S1.",
            dependsOn: ["S1"],
            passes: false,
            model: "haiku",
        },
    ],
})

const failure = StoryResult.create({
    storyId: "S1",
    success: false,
    attempts: 3,
    durationSecs: 12,
    error: "implementation failed",
})

async function withSpawnOutput(
    stdoutLines: string[],
    exitCode: number,
    fn: () => Promise<void>,
): Promise<void> {
    const originalSpawn = childProcess.spawn
    childProcess.spawn = (() => {
        const proc = new EventEmitter() as ChildProcess
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        Object.assign(proc, {
            stdout,
            stderr,
            kill: () => {
                proc.emit("exit", null, "SIGTERM")
                return true
            },
        })
        queueMicrotask(() => {
            for (const line of stdoutLines) stdout.write(`${line}\n`)
            stdout.end()
            stderr.end()
            proc.emit("exit", exitCode, null)
        })
        return proc
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    try {
        await fn()
    } finally {
        childProcess.spawn = originalSpawn
        syncBuiltinESMExports()
    }
}

describe("SurgeonOpenCode", () => {
    it("falls back to a deterministic Replan when OpenCode IO fails", async () => {
        await withSpawnOutput([], 2, async () => {
            const surgeon = new SurgeonOpenCode({
                snapshot,
                timeoutMs: 10_000,
                runId: "run-opencode-failure",
            })
            const env = joinWithCapture(surgeon)

            await surgeon.onExternalEvent(source("story-agent"), failure)
            await surgeon.idle()

            const replans = env.events.filter(Replan.is)
            assert.equal(replans.length, 1)
            assert.deepEqual(replans[0]!.data.addedStories, [])
            assert.deepEqual(replans[0]!.data.removedStoryIds, ["S1"])
            assert.deepEqual(replans[0]!.data.modifiedDeps, {})
            assert.match(replans[0]!.data.reason, /deterministic skip: S1 exhausted 3 attempts/)
            assert.match(replans[0]!.data.reason, /opencode fallback after error:/)

            const measured = env.events.filter(ModelInvocationMeasured.is)
            assert.equal(measured.length, 1)
            assert.equal(measured[0]!.data.status, "failed")
            assert.equal(measured[0]!.data.phase, "surgeon")
            assert.equal(measured[0]!.data.backend, "opencode")
            assert.equal(measured[0]!.data.tokens.inputTotal.state, "unknown")
            assert.ok(
                env.events.findIndex(ModelInvocationMeasured.is) <
                    env.events.findIndex(Replan.is),
            )
        })
    })

    it("parses structured Replan JSON from OpenCode text events", async () => {
        const added: ReplanStoryAdd = {
            id: "S1a",
            priority: 7,
            title: "Prepare failing path",
            description: "Add the prerequisite before retrying S1.",
            dependsOn: [],
            acceptance: ["The retry has setup in place."],
            tests: ["npm test"],
            model: "haiku",
        }
        const verdict = {
            action: "prereq",
            reason: "missing setup",
            added: [added],
            removed: ["S1"],
            modifiedDeps: [{ id: "S2", newDependsOn: ["S1a"] }],
        }
        const text = `analysis\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``
        await withSpawnOutput(
            [
                JSON.stringify({ type: "text", part: { text } }),
                JSON.stringify({
                    type: "step_finish",
                    part: { tokens: { input: 1, output: 1 } },
                }),
            ],
            0,
            async () => {
                const surgeon = new SurgeonOpenCode({
                    snapshot,
                    timeoutMs: 10_000,
                    model: "provider/model-test",
                })
                const env = joinWithCapture(surgeon)

                await surgeon.onExternalEvent(
                    source("story-agent"),
                    StoryResult.create({
                        ...failure.data,
                        runId: "run-opencode-telemetry",
                        leaseId: "lease-S1",
                        generation: 4,
                    }),
                )
                await surgeon.idle()

                const replans = env.events.filter(Replan.is)
                assert.equal(replans.length, 1)
                assert.equal(replans[0]!.data.reason, "prereq: missing setup")
                assert.deepEqual(replans[0]!.data.addedStories, [added])
                assert.deepEqual(replans[0]!.data.removedStoryIds, ["S1"])
                assert.deepEqual(replans[0]!.data.modifiedDeps, { S2: ["S1a"] })

                const measured = env.events.filter(ModelInvocationMeasured.is)
                assert.equal(measured.length, 1)
                assert.equal(
                    measured[0]!.data.invocationId,
                    "run-opencode-telemetry:surgeon:S1:1:lease:lease-S1:generation:4:provider:1",
                )
                assert.equal(measured[0]!.data.runId, "run-opencode-telemetry")
                assert.equal(measured[0]!.data.storyId, "S1")
                assert.equal(measured[0]!.data.turn, 1)
                assert.equal(measured[0]!.data.requestedModel, "provider/model-test")
                assert.equal(measured[0]!.data.status, "succeeded")
                assert.ok(
                    env.events.findIndex(ModelInvocationMeasured.is) <
                        env.events.findIndex(Replan.is),
                )
            },
        )
    })

    it("falls back to a deterministic Replan when OpenCode returns malformed text", async () => {
        await withSpawnOutput(
            [JSON.stringify({ type: "text", part: { text: "no replan json available" } })],
            0,
            async () => {
                const surgeon = new SurgeonOpenCode({
                    snapshot,
                    timeoutMs: 10_000,
                })
                const env = joinWithCapture(surgeon)

                await surgeon.onExternalEvent(source("story-agent"), failure)
                await surgeon.idle()

                const replans = env.events.filter(Replan.is)
                assert.equal(replans.length, 1)
                assert.deepEqual(replans[0]!.data.addedStories, [])
                assert.deepEqual(replans[0]!.data.removedStoryIds, ["S1"])
                assert.deepEqual(replans[0]!.data.modifiedDeps, {})
                assert.match(replans[0]!.data.reason, /deterministic skip: S1 exhausted 3 attempts/)
                assert.match(replans[0]!.data.reason, /opencode fallback after error: no JSON object found/)

                const measured = env.events.filter(ModelInvocationMeasured.is)
                assert.equal(measured.length, 1)
                assert.equal(measured[0]!.data.status, "succeeded")
                assert.equal(measured[0]!.data.tokens.inputTotal.state, "unknown")
                assert.ok(
                    env.events.findIndex(ModelInvocationMeasured.is) <
                        env.events.findIndex(Replan.is),
                )
            },
        )
    })

    it("emits no model measurement when LLM evaluation is disabled", async () => {
        const surgeon = new SurgeonOpenCode({ snapshot, useLlm: false })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(source("story-agent"), failure)
        await surgeon.idle()

        assert.equal(env.events.filter(Replan.is).length, 1)
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)
    })
})
