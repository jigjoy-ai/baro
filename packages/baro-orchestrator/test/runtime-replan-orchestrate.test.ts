import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    BaseObserver,
    type AgenticEnvironment,
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

import { orchestrate } from "../src/orchestrate.js"
import type {
    StoryExecution,
    StoryExecOpts,
    StoryExecutor,
} from "../src/participants/story-executor.js"
import type { PrdFile } from "../src/prd.js"
import type { StoryRoute } from "../src/routing.js"
import {
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    StoryResult,
    type StorySpawnRequestData,
} from "../src/semantic-events.js"
import { withTempDir } from "./participants/helpers.js"

class RuntimeAdaptingExecutor extends BaseObserver implements StoryExecutor {
    readonly started: Array<{ storyId: string; graphVersion?: number }> = []
    private pendingS1:
        | { request: StorySpawnRequestData; environment: AgenticEnvironment }
        | null = null

    get agentId(): string {
        return "runtime-adapting-executor"
    }

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push({
            storyId: request.storyId,
            graphVersion: request.graphVersion,
        })
        options.registerResultAuthority?.(this)

        if (request.storyId === "S1") {
            this.pendingS1 = { request, environment }
            setImmediate(() => {
                environment.deliverSemanticEvent(
                    this,
                    RuntimeReplanProposed.create({
                        runId: request.runId!,
                        proposalId: "e2e-add-S2",
                        sourceStoryId: "S1",
                        leaseId: request.leaseId!,
                        generation: request.generation!,
                        baseGraphVersion: request.graphVersion!,
                        reason: "repository exploration found a required follow-up",
                        mutation: {
                            addedStories: [
                                {
                                    id: "S2",
                                    priority: 2,
                                    title: "Implement discovered follow-up",
                                    description: "Finish the API surface discovered by S1.",
                                    dependsOn: ["S1"],
                                    retries: 1,
                                    acceptance: ["follow-up is integrated"],
                                    tests: [],
                                    model: "standard",
                                },
                            ],
                            removedStoryIds: [],
                            modifiedDeps: {},
                        },
                    }),
                )
            })
        } else {
            setImmediate(() => this.finish(request, environment))
        }
        return { dispose: () => {} }
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (
            RuntimeReplanApplied.is(event) &&
            event.data.proposalId === "e2e-add-S2" &&
            this.pendingS1
        ) {
            const pending = this.pendingS1
            this.pendingS1 = null
            setImmediate(() => this.finish(pending.request, pending.environment))
        }
    }

    private finish(
        request: StorySpawnRequestData,
        environment: AgenticEnvironment,
    ): void {
        environment.deliverSemanticEvent(
            this,
            StoryResult.create({
                runId: request.runId,
                storyId: request.storyId,
                leaseId: request.leaseId,
                generation: request.generation,
                success: true,
                attempts: 1,
                durationSecs: 1,
                error: null,
            }),
        )
    }
}

describe("runtime DAG adaptation orchestration", () => {
    it("runs Proposed → Applied → newly offered work exactly once", async () => {
        await withTempDir("runtime-replan-e2e-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const auditPath = join(dir, "audit.jsonl")
            writeFileSync(
                prdPath,
                JSON.stringify(initialPrd(), null, 2) + "\n",
            )
            const executor = new RuntimeAdaptingExecutor()

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                extraParticipants: [executor],
                auditLogPath: auditPath,
            })

            assert.equal(result.summary.success, true)
            assert.deepEqual(result.summary.completedStories, ["S1", "S2"])
            assert.deepEqual(executor.started, [
                { storyId: "S1", graphVersion: 1 },
                { storyId: "S2", graphVersion: 2 },
            ])
            const saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.deepEqual(saved.userStories.map((story) => [story.id, story.passes]), [
                ["S1", true],
                ["S2", true],
            ])

            const events = readFileSync(auditPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as {
                    item: {
                        type: string
                        data?: { request?: { storyId?: string } }
                    }
                })
            const proposedIndex = events.findIndex(
                (event) => event.item.type === "runtime_replan_proposed",
            )
            const appliedIndex = events.findIndex(
                (event) => event.item.type === "runtime_replan_applied",
            )
            const newOfferIndex = events.findIndex(
                (event) =>
                    event.item.type === "work_offered" &&
                    event.item.data?.request?.storyId === "S2",
            )
            assert.ok(proposedIndex >= 0)
            assert.ok(appliedIndex > proposedIndex)
            assert.ok(newOfferIndex > appliedIndex)
            assert.equal(
                events.filter(
                    (event) =>
                        event.item.type === "work_offered" &&
                        event.item.data?.request?.storyId === "S2",
                ).length,
                1,
            )
        })
    })
})

function initialPrd(): PrdFile {
    return {
        project: "runtime-replan-e2e",
        branchName: "baro/runtime-replan-e2e",
        description: "Start with one story and discover the second at runtime.",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Explore and implement the entry point",
                description: "Implement the initial surface and inspect follow-up needs.",
                dependsOn: [],
                retries: 1,
                acceptance: ["entry point works"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: "standard",
            },
        ],
    }
}
