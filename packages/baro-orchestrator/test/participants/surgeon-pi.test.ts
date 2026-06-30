import assert from "node:assert/strict"
import childProcess, { type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"

import { Replan, StoryResult, type ReplanStoryAdd } from "../../src/semantic-events.js"
import { SurgeonPi } from "../../src/participants/surgeon-pi.js"
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

describe("SurgeonPi", () => {
    it("falls back to a deterministic Replan when Pi IO fails", async () => {
        await withSpawnOutput([], 2, async () => {
            const surgeon = new SurgeonPi({
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
            assert.match(replans[0]!.data.reason, /pi fallback after error:/)
        })
    })

    it("parses structured Replan JSON from Pi message_end events", async () => {
        const added: ReplanStoryAdd = {
            id: "S1a",
            priority: 7,
            title: "Prepare failing path",
            description: "Add the prerequisite before retrying S1.",
            dependsOn: [],
            acceptance: ["The retry has setup in place."],
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
                    type: "message_end",
                    message: {
                        role: "assistant",
                        usage: { input: 1, output: 1 },
                        content: [{ type: "text", text }],
                    },
                }),
            ],
            0,
            async () => {
                const surgeon = new SurgeonPi({
                    snapshot,
                    timeoutMs: 10_000,
                })
                const env = joinWithCapture(surgeon)

                await surgeon.onExternalEvent(source("story-agent"), failure)
                await surgeon.idle()

                const replans = env.events.filter(Replan.is)
                assert.equal(replans.length, 1)
                assert.equal(replans[0]!.data.reason, "prereq: missing setup")
                assert.deepEqual(replans[0]!.data.addedStories, [added])
                assert.deepEqual(replans[0]!.data.removedStoryIds, ["S1"])
                assert.deepEqual(replans[0]!.data.modifiedDeps, { S2: ["S1a"] })
            },
        )
    })

    it("filters malformed dependency modification payload entries", async () => {
        const verdict = {
            action: "rewire",
            reason: "keep dependent reachable",
            added: [],
            removed: [],
            modifiedDeps: [
                { id: "S2", newDependsOn: ["S1a"] },
                { id: 12, newDependsOn: ["S1"] },
                { id: "S3", newDependsOn: "S1" },
            ],
        }
        await withSpawnOutput(
            [
                JSON.stringify({
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(verdict),
                            },
                        ],
                    },
                }),
            ],
            0,
            async () => {
                const surgeon = new SurgeonPi({
                    snapshot,
                    timeoutMs: 10_000,
                })
                const env = joinWithCapture(surgeon)

                await surgeon.onExternalEvent(source("story-agent"), failure)
                await surgeon.idle()

                const replans = env.events.filter(Replan.is)
                assert.equal(replans.length, 1)
                assert.equal(replans[0]!.data.reason, "rewire: keep dependent reachable")
                assert.deepEqual(replans[0]!.data.modifiedDeps, { S2: ["S1a"] })
            },
        )
    })
})
