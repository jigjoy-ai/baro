import assert from "node:assert/strict"
import childProcess, { type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"

import {
    ModelInvocationMeasured,
    RecoveryDecision,
    RecoveryEvaluationStarted,
    Replan,
    StoryQualityCompleted,
    StoryResult,
    WorkLeaseGranted,
    type ReplanStoryAdd,
} from "../../src/semantic-events.js"
import { SurgeonCodex } from "../../src/participants/surgeon-codex.js"
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
        let terminalEmitted = false
        const emitTerminal = (
            code: number | null,
            signal: NodeJS.Signals | null,
        ): void => {
            if (terminalEmitted) return
            terminalEmitted = true
            proc.emit("exit", code, signal)
            // A real ChildProcess emits `close` only after its stdio streams
            // have drained. One-shot finalization deliberately owns this later
            // boundary so a final newline-less JSON event is never lost.
            queueMicrotask(() => proc.emit("close", code, signal))
        }
        Object.assign(proc, {
            stdout,
            stderr,
            kill: () => {
                emitTerminal(null, "SIGTERM")
                return true
            },
        })
        queueMicrotask(() => {
            for (const line of stdoutLines) stdout.write(`${line}\n`)
            stdout.end()
            stderr.end()
            emitTerminal(exitCode, null)
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

describe("SurgeonCodex", () => {
    it("falls back to a deterministic Replan when Codex IO fails", async () => {
        await withSpawnOutput([], 2, async () => {
            const surgeon = new SurgeonCodex({
                snapshot,
                timeoutMs: 10_000,
                runId: "run-codex-failure",
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
            assert.match(replans[0]!.data.reason, /codex fallback after error:/)

            const measured = env.events.filter(ModelInvocationMeasured.is)
            assert.equal(measured.length, 1)
            assert.equal(measured[0]!.data.status, "failed")
            assert.equal(measured[0]!.data.phase, "surgeon")
            assert.equal(measured[0]!.data.backend, "codex")
            assert.equal(measured[0]!.data.tokens.inputTotal.state, "unknown")
            assert.ok(
                env.events.findIndex(ModelInvocationMeasured.is) <
                    env.events.findIndex(Replan.is),
            )
        })
    })

    it("parses structured Replan JSON from Codex agent messages", async () => {
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
                JSON.stringify({
                    type: "item.completed",
                    item: { type: "agent_message", text },
                }),
                JSON.stringify({
                    type: "turn.completed",
                    usage: { input_tokens: 1, output_tokens: 1 },
                }),
            ],
            0,
            async () => {
                const surgeon = new SurgeonCodex({
                    snapshot,
                    timeoutMs: 10_000,
                    model: "gpt-test",
                })
                const env = joinWithCapture(surgeon)

                await surgeon.onExternalEvent(
                    source("story-agent"),
                    StoryResult.create({
                        ...failure.data,
                        runId: "run-codex-telemetry",
                        leaseId: "lease-S1",
                        generation: 3,
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
                    "run-codex-telemetry:surgeon:S1:1:lease:lease-S1:generation:3:provider:1",
                )
                assert.equal(measured[0]!.data.runId, "run-codex-telemetry")
                assert.equal(measured[0]!.data.storyId, "S1")
                assert.equal(measured[0]!.data.turn, 1)
                assert.equal(measured[0]!.data.requestedModel, "gpt-test")
                assert.equal(measured[0]!.data.status, "succeeded")
                assert.ok(
                    env.events.findIndex(ModelInvocationMeasured.is) <
                        env.events.findIndex(Replan.is),
                )
            },
        )
    })

    it("falls back to a deterministic Replan when Codex returns malformed text", async () => {
        await withSpawnOutput(
            [
                JSON.stringify({
                    type: "item.completed",
                    item: {
                        type: "agent_message",
                        text: "no replan json available",
                    },
                }),
            ],
            0,
            async () => {
                const surgeon = new SurgeonCodex({
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
                assert.match(replans[0]!.data.reason, /codex fallback after error: no JSON object found/)

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

    it("bridges a correlated quality failure into one-shot recovery", async () => {
        const surgeon = new SurgeonCodex({
            snapshot,
            useLlm: false,
            runId: "run-codex-quality",
            emitRecoveryDecisions: true,
        })
        const env = joinWithCapture(surgeon)
        await surgeon.onExternalEvent(
            source("broker"),
            WorkLeaseGranted.create({
                runId: "run-codex-quality",
                offerId: "offer-S1",
                leaseId: "lease-S1",
                workerId: "worker",
                generation: 1,
                request: {
                    storyId: "S1",
                    prompt: "implement",
                    model: "standard",
                    retries: 1,
                    timeoutSecs: 60,
                },
            }),
        )
        await surgeon.onExternalEvent(
            source("S1"),
            StoryResult.create({
                storyId: "S1",
                success: true,
                attempts: 1,
                durationSecs: 3,
                error: null,
                runId: "run-codex-quality",
                leaseId: "lease-S1",
                generation: 1,
            }),
        )
        await surgeon.onExternalEvent(
            source("quality-gate"),
            StoryQualityCompleted.create({
                runId: "run-codex-quality",
                evaluationId: "quality-S1",
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                status: "failed",
                targetTurn: 1,
                reason: "acceptance mismatch",
            }),
        )
        await surgeon.idle()

        assert.deepEqual(
            env.events
                .filter((event) =>
                    RecoveryEvaluationStarted.is(event) ||
                    Replan.is(event) ||
                    RecoveryDecision.is(event),
                )
                .map((event) => event.type),
            ["recovery_evaluation_started", "replan", "recovery_decision"],
        )
        assert.match(
            env.events.find(Replan.is)!.data.reason,
            /acceptance quality gate failed: acceptance mismatch/,
        )
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)
    })
})
