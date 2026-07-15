import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { AgenticEnvironment } from "@mozaik-ai/core"

import { orchestrate } from "../src/orchestrate.js"
import type { PlanningFeed } from "../src/participants/planning-feed.js"
import type {
    StoryExecution,
    StoryExecOpts,
    StoryExecutor,
} from "../src/participants/story-executor.js"
import type { PrdFile, PrdStory } from "../src/prd.js"
import type { StoryRoute } from "../src/routing.js"
import {
    StoryResult,
    type StorySpawnRequestData,
} from "../src/semantic-events.js"
import { withTempDir } from "./participants/helpers.js"

class GatedExecutor implements StoryExecutor {
    readonly started: string[] = []
    private startedResolve!: () => void
    private releaseResolve!: () => void
    readonly firstStarted = new Promise<void>((resolve) => {
        this.startedResolve = resolve
    })
    private readonly released = new Promise<void>((resolve) => {
        this.releaseResolve = resolve
    })

    release(): void {
        this.releaseResolve()
    }

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push(request.storyId)
        this.startedResolve()
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)
        void this.released.then(() => {
            environment.deliverSemanticEvent(
                resultSource,
                StoryResult.create({
                    runId: request.runId,
                    storyId: request.storyId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                    success: true,
                    attempts: 1,
                    durationSecs: 0,
                    error: null,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

describe("orchestrate progressive planning", () => {
    it("starts an admitted prefix before the final plan exists", async () => {
        await withTempDir("progressive-orchestrate-", async (dir) => {
            const runId = "run-progressive-e2e"
            const planningId = "planning-progressive-e2e"
            const prdPath = join(dir, "prd.json")
            const auditPath = join(dir, "audit.jsonl")
            const bootstrap = prd([])
            writeFileSync(prdPath, JSON.stringify(bootstrap, null, 2) + "\n")
            const executor = new GatedExecutor()
            let finalPublished = false
            let startedBeforeFinal = false

            const resultPromise = orchestrate({
                runId,
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                progressivePlanningId: planningId,
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withDialogue: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                auditLogPath: auditPath,
                onPlanningFeedReady: (feed) => {
                    open(feed, runId, planningId)
                    feed.fragment({
                        type: "plan_fragment",
                        run_id: runId,
                        planning_id: planningId,
                        fragment_id: "safe-prefix",
                        ordinal: 1,
                        stories: [story("S1")],
                    })
                    void executor.firstStarted.then(() => {
                        startedBeforeFinal = !finalPublished
                        finalPublished = true
                        feed.complete({
                            type: "plan_complete",
                            run_id: runId,
                            planning_id: planningId,
                            final_prd: prd([story("S1")]),
                        })
                        executor.release()
                    })
                },
            })

            const result = await resultPromise
            assert.equal(startedBeforeFinal, true)
            assert.equal(result.summary.success, true)
            assert.deepEqual(executor.started, ["S1"])
            const saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(saved.runtimeGraph?.planning?.status, "completed")
            assert.equal(saved.userStories[0]?.passes, true)

            const audit = readFileSync(auditPath, "utf8")
            const admittedAt = audit.indexOf('"type":"plan_fragment_admitted"')
            const closedAt = audit.indexOf('"type":"planning_stream_closed"')
            assert.ok(admittedAt >= 0)
            assert.ok(closedAt > admittedAt)
        })
    })

    it("keeps non-streaming planner backends working through the final-plan fallback", async () => {
        await withTempDir("progressive-full-plan-fallback-", async (dir) => {
            const runId = "run-progressive-fallback"
            const planningId = "planning-progressive-fallback"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(prd([]), null, 2) + "\n")
            const started: string[] = []

            const result = await orchestrate({
                runId,
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                progressivePlanningId: planningId,
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withDialogue: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor: {
                    start(request, _route, _cwd, environment, options) {
                        started.push(request.storyId)
                        const source = { agentId: request.storyId } as never
                        options.registerResultAuthority?.(source)
                        setImmediate(() => environment.deliverSemanticEvent(
                            source,
                            StoryResult.create({
                                runId: request.runId,
                                storyId: request.storyId,
                                leaseId: request.leaseId,
                                generation: request.generation,
                                success: true,
                                attempts: 1,
                                durationSecs: 0,
                                error: null,
                            }),
                        ))
                        return { dispose: () => {} }
                    },
                },
                onPlanningFeedReady: (feed) => {
                    open(feed, runId, planningId)
                    feed.complete({
                        type: "plan_complete",
                        run_id: runId,
                        planning_id: planningId,
                        final_prd: prd([
                            story("S1"),
                            story("S2", ["S1"]),
                        ]),
                    })
                },
            })

            assert.equal(result.summary.success, true)
            assert.deepEqual(started, ["S1", "S2"])
        })
    })
})

function open(feed: PlanningFeed, runId: string, planningId: string): void {
    feed.open({
        type: "planning_open",
        run_id: runId,
        planning_id: planningId,
    })
}

function prd(stories: PrdStory[]): PrdFile {
    return {
        project: "progressive-e2e",
        branchName: "baro/progressive-e2e",
        description: "Exercise the progressive orchestration boundary.",
        decisionDocument: "Keep the progressive protocol additive.",
        executionMode: {
            mode: "parallel",
            reason: "A safe prefix can begin before the final tail exists.",
            maxStories: 8,
            source: "contract",
        },
        userStories: stories,
    }
}

function story(id: string, dependsOn: string[] = []): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")) || 1,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn,
        retries: 2,
        acceptance: [`${id} is observable`],
        tests: [`npm test -- ${id}`],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
    }
}
