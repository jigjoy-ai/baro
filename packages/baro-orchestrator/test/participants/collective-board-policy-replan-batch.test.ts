import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { PrdFile, PrdStory } from "../../src/prd.js"
import { CollectiveBoard } from "../../src/participants/collective-board.js"
import {
    ConductorState,
    RecoveryDecision,
    Replan,
    RunPrepared,
    RunPushRequested,
    RunStartRequest,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    StoryIntegrationRequested,
    StoryMerged,
    StoryResult,
    WorkContextProvided,
    WorkContextRequested,
    WorkLeaseGranted,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
    type ReplanData,
} from "../../src/semantic-events.js"
import {
    joinWithCapture,
    source,
    type CapturedEnvironment,
    withTempDir,
} from "./helpers.js"

describe("CollectiveBoard policy replan batching", () => {
    it("reserves unique ids for concurrent Surgeon replacements at the safe boundary", async () => {
        await withTempDir("collective-policy-id-reservation-", async (dir) => {
            const runId = "run-policy-id-reservation"
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Concurrent policy ids",
                    branchName: "baro/policy-ids",
                    description: "Exercise concurrent Surgeon allocations.",
                    userStories: [story("S6", 1, []), story("S7", 2, [])],
                } satisfies PrdFile, null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId, baseSha: null }),
            )
            const contexts = await waitForCount(
                env.events,
                WorkContextRequested.is,
                2,
            )
            for (const request of contexts) provideContext(env, runId, request)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)

            for (const [index, offer] of offers.entries()) {
                const storyId = offer.data.request.storyId
                const leaseId = `lease-${storyId}`
                env.deliverSemanticEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId,
                        offerId: offer.data.offerId,
                        leaseId,
                        workerId: `worker-${storyId}`,
                        generation: offer.data.generation,
                        request: offer.data.request,
                    }),
                )
                env.deliverSemanticEvent(
                    source(`worker-${storyId}`),
                    result(
                        runId,
                        storyId,
                        leaseId,
                        offer.data.generation,
                        false,
                    ),
                )
                const cleanup = (
                    await waitForCount(
                        env.events,
                        WorkspaceCleanupRequested.is,
                        index + 1,
                    )
                )[index]!
                env.deliverSemanticEvent(
                    source("surgeon"),
                    Replan.create({
                        source: `surgeon:${storyId}`,
                        reason: `split ${storyId} at a stable boundary`,
                        recovery: {
                            runId,
                            storyId,
                            leaseId,
                            generation: offer.data.generation,
                        },
                        addedStories: [
                            replacement("S14", []),
                            {
                                ...replacement("S15", ["S14"]),
                                description:
                                    "Complete S15 after the focused S14 prerequisite.",
                            },
                        ],
                        removedStoryIds: [storyId],
                        modifiedDeps: {},
                    }),
                )
                env.deliverSemanticEvent(
                    source("surgeon"),
                    RecoveryDecision.create({
                        runId,
                        storyId,
                        source: `surgeon:${storyId}`,
                        action: "replan",
                        reason: `split ${storyId} at a stable boundary`,
                    }),
                )
                env.deliverSemanticEvent(
                    source("repo"),
                    WorkspaceCleanupCompleted.create({ ...cleanup.data }),
                )
            }

            const applied = await waitForCount(
                env.events,
                RuntimeReplanApplied.is,
                2,
            )
            assert.deepEqual(
                applied.map((event) =>
                    event.data.mutation.addedStories.map((item) => item.id),
                ),
                [["S14", "S15"], ["S16", "S17"]],
            )
            assert.deepEqual(
                applied[1]?.data.mutation.addedStories[1]?.dependsOn,
                ["S16"],
            )
            assert.match(
                applied[1]?.data.mutation.addedStories[1]?.description ?? "",
                /Complete S15 after the focused S14 prerequisite/,
            )
            assert.match(
                applied[1]?.data.mutation.addedStories[1]?.description ?? "",
                /\[\["S14","S16"\],\["S15","S17"\]\]/,
            )
            assert.match(
                applied[1]?.data.reason ?? "",
                /\[\["S14","S16"\],\["S15","S17"\]\]/,
            )
            assert.equal(env.events.some(RuntimeReplanRejected.is), false)

            const persisted = readPrd(prdPath)
            assert.deepEqual(
                persisted.userStories.map((item) => item.id),
                ["S14", "S15", "S16", "S17"],
            )
        })
    })

    it("rejects every sibling writer of one existing story while preserving independent work", async () => {
        await withTempDir("collective-policy-write-conflict-", async (dir) => {
            const runId = "run-policy-write-conflict"
            const prdPath = join(dir, "prd.json")
            const surgeon = source("surgeon")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Sibling write conflicts",
                    branchName: "baro/policy-write-conflict",
                    description: "Reject order-dependent policy writes.",
                    userStories: [
                        story("S1", 1, []),
                        story("S2", 2, []),
                        story("S4", 3, []),
                        story("D", 4, ["S1", "S2"]),
                    ],
                } satisfies PrdFile, null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                recoveryAuthority: surgeon,
                maxRecoveryAttemptsPerStory: 0,
            })
            const env = joinWithCapture(board)
            const offers = await startAndLeaseInitialWave(env, runId, 3)
            const byStory = new Map(
                offers.map((offer) => [offer.data.request.storyId, offer]),
            )
            const replans: Record<string, ReplanData> = {
                S1: {
                    source: "surgeon:S1",
                    reason: "replace S1 and rewire D",
                    recovery: recovery(runId, "S1", byStory.get("S1")!),
                    addedStories: [replacement("R1", [])],
                    removedStoryIds: ["S1"],
                    modifiedDeps: { D: ["R1", "S2"] },
                },
                S2: {
                    source: "surgeon:S2",
                    reason: "replace S2 and rewire D",
                    recovery: recovery(runId, "S2", byStory.get("S2")!),
                    addedStories: [replacement("R2", [])],
                    removedStoryIds: ["S2"],
                    modifiedDeps: { D: ["S1", "R2"] },
                },
                S4: {
                    source: "surgeon:S4",
                    reason: "independently replace S4",
                    recovery: recovery(runId, "S4", byStory.get("S4")!),
                    addedStories: [replacement("R4", [])],
                    removedStoryIds: ["S4"],
                    modifiedDeps: {},
                },
            }

            for (const [index, storyId] of ["S1", "S2", "S4"].entries()) {
                await failWithPolicyReplan(
                    env,
                    runId,
                    byStory.get(storyId)!,
                    replans[storyId]!,
                    index + 1,
                    surgeon,
                )
            }

            const rejected = await waitForCount(
                env.events,
                RuntimeReplanRejected.is,
                2,
            )
            const applied = await waitFor(
                env.events,
                RuntimeReplanApplied.is,
            )
            await board.idle()

            assert.deepEqual(
                rejected.map((event) => event.data.sourceStoryId).sort(),
                ["S1", "S2"],
            )
            assert.ok(
                rejected.every(
                    (event) =>
                        event.data.code === "invalid_proposal" &&
                        /sibling conflict.*"D"/.test(event.data.reason),
                ),
            )
            assert.equal(applied.data.sourceStoryId, "S4")
            assert.deepEqual(
                applied.data.mutation.addedStories.map((item) => item.id),
                ["R4"],
            )
            const persisted = readPrd(prdPath)
            assert.deepEqual(
                persisted.userStories.map((item) => item.id),
                ["S1", "S2", "D", "R4"],
            )
            assert.deepEqual(
                persisted.userStories.find((item) => item.id === "D")?.dependsOn,
                ["S1", "S2"],
            )
        })
    })

    it("rejects cross-proposal dependency cycles in either delivery order", async () => {
        const outcomes: Array<{
            stories: Array<{ id: string; dependsOn: string[] }>
            rejected: Array<{ storyId: string; reason: string }>
            applied: string[]
        }> = []

        for (const order of [
            ["A", "B", "C"],
            ["B", "A", "C"],
        ] as const) {
            await withTempDir(
                `collective-policy-cycle-${order.join("").toLowerCase()}-`,
                async (dir) => {
                    const runId = "run-policy-cycle-order"
                    const prdPath = join(dir, "prd.json")
                    const surgeon = source("surgeon")
                    writeFileSync(
                        prdPath,
                        JSON.stringify({
                            project: "Sibling dependency cycles",
                            branchName: "baro/policy-cycle-order",
                            description:
                                "Reject a cycle composed at one safe boundary.",
                            userStories: [
                                story("A", 1, []),
                                story("B", 2, []),
                                story("C", 3, []),
                            ],
                        } satisfies PrdFile, null, 2) + "\n",
                    )
                    const board = new CollectiveBoard({
                        runId,
                        prdPath,
                        cwd: dir,
                        timeoutSecs: 60,
                        expectRecoveryDecisions: true,
                        recoveryAuthority: surgeon,
                        maxRecoveryAttemptsPerStory: 0,
                    })
                    const env = joinWithCapture(board)
                    const offers = await startAndLeaseInitialWave(env, runId, 3)
                    const byStory = new Map(
                        offers.map((offer) => [
                            offer.data.request.storyId,
                            offer,
                        ]),
                    )
                    const replans: Record<"A" | "B" | "C", ReplanData> = {
                        A: {
                            source: "surgeon:A",
                            reason: "make A wait for B",
                            recovery: recovery(runId, "A", byStory.get("A")!),
                            addedStories: [],
                            removedStoryIds: [],
                            modifiedDeps: { A: ["B"] },
                        },
                        B: {
                            source: "surgeon:B",
                            reason: "make B wait for A",
                            recovery: recovery(runId, "B", byStory.get("B")!),
                            addedStories: [],
                            removedStoryIds: [],
                            modifiedDeps: { B: ["A"] },
                        },
                        C: {
                            source: "surgeon:C",
                            reason: "independently replace C",
                            recovery: recovery(runId, "C", byStory.get("C")!),
                            addedStories: [replacement("RC", [])],
                            removedStoryIds: ["C"],
                            modifiedDeps: {},
                        },
                    }

                    for (const [index, storyId] of order.entries()) {
                        await failWithPolicyReplan(
                            env,
                            runId,
                            byStory.get(storyId)!,
                            replans[storyId],
                            index + 1,
                            surgeon,
                        )
                    }

                    const rejected = await waitForCount(
                        env.events,
                        RuntimeReplanRejected.is,
                        2,
                    )
                    const applied = await waitForCount(
                        env.events,
                        RuntimeReplanApplied.is,
                        1,
                    )
                    await board.idle()
                    outcomes.push({
                        stories: readPrd(prdPath).userStories.map((item) => ({
                            id: item.id,
                            dependsOn: [...item.dependsOn],
                        })),
                        rejected: rejected
                            .map((event) => ({
                                storyId: event.data.sourceStoryId,
                                reason: event.data.reason,
                            }))
                            .sort((left, right) =>
                                left.storyId.localeCompare(right.storyId),
                            ),
                        applied: applied.map(
                            (event) => event.data.sourceStoryId,
                        ),
                    })
                },
            )
        }

        assert.deepEqual(outcomes[1], outcomes[0])
        assert.deepEqual(
            outcomes[0]?.rejected.map((entry) => entry.storyId),
            ["A", "B"],
        )
        assert.ok(
            outcomes[0]?.rejected.every((entry) =>
                /sibling dependency cycle.*\["A","B"\]/.test(entry.reason),
            ),
        )
        assert.deepEqual(outcomes[0]?.applied, ["C"])
        assert.deepEqual(outcomes[0]?.stories, [
            { id: "A", dependsOn: [] },
            { id: "B", dependsOn: [] },
            { id: "RC", dependsOn: [] },
        ])
    })

    it("rejects removal-versus-dependency siblings identically in both delivery orders", async () => {
        const outcomes: Array<{
            stories: Array<{ id: string; dependsOn: string[] }>
            decisions: Array<{
                sourceStoryId: string
                code: string
                reason: string
                baseGraphVersion: number
                currentGraphVersion: number
            }>
            applied: number
        }> = []

        for (const order of [
            ["A", "B"],
            ["B", "A"],
        ] as const) {
            await withTempDir(
                `collective-policy-read-write-${order.join("").toLowerCase()}-`,
                async (dir) => {
                    const runId = "run-policy-read-write-order"
                    const prdPath = join(dir, "prd.json")
                    const surgeon = source("surgeon")
                    writeFileSync(
                        prdPath,
                        JSON.stringify({
                            project: "Sibling read/write isolation",
                            branchName: "baro/policy-read-write-isolation",
                            description:
                                "Removal must not race a sibling dependency read.",
                            userStories: [
                                story("A", 1, []),
                                story("B", 2, []),
                                story("S1", 3, ["A"]),
                            ],
                        } satisfies PrdFile, null, 2) + "\n",
                    )
                    const board = new CollectiveBoard({
                        runId,
                        prdPath,
                        cwd: dir,
                        timeoutSecs: 60,
                        expectRecoveryDecisions: true,
                        recoveryAuthority: surgeon,
                        maxRecoveryAttemptsPerStory: 0,
                    })
                    const env = joinWithCapture(board)
                    const offers = await startAndLeaseInitialWave(env, runId, 2)
                    const byStory = new Map(
                        offers.map((offer) => [
                            offer.data.request.storyId,
                            offer,
                        ]),
                    )
                    const replans: Record<"A" | "B", ReplanData> = {
                        A: {
                            source: "surgeon:A",
                            reason: "replace existing S1",
                            recovery: recovery(runId, "A", byStory.get("A")!),
                            addedStories: [replacement("RS1", [])],
                            removedStoryIds: ["S1"],
                            modifiedDeps: {},
                        },
                        B: {
                            source: "surgeon:B",
                            reason: "replace B with work that still depends on S1",
                            recovery: recovery(runId, "B", byStory.get("B")!),
                            addedStories: [replacement("RB", ["S1"])],
                            removedStoryIds: ["B"],
                            modifiedDeps: {},
                        },
                    }

                    for (const [index, storyId] of order.entries()) {
                        await failWithPolicyReplan(
                            env,
                            runId,
                            byStory.get(storyId)!,
                            replans[storyId],
                            index + 1,
                            surgeon,
                        )
                    }

                    const rejected = await waitForCount(
                        env.events,
                        RuntimeReplanRejected.is,
                        2,
                    )
                    await waitFor(env.events, RunPushRequested.is)
                    await board.idle()
                    const persisted = readPrd(prdPath)
                    outcomes.push({
                        stories: persisted.userStories.map((item) => ({
                            id: item.id,
                            dependsOn: [...item.dependsOn],
                        })),
                        decisions: rejected
                            .map((event) => ({
                                sourceStoryId: event.data.sourceStoryId,
                                code: event.data.code,
                                reason: event.data.reason,
                                baseGraphVersion: event.data.baseGraphVersion,
                                currentGraphVersion:
                                    event.data.currentGraphVersion,
                            }))
                            .sort((left, right) =>
                                left.sourceStoryId.localeCompare(
                                    right.sourceStoryId,
                                ),
                            ),
                        applied: env.events.filter(RuntimeReplanApplied.is)
                            .length,
                    })
                },
            )
        }

        assert.equal(outcomes.length, 2)
        assert.deepEqual(outcomes[1], outcomes[0])
        assert.equal(outcomes[0]?.applied, 0)
        assert.deepEqual(
            outcomes[0]?.decisions.map((decision) => decision.sourceStoryId),
            ["A", "B"],
        )
        assert.ok(
            outcomes[0]?.decisions.every(
                (decision) =>
                    decision.code === "invalid_proposal" &&
                    /sibling conflict.*\["S1"\]/.test(decision.reason),
            ),
        )
    })

    it("rejects raw sibling cross-coupling before an earlier sibling can legalize it", async () => {
        await withTempDir("collective-policy-cross-coupling-", async (dir) => {
            const runId = "run-policy-cross-coupling"
            const prdPath = join(dir, "prd.json")
            const surgeon = source("surgeon")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Sibling isolation",
                    branchName: "baro/policy-sibling-isolation",
                    description: "Keep independent Surgeon snapshots isolated.",
                    userStories: [story("S6", 1, []), story("S7", 2, [])],
                } satisfies PrdFile, null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                recoveryAuthority: surgeon,
                maxRecoveryAttemptsPerStory: 0,
            })
            const env = joinWithCapture(board)
            const offers = await startAndLeaseInitialWave(env, runId, 2)
            const byStory = new Map(
                offers.map((offer) => [offer.data.request.storyId, offer]),
            )
            const first: ReplanData = {
                source: "surgeon:S6",
                reason: "replace S6 with S14",
                recovery: recovery(runId, "S6", byStory.get("S6")!),
                addedStories: [replacement("S14", [])],
                removedStoryIds: ["S6"],
                modifiedDeps: {},
            }
            const crossCoupled: ReplanData = {
                source: "surgeon:S7",
                reason: "incorrectly target a sibling's predicted S14",
                recovery: recovery(runId, "S7", byStory.get("S7")!),
                addedStories: [replacement("S20", [])],
                removedStoryIds: ["S7", "S14"],
                modifiedDeps: {},
            }

            await failWithPolicyReplan(
                env,
                runId,
                byStory.get("S6")!,
                first,
                1,
                surgeon,
            )
            await failWithPolicyReplan(
                env,
                runId,
                byStory.get("S7")!,
                crossCoupled,
                2,
                surgeon,
            )

            const rejection = await waitFor(
                env.events,
                RuntimeReplanRejected.is,
            )
            const applied = await waitFor(
                env.events,
                RuntimeReplanApplied.is,
            )
            await board.idle()

            assert.equal(rejection.data.sourceStoryId, "S7")
            assert.equal(rejection.data.code, "unknown_story")
            assert.match(rejection.data.reason, /unknown story 'S14'/)
            assert.equal(applied.data.sourceStoryId, "S6")
            const persisted = readPrd(prdPath)
            assert.deepEqual(
                persisted.userStories.map((item) => item.id),
                ["S7", "S14"],
            )
        })
    })

    it("rejects a malformed authorized Replan without failing the Board", async () => {
        await withTempDir("collective-policy-malformed-", async (dir) => {
            const runId = "run-policy-malformed"
            const prdPath = join(dir, "prd.json")
            const surgeon = source("authorized-surgeon")
            writeFileSync(
                prdPath,
                JSON.stringify(singleStoryPrd("S1"), null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                recoveryAuthority: surgeon,
                maxRecoveryAttemptsPerStory: 0,
            })
            const env = joinWithCapture(board)
            const [offer] = await startAndLeaseInitialWave(env, runId, 1)
            const malformed = {
                source: "surgeon:S1",
                reason: "provider returned a malformed added field",
                recovery: recovery(runId, "S1", offer!),
                addedStories: "not-an-array",
                removedStoryIds: [],
                modifiedDeps: {},
            } as unknown as ReplanData

            await failWithPolicyReplan(
                env,
                runId,
                offer!,
                malformed,
                1,
                surgeon,
            )

            const rejection = await waitFor(
                env.events,
                RuntimeReplanRejected.is,
            )
            await waitFor(env.events, RunPushRequested.is)
            await board.idle()

            assert.equal(rejection.data.sourceStoryId, "S1")
            assert.equal(rejection.data.code, "invalid_proposal")
            assert.match(rejection.data.reason, /mutation is malformed/)
            assert.equal(
                env.events
                    .filter(ConductorState.is)
                    .some((event) =>
                        /collective board failed/.test(event.data.detail ?? ""),
                    ),
                false,
            )
        })
    })

    it("rejects invalid-only recovery after the healing budget is exhausted", async () => {
        await withTempDir("collective-policy-invalid-exhausted-", async (dir) => {
            const runId = "run-policy-invalid-exhausted"
            const prdPath = join(dir, "prd.json")
            const surgeon = source("surgeon")
            writeFileSync(
                prdPath,
                JSON.stringify(singleStoryPrd("S1"), null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                recoveryAuthority: surgeon,
                replanProgressBudget: 1,
            })
            const env = joinWithCapture(board)
            const [firstOffer] = await startAndLeaseInitialWave(env, runId, 1)
            const replacementReplan: ReplanData = {
                source: "surgeon:S1",
                reason: "replace S1 with S2",
                recovery: recovery(runId, "S1", firstOffer!),
                addedStories: [replacement("S2", [])],
                removedStoryIds: ["S1"],
                modifiedDeps: {},
            }
            await failWithPolicyReplan(
                env,
                runId,
                firstOffer!,
                replacementReplan,
                1,
                surgeon,
            )
            await waitFor(env.events, RuntimeReplanApplied.is)

            const contexts = await waitForCount(
                env.events,
                WorkContextRequested.is,
                2,
            )
            provideContext(env, runId, contexts[1]!)
            const offers = await waitForCount(env.events, WorkOffered.is, 2)
            const secondOffer = offers.find(
                (offer) => offer.data.request.storyId === "S2",
            )!
            grantOffer(env, runId, secondOffer)
            const invalidOnly: ReplanData = {
                source: "surgeon:S2",
                reason: "drop S2 without replacement",
                recovery: recovery(runId, "S2", secondOffer),
                addedStories: [],
                removedStoryIds: ["S2"],
                modifiedDeps: {},
            }
            await failWithPolicyReplan(
                env,
                runId,
                secondOffer,
                invalidOnly,
                2,
                surgeon,
            )

            const rejection = await waitFor(
                env.events,
                RuntimeReplanRejected.is,
            )
            await waitFor(env.events, RunPushRequested.is)
            await board.idle()

            assert.equal(rejection.data.sourceStoryId, "S2")
            assert.equal(rejection.data.code, "destructive_removal")
            assert.equal(
                env.events.filter(RuntimeReplanApplied.is).length,
                1,
            )
            const healingEvents = env.events
                .filter(ConductorState.is)
                .filter((event) => /healing action/.test(event.data.detail ?? ""))
            assert.equal(healingEvents.length, 1)
            assert.match(healingEvents[0]?.data.detail ?? "", /1\/1/)
        })
    })

    it("publishes a structured rejection for an invalid policy mutation", async () => {
        await withTempDir("collective-policy-rejection-", async (dir) => {
            const runId = "run-policy-rejection"
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify(singleStoryPrd("S1"), null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId, baseSha: null }),
            )
            const context = await waitFor(env.events, WorkContextRequested.is)
            provideContext(env, runId, context)
            const offer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: offer.data.offerId,
                    leaseId: "lease-S1",
                    workerId: "worker-S1",
                    generation: offer.data.generation,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("worker-S1"),
                result(
                    runId,
                    "S1",
                    "lease-S1",
                    offer.data.generation,
                    false,
                ),
            )
            const cleanup = await waitFor(
                env.events,
                WorkspaceCleanupRequested.is,
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon:S1",
                    reason: "drop failed scope without replacement",
                    recovery: {
                        runId,
                        storyId: "S1",
                        leaseId: "lease-S1",
                        generation: offer.data.generation,
                    },
                    addedStories: [],
                    removedStoryIds: ["S1"],
                    modifiedDeps: {},
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                RecoveryDecision.create({
                    runId,
                    storyId: "S1",
                    source: "surgeon:S1",
                    action: "replan",
                    reason: "drop failed scope without replacement",
                }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({ ...cleanup.data }),
            )

            const rejection = await waitFor(
                env.events,
                RuntimeReplanRejected.is,
            )
            assert.equal(rejection.data.sourceStoryId, "S1")
            assert.equal(rejection.data.code, "destructive_removal")
            assert.match(rejection.data.reason, /without adding replacement/)
        })
    })

    it("applies four sibling rewires as one healing cycle and schedules their prerequisite", async () => {
        await withTempDir("collective-policy-batch-", async (dir) => {
            const runId = "run-policy-batch"
            const prdPath = join(dir, "prd.json")
            const siblingIds = ["S6", "S7", "S8", "S9"]
            writeFileSync(
                prdPath,
                JSON.stringify(siblingRewirePrd(siblingIds), null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                replanProgressBudget: 3,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId, baseSha: null }),
            )

            const firstWaveContexts = await waitForCount(
                env.events,
                WorkContextRequested.is,
                5,
            )
            for (const request of firstWaveContexts) {
                provideContext(env, runId, request)
            }
            const firstWaveOffers = await waitForCount(
                env.events,
                WorkOffered.is,
                5,
            )
            const offersByStory = new Map(
                firstWaveOffers.map((offer) => [
                    offer.data.request.storyId,
                    offer,
                ]),
            )
            for (const offer of firstWaveOffers) {
                const storyId = offer.data.request.storyId
                env.deliverSemanticEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId,
                        offerId: offer.data.offerId,
                        leaseId: `lease-${storyId}`,
                        workerId: `worker-${storyId}`,
                        generation: offer.data.generation,
                        request: offer.data.request,
                    }),
                )
            }

            const prerequisite = offersByStory.get("S10")!
            env.deliverSemanticEvent(
                source("worker-S10"),
                result(
                    runId,
                    "S10",
                    "lease-S10",
                    prerequisite.data.generation,
                    true,
                ),
            )
            await waitFor(env.events, StoryIntegrationRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    runId,
                    storyId: "S10",
                    leaseId: "lease-S10",
                    mode: "worktree",
                }),
            )

            // Continuous scheduling admits S11 as soon as S10 integrates;
            // unrelated failing siblings no longer impose a wave barrier.
            const prerequisiteContext = (
                await waitForCount(env.events, WorkContextRequested.is, 6)
            )[5]!
            assert.equal(prerequisiteContext.data.storyId, "S11")
            provideContext(env, runId, prerequisiteContext)
            const prerequisiteOffer = (
                await waitForCount(env.events, WorkOffered.is, 6)
            )[5]!
            assert.equal(prerequisiteOffer.data.request.storyId, "S11")
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: prerequisiteOffer.data.offerId,
                    leaseId: "lease-S11",
                    workerId: "worker-S11",
                    generation: prerequisiteOffer.data.generation,
                    request: prerequisiteOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("worker-S11"),
                result(
                    runId,
                    "S11",
                    "lease-S11",
                    prerequisiteOffer.data.generation,
                    true,
                ),
            )
            const integrations = await waitForCount(
                env.events,
                StoryIntegrationRequested.is,
                2,
            )
            assert.equal(integrations[1]?.data.storyId, "S11")
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    runId,
                    storyId: "S11",
                    leaseId: "lease-S11",
                    mode: "worktree",
                }),
            )

            for (const [index, storyId] of siblingIds.entries()) {
                const offer = offersByStory.get(storyId)!
                const leaseId = `lease-${storyId}`
                env.deliverSemanticEvent(
                    source(`worker-${storyId}`),
                    result(
                        runId,
                        storyId,
                        leaseId,
                        offer.data.generation,
                        false,
                    ),
                )
                const cleanup = (
                    await waitForCount(
                        env.events,
                        WorkspaceCleanupRequested.is,
                        index + 1,
                    )
                )[index]!
                env.deliverSemanticEvent(
                    source("surgeon"),
                    Replan.create({
                        source: `surgeon:${storyId}`,
                        reason: `${storyId} requires the iterator prerequisite`,
                        recovery: {
                            runId,
                            storyId,
                            leaseId,
                            generation: offer.data.generation,
                        },
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: { [storyId]: ["S11"] },
                    }),
                )
                env.deliverSemanticEvent(
                    source("surgeon"),
                    RecoveryDecision.create({
                        runId,
                        storyId,
                        source: `surgeon:${storyId}`,
                        action: "replan",
                        reason: `${storyId} requires the iterator prerequisite`,
                    }),
                )
                env.deliverSemanticEvent(
                    source("repo"),
                    WorkspaceCleanupCompleted.create({ ...cleanup.data }),
                )
            }

            const applied = await waitForCount(
                env.events,
                RuntimeReplanApplied.is,
                4,
            )
            assert.deepEqual(
                applied.map((event) => event.data.graphVersion),
                [2, 3, 4, 5],
            )

            const persisted = readPrd(prdPath)
            for (const storyId of siblingIds) {
                assert.deepEqual(
                    persisted.userStories.find((story) => story.id === storyId)
                        ?.dependsOn,
                    ["S11"],
                )
            }

            const healingEvents = env.events
                .filter(ConductorState.is)
                .filter((event) => /healing action/.test(event.data.detail ?? ""))
            assert.equal(healingEvents.length, 2)
            assert.match(healingEvents[0]?.data.detail ?? "", /1\/3/)
            assert.match(healingEvents[1]?.data.detail ?? "", /2\/3/)
            assert.equal(env.events.some(RunPushRequested.is), false)
        })
    })

    it("admits a policy-added dependent into its prerequisite's live wave", async () => {
        await withTempDir("collective-policy-live-admission-", async (dir) => {
            const runId = "run-policy-live-admission"
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify(singleStoryPrd("S1"), null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId, baseSha: null }),
            )
            const originalContext = await waitFor(
                env.events,
                WorkContextRequested.is,
            )
            provideContext(env, runId, originalContext)
            const originalOffer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: originalOffer.data.offerId,
                    leaseId: "lease-S1",
                    workerId: "worker-S1",
                    generation: originalOffer.data.generation,
                    request: originalOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("worker-S1"),
                result(
                    runId,
                    "S1",
                    "lease-S1",
                    originalOffer.data.generation,
                    false,
                ),
            )
            const cleanup = await waitFor(
                env.events,
                WorkspaceCleanupRequested.is,
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon:S1",
                    reason: "split cancellation primitives while keeping a peer busy",
                    recovery: {
                        runId,
                        storyId: "S1",
                        leaseId: "lease-S1",
                        generation: originalOffer.data.generation,
                    },
                    removedStoryIds: ["S1"],
                    modifiedDeps: {},
                    addedStories: [
                        replacement("S10", []),
                        replacement("S11", ["S10"]),
                        replacement("SP", []),
                    ],
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                RecoveryDecision.create({
                    runId,
                    storyId: "S1",
                    source: "surgeon:S1",
                    action: "replan",
                    reason: "split cancellation primitives while keeping a peer busy",
                }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({ ...cleanup.data }),
            )

            await waitFor(env.events, RuntimeReplanApplied.is)
            const nextContexts = await waitForCount(
                env.events,
                WorkContextRequested.is,
                3,
            )
            for (const request of nextContexts.slice(1)) {
                provideContext(env, runId, request)
            }
            const nextOffers = await waitForCount(env.events, WorkOffered.is, 3)
            const s10Offer = nextOffers.find(
                (offer) => offer.data.request.storyId === "S10",
            )!
            const peerOffer = nextOffers.find(
                (offer) => offer.data.request.storyId === "SP",
            )!
            for (const offer of [s10Offer, peerOffer]) {
                const storyId = offer.data.request.storyId
                env.deliverSemanticEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId,
                        offerId: offer.data.offerId,
                        leaseId: `lease-${storyId}`,
                        workerId: `worker-${storyId}`,
                        generation: offer.data.generation,
                        request: offer.data.request,
                    }),
                )
            }

            env.deliverSemanticEvent(
                source("worker-S10"),
                result(
                    runId,
                    "S10",
                    "lease-S10",
                    s10Offer.data.generation,
                    true,
                ),
            )
            await waitForCount(env.events, StoryIntegrationRequested.is, 1)
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    runId,
                    storyId: "S10",
                    leaseId: "lease-S10",
                    mode: "worktree",
                }),
            )

            const admitted = (
                await waitForCount(env.events, WorkContextRequested.is, 4)
            )[3]!
            assert.equal(admitted.data.storyId, "S11")
            assert.equal(
                env.events.some((event) => event.type === "level_completed"),
                true,
                "only the original failed wave has completed; SP keeps the current wave open",
            )
            assert.equal(
                env.events.filter(
                    (event) =>
                        event.type === "level_completed" &&
                        (event as { data?: { ordinal?: number } }).data?.ordinal === 2,
                ).length,
                0,
            )
        })
    })
})

function siblingRewirePrd(siblingIds: readonly string[]): PrdFile {
    return {
        project: "Policy replan batch",
        branchName: "baro/policy-replan-batch",
        description: "Exercise sibling recovery at one safe boundary.",
        userStories: [
            story("S10", 1, []),
            ...siblingIds.map((id, index) => story(id, index + 2, [])),
            story("S11", siblingIds.length + 2, ["S10"]),
        ],
    }
}

function singleStoryPrd(id: string): PrdFile {
    return {
        project: "Policy live admission",
        branchName: "baro/policy-live-admission",
        description: "Exercise policy-added runtime readiness.",
        userStories: [story(id, 1, [])],
    }
}

function story(id: string, priority: number, dependsOn: readonly string[]): PrdStory {
    return {
        id,
        priority,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
    }
}

function replacement(id: string, dependsOn: readonly string[]) {
    return {
        id,
        priority: id === "S10" ? 1 : id === "SP" ? 2 : 3,
        title: `Replacement ${id}`,
        description: `Implement replacement ${id}.`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: ["npm test"],
        model: "standard",
    }
}

function result(
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
    success: boolean,
) {
    return StoryResult.create({
        runId,
        storyId,
        leaseId,
        generation,
        success,
        attempts: 1,
        durationSecs: 1,
        error: success ? null : "missing iterator prerequisite",
    })
}

function recovery(
    runId: string,
    storyId: string,
    offer: ReturnType<typeof WorkOffered.create>,
): NonNullable<ReplanData["recovery"]> {
    return {
        runId,
        storyId,
        leaseId: `lease-${storyId}`,
        generation: offer.data.generation,
    }
}

function provideContext(
    env: CapturedEnvironment,
    runId: string,
    request: ReturnType<typeof WorkContextRequested.create>,
): void {
    env.deliverSemanticEvent(
        source("context"),
        WorkContextProvided.create({
            runId,
            requestId: request.data.requestId,
            storyId: request.data.storyId,
            context: null,
        }),
    )
}

async function startAndLeaseInitialWave(
    env: CapturedEnvironment,
    runId: string,
    storyCount: number,
): Promise<ReturnType<typeof WorkOffered.create>[]> {
    env.deliverSemanticEvent(
        source("operator"),
        RunStartRequest.create({ reason: "test" }),
    )
    env.deliverSemanticEvent(
        source("repo"),
        RunPrepared.create({ runId, baseSha: null }),
    )
    const contexts = await waitForCount(
        env.events,
        WorkContextRequested.is,
        storyCount,
    )
    for (const request of contexts) provideContext(env, runId, request)
    const offers = await waitForCount(env.events, WorkOffered.is, storyCount)
    for (const offer of offers) grantOffer(env, runId, offer)
    return offers
}

function grantOffer(
    env: CapturedEnvironment,
    runId: string,
    offer: ReturnType<typeof WorkOffered.create>,
): void {
    const storyId = offer.data.request.storyId
    env.deliverSemanticEvent(
        source("broker"),
        WorkLeaseGranted.create({
            runId,
            offerId: offer.data.offerId,
            leaseId: `lease-${storyId}`,
            workerId: `worker-${storyId}`,
            generation: offer.data.generation,
            request: offer.data.request,
        }),
    )
}

async function failWithPolicyReplan(
    env: CapturedEnvironment,
    runId: string,
    offer: ReturnType<typeof WorkOffered.create>,
    replan: ReplanData,
    cleanupOrdinal: number,
    recoverySource = source("surgeon"),
): Promise<void> {
    const storyId = offer.data.request.storyId
    const leaseId = `lease-${storyId}`
    env.deliverSemanticEvent(
        source(`worker-${storyId}`),
        result(
            runId,
            storyId,
            leaseId,
            offer.data.generation,
            false,
        ),
    )
    const cleanup = (
        await waitForCount(
            env.events,
            WorkspaceCleanupRequested.is,
            cleanupOrdinal,
        )
    )[cleanupOrdinal - 1]!
    env.deliverSemanticEvent(recoverySource, Replan.create(replan))
    env.deliverSemanticEvent(
        recoverySource,
        RecoveryDecision.create({
            runId,
            storyId,
            source: replan.source,
            action: "replan",
            reason: replan.reason,
        }),
    )
    env.deliverSemanticEvent(
        source("repo"),
        WorkspaceCleanupCompleted.create({ ...cleanup.data }),
    )
}

function readPrd(path: string): PrdFile {
    return JSON.parse(readFileSync(path, "utf8")) as PrdFile
}

async function waitFor<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    return (await waitForCount(events, guard, 1))[0]!
}

async function waitForCount<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = events.filter(guard)
        if (found.length >= count) return found
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.fail(`timed out waiting for ${count} events`)
}
