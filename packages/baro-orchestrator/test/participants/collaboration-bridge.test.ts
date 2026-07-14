import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CollaborationBridge } from "../../src/participants/collaboration-bridge.js"
import {
    AgentTargetedMessage,
    CollaborationNote,
    RunCompleted,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RuntimeReplanRejected,
    WorkDiscovered,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("CollaborationBridge", () => {
    it("validates a lease and republishes worker intent onto Mozaik", async () => {
        await withTempDir("collaboration-bridge-", async (dir) => {
            const bridge = new CollaborationBridge({
                runId: "run-collab",
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowUnboundAuthorities: true,
            })
            const env = joinWithCapture(bridge)
            for (const [storyId, leaseId] of [["S1", "lease-1"], ["S2", "lease-2"]]) {
                env.deliverSemanticEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId: "run-collab",
                        offerId: `offer-${storyId}`,
                        leaseId,
                        workerId: "worker",
                        generation: 1,
                        request: {
                            storyId,
                            prompt: storyId,
                            model: "standard",
                            retries: 1,
                            timeoutSecs: 60,
                        },
                    }),
                )
            }
            await bridge.idle()

            writeFileSync(
                join(dir, "outbox", "message.json"),
                JSON.stringify({
                    leaseId: "lease-1",
                    kind: "message",
                    to: "S2",
                    text: "The shared interface is in src/api.ts",
                }),
            )
            const message = await waitFor(env.events, AgentTargetedMessage.is)
            assert.equal(message.data.recipientId, "S2")
            assert.equal(message.data.metadata.sourceAgentId, "S1")
            await bridge.idle()
            const inbox = join(dir, "inbox", "S2.jsonl")
            assert.equal(existsSync(inbox), true)
            assert.match(readFileSync(inbox, "utf8"), /shared interface/)

            writeFileSync(
                join(dir, "outbox", "discover.json"),
                JSON.stringify({
                    leaseId: "lease-1",
                    kind: "discover",
                    reason: "The schema needs a migration first",
                    story: {
                        id: "S3",
                        title: "Add migration",
                        description: "Create the required schema migration.",
                        dependsOn: ["S1"],
                        acceptance: ["migration exists"],
                        tests: ["npm test"],
                    },
                }),
            )
            const discovered = await waitFor(env.events, WorkDiscovered.is)
            assert.equal(discovered.data.sourceAgentId, "S1")
            assert.equal(discovered.data.leaseId, "lease-1")
            assert.equal(discovered.data.generation, 1)
            assert.equal(discovered.data.story.id, "S3")

            env.deliverSemanticEvent(
                source("board"),
                RunCompleted.create({
                    success: true,
                    completedStories: [],
                    failedStories: [],
                    totalDurationSecs: 0,
                    totalAttempts: 0,
                    abortReason: null,
                    runId: "run-collab",
                }),
            )
            await bridge.idle()
        })
    })

    it("queues a targeted message until a later-wave recipient is leased", async () => {
        await withTempDir("collaboration-bridge-pending-", async (dir) => {
            const bridge = new CollaborationBridge({
                runId: "run-pending",
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowUnboundAuthorities: true,
            })
            const env = joinWithCapture(bridge)
            const inbox = join(dir, "inbox", "S2.jsonl")

            env.deliverSemanticEvent(
                source("peer"),
                AgentTargetedMessage.create({
                    recipientId: "S2",
                    text: "Use the terminal Responses event, not a later decoy.",
                    metadata: {
                        kind: "peer_message",
                        sourceAgentId: "S1",
                    },
                }),
            )
            await bridge.idle()
            assert.equal(existsSync(inbox), false)

            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-pending",
                    offerId: "offer-S2",
                    leaseId: "lease-S2",
                    workerId: "worker",
                    generation: 2,
                    request: {
                        storyId: "S2",
                        prompt: "S2",
                        model: "standard",
                        retries: 1,
                        timeoutSecs: 60,
                    },
                }),
            )
            await bridge.idle()

            assert.equal(existsSync(inbox), true)
            assert.match(readFileSync(inbox, "utf8"), /terminal Responses event/)

            env.deliverSemanticEvent(
                source("board"),
                RunCompleted.create({
                    success: true,
                    completedStories: ["S2"],
                    failedStories: [],
                    totalDurationSecs: 1,
                    totalAttempts: 1,
                    abortReason: null,
                    runId: "run-pending",
                }),
            )
            await bridge.idle()
        })
    })

    it("accepts a final outbox note after lease release without losing attribution", async () => {
        await withTempDir("collaboration-bridge-release-", async (dir) => {
            const bridge = new CollaborationBridge({
                runId: "run-release",
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowUnboundAuthorities: true,
            })
            const env = joinWithCapture(bridge)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-release",
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "S1",
                        model: "standard",
                        retries: 1,
                        timeoutSecs: 60,
                    },
                }),
            )
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseReleased.create({
                    runId: "run-release",
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    storyId: "S1",
                    workerId: "worker",
                    reason: "completed",
                }),
            )
            await bridge.idle()

            writeFileSync(
                join(dir, "outbox", "last-note.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "note",
                    text: "This finding was written immediately before exit.",
                }),
            )

            const note = await waitFor(env.events, CollaborationNote.is)
            assert.equal(note.data.runId, "run-release")
            assert.equal(note.data.sourceAgentId, "S1")
            assert.match(note.data.text, /immediately before exit/)

            env.deliverSemanticEvent(
                source("board"),
                RunCompleted.create({
                    success: true,
                    completedStories: ["S1"],
                    failedStories: [],
                    totalDurationSecs: 1,
                    totalAttempts: 1,
                    abortReason: null,
                    runId: "run-release",
                }),
            )
            await bridge.idle()
        })
    })

    it("rejects delayed discovery from a released lease after a new generation starts", async () => {
        await withTempDir("collaboration-bridge-stale-discovery-", async (dir) => {
            const runId = "run-stale-discovery"
            const broker = source("broker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
            })
            bridge.setLeaseAuthority(broker)
            const env = joinWithCapture(bridge)
            const grant = (leaseId: string, generation: number) =>
                WorkLeaseGranted.create({
                    runId,
                    offerId: `offer-${generation}`,
                    leaseId,
                    workerId: "worker",
                    generation,
                    request: {
                        storyId: "S1",
                        prompt: "S1",
                        model: "standard",
                        retries: 1,
                        timeoutSecs: 60,
                    },
                })

            env.deliverSemanticEvent(broker, grant("lease-old", 1))
            env.deliverSemanticEvent(
                broker,
                WorkLeaseReleased.create({
                    runId,
                    offerId: "offer-1",
                    leaseId: "lease-old",
                    storyId: "S1",
                    workerId: "worker",
                    reason: "operational_failed",
                }),
            )
            env.deliverSemanticEvent(broker, grant("lease-new", 2))
            await bridge.idle()

            const stalePath = join(dir, "outbox", "stale-discovery.json")
            writeFileSync(
                stalePath,
                JSON.stringify({
                    leaseId: "lease-old",
                    kind: "discover",
                    reason: "late old-generation result",
                    story: {
                        id: "S-stale",
                        title: "Stale work",
                        description: "Must not mutate the new generation.",
                        dependsOn: ["S1"],
                        acceptance: ["never scheduled"],
                        tests: [],
                    },
                }),
            )
            await waitForGone(stalePath)
            assert.equal(env.events.some(WorkDiscovered.is), false)
        })
    })

    it("publishes a replan only from the exact active lease and writes an authoritative decision", async () => {
        await withTempDir("collaboration-bridge-replan-", async (dir) => {
            const runId = "run-replan"
            const broker = source("broker")
            const board = source("board")
            const attacker = source("attacker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
            })
            bridge.setLeaseAuthority(broker)
            bridge.setDecisionAuthority(board)
            const env = joinWithCapture(bridge)

            const grant = WorkLeaseGranted.create({
                runId,
                offerId: "offer-S1",
                leaseId: "lease-S1",
                workerId: "worker",
                generation: 7,
                request: {
                    storyId: "S1",
                    prompt: "S1",
                    model: "standard",
                    retries: 1,
                    timeoutSecs: 60,
                    graphVersion: 4,
                },
            })
            env.deliverSemanticEvent(attacker, grant)
            env.deliverSemanticEvent(broker, grant)
            env.deliverSemanticEvent(
                attacker,
                WorkLeaseReleased.create({
                    runId,
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    storyId: "S1",
                    workerId: "worker",
                    reason: "aborted",
                }),
            )
            await bridge.idle()

            const mutation = {
                addedStories: [
                    {
                        id: "S2",
                        priority: 2,
                        title: "Add the missing migration",
                        description: "Create the migration discovered at runtime.",
                        dependsOn: ["S1"],
                        acceptance: ["migration exists"],
                        tests: ["npm test"],
                    },
                ],
                removedStoryIds: [],
                modifiedDeps: {},
            }
            writeFileSync(
                join(dir, "outbox", "replan.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "replan",
                    proposalId: "proposal-1",
                    baseGraphVersion: 4,
                    reason: "A migration is required before the API can ship",
                    mutation,
                }),
            )

            const proposed = await waitFor(env.events, RuntimeReplanProposed.is)
            assert.deepEqual(proposed.data, {
                runId,
                proposalId: "proposal-1",
                sourceStoryId: "S1",
                leaseId: "lease-S1",
                generation: 7,
                baseGraphVersion: 4,
                reason: "A migration is required before the API can ship",
                mutation,
            })

            const applied = RuntimeReplanApplied.create({
                ...proposed.data,
                previousGraphVersion: 4,
                graphVersion: 5,
            })
            env.deliverSemanticEvent(attacker, applied)
            await bridge.idle()
            const decisionPath = join(dir, "decisions", "proposal-1.json")
            assert.equal(existsSync(decisionPath), false)

            const writableBridge = bridge as unknown as {
                writeDecision: (
                    proposalId: string,
                    decision: Readonly<Record<string, unknown>>,
                ) => void
            }
            const writeDecision = writableBridge.writeDecision.bind(bridge)
            let failFirstDecisionWrite = true
            writableBridge.writeDecision = (proposalId, decision) => {
                if (failFirstDecisionWrite) {
                    failFirstDecisionWrite = false
                    throw new Error("simulated decision write failure")
                }
                writeDecision(proposalId, decision)
            }
            env.deliverSemanticEvent(board, applied)
            await waitForPath(decisionPath)
            assert.equal(
                env.events.filter(RuntimeReplanProposed.is).length,
                1,
            )
            const decision = JSON.parse(readFileSync(decisionPath, "utf8"))
            assert.deepEqual(decision, {
                status: "applied",
                ...applied.data,
            })
            assert.deepEqual(
                readdirSync(join(dir, "decisions")).filter((name) =>
                    name.endsWith(".tmp"),
                ),
                [],
            )

            env.deliverSemanticEvent(
                attacker,
                RunCompleted.create({
                    success: true,
                    completedStories: ["S1"],
                    failedStories: [],
                    totalDurationSecs: 1,
                    totalAttempts: 1,
                    abortReason: null,
                    runId,
                }),
            )
            await bridge.idle()

            writeFileSync(
                join(dir, "outbox", "rejected-replan.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "replan",
                    proposalId: "proposal-2",
                    baseGraphVersion: 4,
                    reason: "proposal used the launch snapshot",
                    mutation: {
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: { S9: ["S1"] },
                    },
                }),
            )
            const secondProposal = await waitForProposal(
                env.events,
                "proposal-2",
            )
            const rejected = RuntimeReplanRejected.create({
                runId,
                proposalId: secondProposal.data.proposalId,
                sourceStoryId: secondProposal.data.sourceStoryId,
                leaseId: secondProposal.data.leaseId,
                generation: secondProposal.data.generation,
                baseGraphVersion: secondProposal.data.baseGraphVersion,
                currentGraphVersion: 5,
                code: "stale_graph_version",
                reason: "the graph advanced after this story launched",
            })
            env.deliverSemanticEvent(board, rejected)
            const rejectedPath = join(dir, "decisions", "proposal-2.json")
            await waitForPath(rejectedPath)
            assert.deepEqual(
                JSON.parse(readFileSync(rejectedPath, "utf8")),
                {
                    status: "rejected",
                    ...rejected.data,
                },
            )

            env.deliverSemanticEvent(
                board,
                RunCompleted.create({
                    success: true,
                    completedStories: ["S1"],
                    failedStories: [],
                    totalDurationSecs: 1,
                    totalAttempts: 1,
                    abortReason: null,
                    runId,
                }),
            )
            await bridge.idle()
        })
    })

    it("rejects a released lease replan locally while retaining final-note attribution", async () => {
        await withTempDir("collaboration-bridge-stale-replan-", async (dir) => {
            const runId = "run-stale-replan"
            const broker = source("broker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
            })
            bridge.setLeaseAuthority(broker)
            const env = joinWithCapture(bridge)
            env.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    workerId: "worker",
                    generation: 3,
                    request: {
                        storyId: "S1",
                        prompt: "S1",
                        model: "standard",
                        retries: 1,
                        timeoutSecs: 60,
                        graphVersion: 2,
                    },
                }),
            )
            env.deliverSemanticEvent(
                broker,
                WorkLeaseReleased.create({
                    runId,
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    storyId: "S1",
                    workerId: "worker",
                    reason: "integrated",
                }),
            )
            await bridge.idle()

            writeFileSync(
                join(dir, "outbox", "a-note.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "note",
                    text: "Retain this final observation.",
                }),
            )
            writeFileSync(
                join(dir, "outbox", "b-replan.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "replan",
                    proposalId: "proposal-stale",
                    baseGraphVersion: 2,
                    reason: "too late",
                    mutation: {
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: { S2: ["S1"] },
                    },
                }),
            )

            const note = await waitFor(env.events, CollaborationNote.is)
            assert.equal(note.data.sourceAgentId, "S1")
            const decisionPath = join(
                dir,
                "decisions",
                "proposal-stale.json",
            )
            await waitForPath(decisionPath)
            assert.deepEqual(
                JSON.parse(readFileSync(decisionPath, "utf8")),
                {
                    status: "rejected",
                    code: "stale_lease",
                    proposalId: "proposal-stale",
                    reason: "runtime replan requires the source story's current versioned lease",
                },
            )
            assert.equal(env.events.some(RuntimeReplanProposed.is), false)
        })
    })
})

async function waitFor<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const event = events.find(guard)
        if (event) return event
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail("timed out waiting for collaboration event")
}

async function waitForPath(path: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (existsSync(path)) return
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`timed out waiting for ${path}`)
}

async function waitForGone(path: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!existsSync(path)) return
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`timed out waiting for ${path} to be consumed`)
}

async function waitForProposal(
    events: readonly unknown[],
    proposalId: string,
): Promise<ReturnType<typeof RuntimeReplanProposed.create>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        for (const candidate of events) {
            const event = candidate as Parameters<
                typeof RuntimeReplanProposed.is
            >[0]
            if (
                RuntimeReplanProposed.is(event) &&
                event.data.proposalId === proposalId
            ) {
                return event
            }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`timed out waiting for runtime replan proposal ${proposalId}`)
}
