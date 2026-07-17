import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Conductor } from "../../src/participants/conductor.js"
import type { PrdFile } from "../../src/prd.js"
import {
    ConductorState,
    LevelCompleted,
    LevelStarted,
    RecoveryStarted,
    Replan,
    ReplanApplied,
    RunCompleted,
    RunStartRequest,
    RunStarted,
    StoryResult,
    StorySpawnRequest,
    type ReplanData,
    type ReplanStoryAdd,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("Conductor", () => {
    it("emits run, level, spawn, and completion events for a passing story", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )

            const spawn = await waitForEvent(env.events, StorySpawnRequest.is)
            assert.equal(RunStarted.is(env.events.find(RunStarted.is)!), true)
            assert.deepEqual(env.events.find(RunStarted.is)?.data, {
                project: "Participant Tests",
                storyCount: 1,
                storyIds: ["S1"],
                completedStoryIds: [],
                coordinationMode: "legacy",
            })
            assert.deepEqual(env.events.find(LevelStarted.is)?.data, {
                ordinal: 1,
                totalLevelsHint: 1,
                storyIds: ["S1"],
            })
            assert.equal(spawn.data.storyId, "S1")
            assert.equal(spawn.data.model, "opus")
            assert.equal(spawn.data.retries, 2)
            assert.equal(spawn.data.timeoutSecs, 45)
            assert.match(spawn.data.prompt, /Implement conductor coverage/)

            env.deliverSemanticEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: true,
                    attempts: 2,
                    durationSecs: 7,
                    error: null,
                }),
            )

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.deepEqual(env.events.find(LevelCompleted.is)?.data, {
                ordinal: 1,
                passed: ["S1"],
                failed: [],
            })
            assert.equal(completed.data.success, true)
            assert.deepEqual(completed.data.completedStories, ["S1"])
            assert.deepEqual(completed.data.failedStories, [])
            assert.equal(completed.data.totalAttempts, 2)
            assert.equal(completed.data.abortReason, null)

            const savedPrd = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(savedPrd.userStories[0]?.passes, true)
            assert.equal(savedPrd.userStories[0]?.durationSecs, 7)
        })
    })

    it("runs the recovery lifecycle once and completes failed when the story still fails", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const failedStories: string[] = []
            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                onStoryFailed: (storyId) => failedStories.push(storyId),
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )

            await waitForEvent(env.events, StorySpawnRequest.is)
            env.deliverSemanticEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: false,
                    attempts: 1,
                    durationSecs: 3,
                    error: "first failure",
                }),
            )

            await waitForEvents(env.events, StorySpawnRequest.is, 2)
            env.deliverSemanticEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: false,
                    attempts: 2,
                    durationSecs: 5,
                    error: "still failing",
                }),
            )

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, false)
            assert.deepEqual(completed.data.completedStories, [])
            assert.deepEqual(completed.data.failedStories, ["S1"])
            assert.equal(completed.data.totalAttempts, 3)
            assert.equal(
                completed.data.abortReason,
                "all stories in level failed; aborting remaining levels",
            )
            assert.deepEqual(failedStories, ["S1", "S1"])

            const levelEvents = env.events.filter(LevelStarted.is)
            assert.equal(levelEvents.length, 2)
            assert.deepEqual(levelEvents.map((event) => event.data.ordinal), [1, 2])

            const recoveries = env.events.filter(RecoveryStarted.is)
            assert.equal(recoveries.length, 1)
            assert.deepEqual(recoveries[0].data, { attempt: 1, storyIds: ["S1"] })

            const savedPrd = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(savedPrd.userStories[0]?.passes, false)
            assert.equal(savedPrd.userStories[0]?.durationSecs, null)
        })
    })

    it("resets the progress budget when a replanned story passes and the run continues", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                replanProgressBudget: 1,
            })
            const env = joinWithCapture(conductor)
            const deliver = env.deliverSemanticEvent.bind(env)
            let persistedReplans = 0
            env.deliverSemanticEvent = (sourceParticipant, event) => {
                if (ReplanApplied.is(event)) {
                    const saved = JSON.parse(
                        readFileSync(prdPath, "utf8"),
                    ) as PrdFile
                    const savedIds = new Set(
                        saved.userStories.map((story) => story.id),
                    )
                    for (const story of event.data.addedStories) {
                        assert.equal(savedIds.has(story.id), true)
                    }
                    persistedReplans += 1
                }
                deliver(sourceParticipant, event)
            }

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )

            // Level 1: S1 fails, Surgeon replaces it with S2 → S3 chain.
            await waitForEvents(env.events, StorySpawnRequest.is, 1)
            env.deliverSemanticEvent(
                source("surgeon"),
                replanEvent("S1", [storyAdd("S2"), storyAdd("S3", ["S2"])]),
            )
            env.deliverSemanticEvent(source("S1"), failResult("S1"))

            // Level 2: S2 passes — budget (1) was fully consumed by the
            // first replan, so the run only survives if success resets it.
            const spawns2 = await waitForEvents(env.events, StorySpawnRequest.is, 2)
            assert.equal(spawns2[1].data.storyId, "S2")
            env.deliverSemanticEvent(source("S2"), passResult("S2"))

            // Level 3: S3 fails, Surgeon replaces it with S4.
            const spawns3 = await waitForEvents(env.events, StorySpawnRequest.is, 3)
            assert.equal(spawns3[2].data.storyId, "S3")
            env.deliverSemanticEvent(
                source("surgeon"),
                replanEvent("S3", [storyAdd("S4")]),
            )
            env.deliverSemanticEvent(source("S3"), failResult("S3"))

            // Level 4: S4 passes → clean completion despite two replans.
            const spawns4 = await waitForEvents(env.events, StorySpawnRequest.is, 4)
            assert.equal(spawns4[3].data.storyId, "S4")
            env.deliverSemanticEvent(source("S4"), passResult("S4"))

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, true)
            assert.equal(completed.data.abortReason, null)
            assert.deepEqual(completed.data.completedStories, ["S2", "S4"])
            assert.equal(persistedReplans, 2)
        })
    })

    it("applies a safe-boundary sibling replan batch as one recovery cycle", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const prd = oneStoryPrd()
            prd.userStories.push({
                ...prd.userStories[0]!,
                id: "S2",
                title: "Implement sibling coverage",
            })
            writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 2,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                replanProgressBudget: 1,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )
            const initialSpawns = await waitForEvents(
                env.events,
                StorySpawnRequest.is,
                2,
            )
            assert.deepEqual(
                initialSpawns.map((event) => event.data.storyId),
                ["S1", "S2"],
            )

            // Both failures belong to the same safe boundary. With the old
            // per-item halt, applying S1's replacement exhausted the budget,
            // discarded S2's already-drained sibling proposal, and stopped.
            env.deliverSemanticEvent(
                source("surgeon-S1"),
                replanEvent("S1", [storyAdd("S1-replacement")]),
            )
            env.deliverSemanticEvent(
                source("surgeon-S2"),
                replanEvent("S2", [storyAdd("S2-replacement")]),
            )
            env.deliverSemanticEvent(source("S1"), failResult("S1"))
            env.deliverSemanticEvent(source("S2"), failResult("S2"))

            const applied = await waitForEvents(env.events, ReplanApplied.is, 2)
            assert.deepEqual(
                applied.map((event) => event.data.addedStories[0]?.id),
                ["S1-replacement", "S2-replacement"],
            )
            assert.equal(
                env.events
                    .filter(ConductorState.is)
                    .filter(
                        (event) =>
                            event.data.detail === "replan 1/1 without progress",
                    ).length,
                1,
            )

            const persisted = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.deepEqual(
                persisted.userStories.map((story) => story.id),
                ["S1-replacement", "S2-replacement"],
            )

            const replacementSpawns = await waitForEvents(
                env.events,
                StorySpawnRequest.is,
                4,
            )
            assert.deepEqual(
                replacementSpawns.slice(2).map((event) => event.data.storyId),
                ["S1-replacement", "S2-replacement"],
            )
            env.deliverSemanticEvent(
                source("S1-replacement"),
                passResult("S1-replacement"),
            )
            env.deliverSemanticEvent(
                source("S2-replacement"),
                passResult("S2-replacement"),
            )

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, true)
            assert.equal(completed.data.abortReason, null)
        })
    })

    it("terminates gracefully when the progress budget is exhausted, without recovery", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                replanProgressBudget: 1,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )

            await waitForEvents(env.events, StorySpawnRequest.is, 1)
            env.deliverSemanticEvent(
                source("surgeon"),
                replanEvent("S1", [storyAdd("S2")]),
            )
            env.deliverSemanticEvent(source("S1"), failResult("S1"))

            const spawns = await waitForEvents(env.events, StorySpawnRequest.is, 2)
            assert.equal(spawns[1].data.storyId, "S2")
            env.deliverSemanticEvent(source("S2"), failResult("S2"))

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, false)
            assert.equal(
                completed.data.abortReason,
                "no progress after 1 replan — stopping so completed work can ship",
            )
            assert.deepEqual(completed.data.failedStories, ["S2"])
            assert.equal(env.events.filter(RecoveryStarted.is).length, 0)
            assert.equal(env.events.filter(StorySpawnRequest.is).length, 2)
            assert.ok(
                env.events
                    .filter(ConductorState.is)
                    .some((e) => e.data.detail === "replan 1/1 without progress"),
            )
        })
    })

    it("terminates gracefully at a level boundary when the soft deadline is exceeded", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const prd = oneStoryPrd()
            prd.userStories.push({
                ...prd.userStories[0],
                id: "S2",
                title: "Second story",
                dependsOn: ["S1"],
            })
            writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                softDeadlineSecs: 0.05,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )

            await waitForEvents(env.events, StorySpawnRequest.is, 1)
            // Let the deadline lapse mid-story; the check must only fire
            // at the level boundary, after S1's result lands.
            await new Promise((resolve) => setTimeout(resolve, 80))
            env.deliverSemanticEvent(source("S1"), passResult("S1"))

            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, false)
            assert.match(completed.data.abortReason ?? "", /soft deadline reached/)
            assert.deepEqual(completed.data.completedStories, ["S1"])
            // S2 was never spawned — the run stopped before the next level.
            assert.equal(env.events.filter(StorySpawnRequest.is).length, 1)
        })
    })

    it("budget 0 (via env) disables the progress budget", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const prevEnv = process.env.BARO_REPLAN_PROGRESS_BUDGET
            process.env.BARO_REPLAN_PROGRESS_BUDGET = "0"
            try {
                const conductor = new Conductor({
                    prdPath,
                    cwd: dir,
                    parallel: 1,
                    timeoutSecs: 45,
                    defaultModel: "sonnet",
                    intraLevelDelaySecs: 0,
                })
                const env = joinWithCapture(conductor)

                env.deliverSemanticEvent(
                    source("operator"),
                    RunStartRequest.create({ reason: "unit test" }),
                )

                // Four fruitless replans in a row — more than the default
                // budget of 3 — must not abort the run when disabled.
                let current = "S1"
                for (let i = 2; i <= 5; i += 1) {
                    const next = `S${i}`
                    const spawns = await waitForEvents(
                        env.events,
                        StorySpawnRequest.is,
                        i - 1,
                    )
                    assert.equal(spawns[i - 2].data.storyId, current)
                    env.deliverSemanticEvent(
                        source("surgeon"),
                        replanEvent(current, [storyAdd(next)]),
                    )
                    env.deliverSemanticEvent(source(current), failResult(current))
                    current = next
                }

                const spawns = await waitForEvents(env.events, StorySpawnRequest.is, 5)
                assert.equal(spawns[4].data.storyId, "S5")
                env.deliverSemanticEvent(source("S5"), passResult("S5"))

                const completed = await waitForEvent(env.events, RunCompleted.is)
                assert.equal(completed.data.success, true)
                assert.equal(completed.data.abortReason, null)
            } finally {
                if (prevEnv === undefined) {
                    delete process.env.BARO_REPLAN_PROGRESS_BUDGET
                } else {
                    process.env.BARO_REPLAN_PROGRESS_BUDGET = prevEnv
                }
            }
        })
    })

    it("emits only the effective persisted legacy replan delta", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const prd = oneStoryPrd()
            prd.userStories.push({
                ...prd.userStories[0]!,
                id: "S-done",
                title: "Already completed",
                passes: true,
                completedAt: new Date(0).toISOString(),
            })
            writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )
            await waitForEvents(env.events, StorySpawnRequest.is, 1)

            const validAddition = storyAdd("S2", ["S1"])
            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon",
                    reason: "mixed fresh and stale operations",
                    // S1 has passed by the time the level boundary applies
                    // this buffered mutation, so it cannot be removed.
                    removedStoryIds: ["S1"],
                    // The first addition duplicates another persisted story.
                    addedStories: [storyAdd("S-done"), validAddition],
                    modifiedDeps: {},
                }),
            )
            env.deliverSemanticEvent(source("S1"), passResult("S1"))

            const applied = await waitForEvent(env.events, ReplanApplied.is)
            assert.deepEqual(applied.data, {
                source: "surgeon",
                reason: "mixed fresh and stale operations",
                removedStoryIds: [],
                addedStories: [validAddition],
                modifiedDeps: {},
            })

            const persisted = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.deepEqual(
                persisted.userStories.map((story) => story.id),
                ["S1", "S-done", "S2"],
            )
            assert.equal(persisted.userStories[0]?.passes, true)

            const spawns = await waitForEvents(env.events, StorySpawnRequest.is, 2)
            assert.equal(spawns[1]?.data.storyId, "S2")
            env.deliverSemanticEvent(source("S2"), passResult("S2"))
            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, true)
        })
    })

    it("fails closed without mutating the live DAG when replan persistence fails", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                persistPrd: () => {
                    throw new Error("disk full")
                },
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )
            await waitForEvents(env.events, StorySpawnRequest.is, 1)
            env.deliverSemanticEvent(
                source("surgeon"),
                replanEvent("S1", [storyAdd("S2")]),
            )
            env.deliverSemanticEvent(source("S1"), failResult("S1"))

            const completed = await waitForEvent(env.events, RunCompleted.is)
            const summary = await conductor.done
            assert.equal(completed.data.success, false)
            assert.match(completed.data.abortReason ?? "", /persist replan.*disk full/)
            assert.equal(summary.abortReason, completed.data.abortReason)
            assert.equal(env.events.filter(ReplanApplied.is).length, 0)
            assert.equal(env.events.filter(StorySpawnRequest.is).length, 1)

            const persisted = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.deepEqual(
                persisted.userStories.map((story) => story.id),
                ["S1"],
            )
        })
    })

    it("fails closed before recording a pass when story persistence fails", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                persistPrd: () => {
                    throw new Error("read-only filesystem")
                },
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )
            await waitForEvents(env.events, StorySpawnRequest.is, 1)
            env.deliverSemanticEvent(source("S1"), passResult("S1"))

            const completed = await waitForEvent(env.events, RunCompleted.is)
            const summary = await conductor.done
            assert.equal(completed.data.success, false)
            assert.match(
                completed.data.abortReason ?? "",
                /persist story 'S1'.*read-only filesystem/,
            )
            assert.deepEqual(summary.completedStories, [])
            const persisted = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(persisted.userStories[0]?.passes, false)
        })
    })

    it("ignores malformed or invalid graph replans without spending healing budget", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(oneStoryPrd(), null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
                replanProgressBudget: 1,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )
            await waitForEvents(env.events, StorySpawnRequest.is, 1)

            const invalidProposals: unknown[] = [
                {
                    source: "surgeon",
                    reason: "malformed dependency array",
                    removedStoryIds: [],
                    addedStories: [
                        { ...storyAdd("S-malformed"), dependsOn: [42] },
                    ],
                    modifiedDeps: {},
                },
                {
                    source: "surgeon",
                    reason: "unknown added dependency",
                    removedStoryIds: [],
                    addedStories: [storyAdd("S-unknown-dep", ["S-missing"])],
                    modifiedDeps: {},
                },
                {
                    source: "surgeon",
                    reason: "unknown rewire target",
                    removedStoryIds: [],
                    addedStories: [],
                    modifiedDeps: { "S-missing": [] },
                },
                {
                    source: "surgeon",
                    reason: "introduce a cycle",
                    removedStoryIds: [],
                    addedStories: [storyAdd("S-cycle", ["S1"])],
                    modifiedDeps: { S1: ["S-cycle"] },
                },
                {
                    source: "surgeon",
                    reason: "replace one id in the same mutation",
                    removedStoryIds: ["S1"],
                    addedStories: [storyAdd("S1")],
                    modifiedDeps: {},
                },
            ]
            for (const proposal of invalidProposals) {
                env.deliverSemanticEvent(
                    source("surgeon"),
                    Replan.create(proposal as ReplanData),
                )
            }
            const validAddition = storyAdd("S2", ["S1"])
            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon",
                    reason: "valid follow-up after rejected proposals",
                    removedStoryIds: [],
                    addedStories: [validAddition],
                    modifiedDeps: {},
                }),
            )
            env.deliverSemanticEvent(source("S1"), passResult("S1"))

            const applied = await waitForEvent(env.events, ReplanApplied.is)
            assert.deepEqual(applied.data.addedStories, [validAddition])
            assert.equal(env.events.filter(ReplanApplied.is).length, 1)
            const ignored = env.events
                .filter(ConductorState.is)
                .map((event) => event.data.detail ?? "")
                .filter((detail) => detail.startsWith("replan ignored"))
            assert.equal(ignored.length, 5)
            assert.ok(ignored.some((detail) => detail.includes("invalid_proposal")))
            assert.ok(ignored.some((detail) => detail.includes("unknown_dependency")))
            assert.ok(ignored.some((detail) => detail.includes("unknown_story")))
            assert.ok(ignored.some((detail) => detail.includes("dependency_cycle")))
            assert.ok(ignored.some((detail) => detail.includes("duplicate_story")))

            const persisted = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.deepEqual(
                persisted.userStories.map((story) => story.id),
                ["S1", "S2"],
            )

            const spawns = await waitForEvents(env.events, StorySpawnRequest.is, 2)
            assert.equal(spawns[1]?.data.storyId, "S2")
            env.deliverSemanticEvent(source("S2"), passResult("S2"))
            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, true)
        })
    })

    it("does not let a duplicate addition mask an effective pure removal", async () => {
        await withTempDir("conductor-test-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const prd = oneStoryPrd()
            prd.userStories.push({
                ...prd.userStories[0]!,
                id: "S-done",
                title: "Already completed",
                passes: true,
                completedAt: new Date(0).toISOString(),
            })
            writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")

            const conductor = new Conductor({
                prdPath,
                cwd: dir,
                parallel: 1,
                timeoutSecs: 45,
                defaultModel: "sonnet",
                intraLevelDelaySecs: 0,
            })
            const env = joinWithCapture(conductor)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "unit test" }),
            )
            await waitForEvents(env.events, StorySpawnRequest.is, 1)
            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon",
                    reason: "attempt a disguised pure removal",
                    removedStoryIds: ["S1"],
                    addedStories: [storyAdd("S-done")],
                    modifiedDeps: {},
                }),
            )
            env.deliverSemanticEvent(source("S1"), failResult("S1"))

            const recoverySpawns = await waitForEvents(
                env.events,
                StorySpawnRequest.is,
                2,
            )
            assert.equal(recoverySpawns[1]?.data.storyId, "S1")
            assert.equal(env.events.filter(ReplanApplied.is).length, 0)
            assert.ok(
                env.events
                    .filter(ConductorState.is)
                    .some((event) =>
                        event.data.detail?.startsWith("skip proposal deferred"),
                    ),
            )
            const persisted = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.deepEqual(
                persisted.userStories.map((story) => story.id),
                ["S1", "S-done"],
            )

            env.deliverSemanticEvent(source("S1"), failResult("S1"))
            const completed = await waitForEvent(env.events, RunCompleted.is)
            assert.equal(completed.data.success, false)
        })
    })
})

function storyAdd(id: string, dependsOn: string[] = []): ReplanStoryAdd {
    return {
        id,
        priority: 1,
        title: `Replacement ${id}`,
        description: `Replacement story ${id}.`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} replacement behavior is observable`],
        tests: ["npm test"],
    }
}

function replanEvent(removedId: string, added: ReplanStoryAdd[]) {
    return Replan.create({
        source: "surgeon",
        reason: `replace ${removedId}`,
        addedStories: added,
        removedStoryIds: [removedId],
        modifiedDeps: {},
    })
}

function passResult(storyId: string) {
    return StoryResult.create({
        storyId,
        success: true,
        attempts: 1,
        durationSecs: 1,
        error: null,
    })
}

function failResult(storyId: string) {
    return StoryResult.create({
        storyId,
        success: false,
        attempts: 1,
        durationSecs: 1,
        error: "boom",
    })
}

function oneStoryPrd(): PrdFile {
    return {
        project: "Participant Tests",
        branchName: "participant-tests",
        description: "Exercise conductor semantic events.",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Implement conductor coverage",
                description: "Add a unit test for Conductor.",
                dependsOn: [],
                retries: 2,
                acceptance: ["Conductor emits lifecycle events"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: "opus",
            },
        ],
    }
}

async function waitForEvent<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const event = events.find(guard)
        if (event) return event
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.fail("timed out waiting for semantic event")
}

async function waitForEvents<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const found = events.filter(guard)
        if (found.length >= count) return found
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.fail("timed out waiting for semantic events")
}
