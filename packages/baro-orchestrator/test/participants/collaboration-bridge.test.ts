import assert from "node:assert/strict"
import {
    existsSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { describe, it } from "node:test"

import { inboxFilenameForAgentId } from "../../scripts/collaboration-inbox-path.mjs"
import { CollaborationBridge } from "../../src/participants/collaboration-bridge.js"
import { CollectiveBoard } from "../../src/participants/collective-board.js"
import { GoalGuardian } from "../../src/participants/goal-guardian.js"
import type { PrdFile } from "../../src/prd.js"
import { deriveGoalContract } from "../../src/runtime/goal-contract.js"
import {
    AgentTargetedMessage,
    CollaborationNote,
    GoalInvariantChallengeRaised,
    GoalLedgerProjectionPersisted,
    RunCompleted,
    RunStartRequest,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RuntimeReplanRejected,
    WorkBlockAccepted,
    WorkBlocked,
    WorkDiscovered,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../src/semantic-events.js"
import {
    captureEnv,
    joinWithCapture,
    source,
    withTempDir,
} from "./helpers.js"

describe("CollaborationBridge", () => {
    it("seals exact message producers and emits one lease-correlated delivery", async () => {
        await withTempDir("collaboration-bridge-authority-", async (dir) => {
            const runId = "run-message-authority"
            const broker = source("broker")
            const operator = source("operator")
            const impostor = source("operator")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                unsafeAllowFilesystemTransport: true,
            })
            bridge.setLeaseAuthority(broker)
            bridge.setMessageIntentAuthorities([operator])
            assert.throws(
                () => bridge.setMessageIntentAuthorities([operator]),
                /already sealed/,
            )
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
                        retries: 0,
                        timeoutSecs: 60,
                    },
                }),
            )
            env.deliverSemanticEvent(
                impostor,
                AgentTargetedMessage.create({
                    recipientId: "S1",
                    text: "forged source",
                    metadata: {},
                }),
            )
            env.deliverSemanticEvent(
                operator,
                AgentTargetedMessage.create({
                    recipientId: "S1",
                    text: "authorized",
                    metadata: { source: "operator" },
                    runId: "forged",
                    leaseId: "forged",
                    generation: 99,
                }),
            )
            await bridge.idle()

            const deliveries = env.events
                .filter(AgentTargetedMessage.is)
                .filter((event) => event.data.runId === runId)
            assert.equal(deliveries.length, 1)
            assert.deepEqual(deliveries[0]?.data, {
                recipientId: "S1",
                text: "authorized",
                metadata: { source: "operator" },
                runId,
                leaseId: "lease-S1",
                generation: 3,
            })
            const inbox = readFileSync(
                join(dir, "inbox", inboxFilenameForAgentId("S1")),
                "utf8",
            )
            assert.match(inbox, /authorized/)
            assert.doesNotMatch(inbox, /forged source/)
            bridge.leave(env)
        })
    })

    it("keeps colliding legacy-safe ids isolated across lease generations", async () => {
        await withTempDir("collaboration-bridge-inbox-collision-", async (dir) => {
            const runId = "run-inbox-collision"
            const broker = source("broker")
            const operator = source("operator")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                unsafeAllowFilesystemTransport: true,
            })
            bridge.setLeaseAuthority(broker)
            bridge.setMessageIntentAuthorities([operator])
            const env = joinWithCapture(bridge)
            const slashId = "A/B"
            const questionId = "A?B"
            const slashInbox = join(
                dir,
                "inbox",
                inboxFilenameForAgentId(slashId),
            )
            const questionInbox = join(
                dir,
                "inbox",
                inboxFilenameForAgentId(questionId),
            )
            assert.notEqual(slashInbox, questionInbox)

            const grant = (storyId: string, leaseId: string, generation: number) =>
                WorkLeaseGranted.create({
                    runId,
                    offerId: `offer-${leaseId}`,
                    leaseId,
                    workerId: "worker",
                    generation,
                    request: {
                        storyId,
                        prompt: storyId,
                        model: "standard",
                        retries: 0,
                        timeoutSecs: 60,
                    },
                })
            const release = (storyId: string, leaseId: string) =>
                WorkLeaseReleased.create({
                    runId,
                    offerId: `offer-${leaseId}`,
                    leaseId,
                    storyId,
                    workerId: "worker",
                    reason: "operational_failed",
                })
            const message = (recipientId: string, text: string) =>
                AgentTargetedMessage.create({ recipientId, text, metadata: {} })

            env.deliverSemanticEvent(broker, grant(slashId, "lease-slash-1", 1))
            env.deliverSemanticEvent(
                broker,
                grant(questionId, "lease-question-1", 1),
            )
            env.deliverSemanticEvent(operator, message(slashId, "slash generation 1"))
            env.deliverSemanticEvent(
                operator,
                message(questionId, "question generation 1"),
            )
            await bridge.idle()

            assert.match(readFileSync(slashInbox, "utf8"), /slash generation 1/u)
            assert.doesNotMatch(readFileSync(slashInbox, "utf8"), /question/u)
            assert.match(
                readFileSync(questionInbox, "utf8"),
                /question generation 1/u,
            )
            assert.doesNotMatch(readFileSync(questionInbox, "utf8"), /slash/u)

            env.deliverSemanticEvent(
                broker,
                release(slashId, "lease-slash-1"),
            )
            env.deliverSemanticEvent(broker, grant(slashId, "lease-slash-2", 2))
            await bridge.idle()
            assert.equal(existsSync(slashInbox), false)
            assert.match(
                readFileSync(questionInbox, "utf8"),
                /question generation 1/u,
            )

            env.deliverSemanticEvent(operator, message(slashId, "slash generation 2"))
            env.deliverSemanticEvent(
                operator,
                message(questionId, "question still generation 1"),
            )
            await bridge.idle()
            assert.doesNotMatch(readFileSync(slashInbox, "utf8"), /generation 1/u)
            assert.match(readFileSync(slashInbox, "utf8"), /slash generation 2/u)
            assert.match(
                readFileSync(questionInbox, "utf8"),
                /question generation 1/u,
            )
            assert.match(
                readFileSync(questionInbox, "utf8"),
                /question still generation 1/u,
            )

            env.deliverSemanticEvent(
                broker,
                release(questionId, "lease-question-1"),
            )
            env.deliverSemanticEvent(
                broker,
                grant(questionId, "lease-question-2", 2),
            )
            await bridge.idle()
            assert.equal(existsSync(questionInbox), false)
            assert.match(readFileSync(slashInbox, "utf8"), /slash generation 2/u)

            env.deliverSemanticEvent(
                operator,
                message(questionId, "question generation 2"),
            )
            await bridge.idle()
            assert.doesNotMatch(
                readFileSync(questionInbox, "utf8"),
                /question generation 1/u,
            )
            assert.match(
                readFileSync(questionInbox, "utf8"),
                /question generation 2/u,
            )
            assert.doesNotMatch(readFileSync(questionInbox, "utf8"), /slash/u)
            bridge.leave(env)
        })
    })

    it("rejects message and help records created after lease revocation", async () => {
        await withTempDir("collaboration-bridge-stale-message-", async (dir) => {
            const runId = "run-stale-message"
            const broker = source("broker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
            })
            bridge.setLeaseAuthority(broker)
            bridge.setMessageIntentAuthorities([])
            const env = joinWithCapture(bridge)
            env.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S1",
                    leaseId: "lease-S1",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "S1",
                        model: "standard",
                        retries: 0,
                        timeoutSecs: 60,
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

            const messagePath = join(dir, "outbox", "stale-message.json")
            const helpPath = join(dir, "outbox", "stale-help.json")
            writeFileSync(messagePath, JSON.stringify({
                leaseId: "lease-S1",
                kind: "message",
                to: "S2",
                text: "stale message",
            }))
            writeFileSync(helpPath, JSON.stringify({
                leaseId: "lease-S1",
                kind: "help",
                text: "stale help",
            }))
            await waitForGone(messagePath)
            await waitForGone(helpPath)

            assert.equal(
                env.events.filter(AgentTargetedMessage.is).length,
                0,
            )
            bridge.leave(env)
        })
    })

    it("validates a lease and republishes worker intent onto Mozaik", async () => {
        await withTempDir("collaboration-bridge-", async (dir) => {
            const bridge = new CollaborationBridge({
                runId: "run-collab",
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
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
            const inbox = join(
                dir,
                "inbox",
                inboxFilenameForAgentId("S2"),
            )
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
                unsafeAllowFilesystemTransport: true,
                unsafeAllowUnboundAuthorities: true,
            })
            const env = joinWithCapture(bridge)
            const inbox = join(
                dir,
                "inbox",
                inboxFilenameForAgentId("S2"),
            )

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

    it("drains a committed final note before revoking lease attribution", async () => {
        await withTempDir("collaboration-bridge-release-", async (dir) => {
            const bridge = new CollaborationBridge({
                runId: "run-release",
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
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
            writeFileSync(
                join(dir, "outbox", "last-note.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "note",
                    text: "This finding was written immediately before exit.",
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

    it("drains a committed challenge before revoking its lease capability", async () => {
        await withTempDir("collaboration-bridge-challenge-release-", async (dir) => {
            const runId = "run-challenge-release"
            const broker = source("broker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
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
            writeFileSync(
                join(dir, "outbox", "challenge-before-release.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "challenge",
                    challengeId: "challenge-before-release",
                    invariantId: "G-A1",
                    reason: "cleanup can still race the terminal response",
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
                    reason: "completed",
                }),
            )
            await bridge.idle()

            const challenges = env.events.filter(GoalInvariantChallengeRaised.is)
            assert.equal(challenges.length, 1)
            assert.equal(challenges[0]?.data.raisedBy, "S1")

            const stalePath = join(
                dir,
                "outbox",
                "challenge-after-release.json",
            )
            writeFileSync(
                stalePath,
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "challenge",
                    challengeId: "challenge-after-release",
                    invariantId: "G-A1",
                    reason: "this record was created after capability revocation",
                }),
            )
            await waitForGone(stalePath)
            assert.equal(
                env.events.filter(GoalInvariantChallengeRaised.is).length,
                1,
            )
        })
    })

    it("retains a challenge until the authoritative persisted projection contains it", async () => {
        await withTempDir("collaboration-bridge-challenge-ack-", async (dir) => {
            const runId = "run-challenge-ack"
            const broker = source("broker")
            const board = source("board")
            const attacker = source("attacker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
            })
            bridge.setLeaseAuthority(broker)
            bridge.setDecisionAuthority(board)
            const env = joinWithCapture(bridge)
            env.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
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
            writeFileSync(
                join(dir, "outbox", "challenge.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "challenge",
                    challengeId: "challenge-durable",
                    invariantId: "G-A1",
                    reason: "the exact terminal behavior is still unverified",
                }),
            )
            await waitFor(env.events, GoalInvariantChallengeRaised.is)

            const inflightDir = join(dir, "challenge-inflight")
            const [retainedName] = readdirSync(inflightDir)
            assert.ok(retainedName)
            const retainedPath = join(inflightDir, retainedName)
            assert.equal(existsSync(retainedPath), true)
            assert.deepEqual(readdirSync(join(dir, "outbox")), [])

            const projection = {
                schemaVersion: 1 as const,
                contractId: "goal-contract-durable",
                revision: 3,
                mappings: [],
                integrations: [],
                qualities: [],
                challenges: [{
                    challengeId: "challenge-durable",
                    invariantId: "G-A1",
                    raisedBy: "S1",
                    reason: "the exact terminal behavior is still unverified",
                    storyId: "S1",
                }],
                protocolIssues: [],
            }
            const receipt = GoalLedgerProjectionPersisted.create({
                runId,
                contractId: projection.contractId,
                revision: projection.revision,
                projection,
            })
            env.deliverSemanticEvent(attacker, receipt)
            await bridge.idle()
            assert.equal(existsSync(retainedPath), true)

            env.deliverSemanticEvent(
                board,
                GoalLedgerProjectionPersisted.create({
                    ...receipt.data,
                    projection: { ...projection, challenges: [] },
                }),
            )
            await bridge.idle()
            assert.equal(existsSync(retainedPath), true)

            env.deliverSemanticEvent(board, receipt)
            await bridge.idle()
            assert.equal(existsSync(retainedPath), false)
            bridge.leave(env)
        })
    })

    it("replays an inflight challenge across session-epoch restart until Board persistence acks it", async () => {
        await withTempDir("collaboration-bridge-challenge-restart-", async (dir) => {
            const runId = "run-challenge-restart"
            const broker = source("broker")
            const inflightDir = join(dir, "durable-challenges")
            const firstSession = join(dir, "epoch-1")
            const firstBridge = new CollaborationBridge({
                runId,
                sessionDir: firstSession,
                challengeInflightDir: inflightDir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
            })
            firstBridge.setLeaseAuthority(broker)
            const firstEnv = joinWithCapture(firstBridge)
            firstEnv.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
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
            writeFileSync(
                join(firstSession, "outbox", "challenge.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "challenge",
                    challengeId: "challenge-survives-restart",
                    invariantId: "G-A1",
                    reason: "a crash must not erase this challenge",
                }),
            )
            await waitFor(firstEnv.events, GoalInvariantChallengeRaised.is)
            const [retainedName] = readdirSync(inflightDir)
            assert.ok(retainedName)
            const retainedPath = join(inflightDir, retainedName)
            firstBridge.leave(firstEnv)

            const goalEnvelope = {
                objective: "Preserve fail-closed goal evidence across restarts.",
                constraints: [],
                acceptanceCriteria: ["Every retained challenge is durably projected."],
                nonGoals: [],
                assumptions: [],
            }
            const contract = deriveGoalContract(goalEnvelope)!
            const prdPath = join(dir, "prd.json")
            const prd: PrdFile = {
                project: "Challenge durability",
                branchName: "baro/challenge-durability",
                description: "test",
                goalEnvelope,
                userStories: [{
                    id: "S1",
                    priority: 1,
                    title: "Preserve evidence",
                    description: "Keep goal evidence durable.",
                    dependsOn: [],
                    retries: 1,
                    acceptance: ["challenge is retained"],
                    tests: [],
                    goalInvariantIds: ["G-A1"],
                    passes: false,
                    completedAt: null,
                    durationSecs: null,
                    model: "standard",
                }],
            }
            writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")

            const guardian = new GoalGuardian({
                runId,
                goalEnvelope,
                storyMappings: [{
                    storyId: "S1",
                    invariantIds: ["G-A1"],
                }],
            })
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                goalCompletionAuthority: guardian,
            })
            const secondBridge = new CollaborationBridge({
                runId,
                sessionDir: join(dir, "epoch-2"),
                challengeInflightDir: inflightDir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
            })
            guardian.setRequestAuthority(board)
            guardian.setChallengeAuthority(secondBridge)
            secondBridge.setDecisionAuthority(board)
            const secondEnv = captureEnv()
            guardian.join(secondEnv)
            board.join(secondEnv)
            secondBridge.join(secondEnv)

            secondEnv.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "resume after crash" }),
            )
            await waitForGone(retainedPath)
            await board.idle()
            await secondBridge.idle()

            const saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            const persisted = saved.runtimeGraph?.protocol?.goal
            assert.equal(persisted?.contractId, contract.contractId)
            assert.equal(
                persisted?.challenges.some(
                    ({ challengeId }) =>
                        challengeId === "challenge-survives-restart",
                ),
                true,
            )
            assert.equal(
                secondEnv.events
                    .filter(GoalLedgerProjectionPersisted.is)
                    .some(({ data }) =>
                        data.projection.challenges.some(
                            ({ challengeId }) =>
                                challengeId === "challenge-survives-restart",
                        ),
                    ),
                true,
            )

            secondBridge.leave(secondEnv)
            board.leave(secondEnv)
            guardian.leave(secondEnv)
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
                unsafeAllowFilesystemTransport: true,
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
                unsafeAllowFilesystemTransport: true,
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

    it("rejects every stale record after release while preserving a pre-release final note", async () => {
        await withTempDir("collaboration-bridge-stale-replan-", async (dir) => {
            const runId = "run-stale-replan"
            const broker = source("broker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
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
            writeFileSync(
                join(dir, "outbox", "a-note.json"),
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "note",
                    text: "Retain this final observation.",
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

            const staleNotePath = join(dir, "outbox", "c-stale-note.json")
            writeFileSync(
                staleNotePath,
                JSON.stringify({
                    leaseId: "lease-S1",
                    kind: "note",
                    text: "This stale observation must not be trusted.",
                }),
            )
            await waitForGone(staleNotePath)
            assert.equal(env.events.filter(CollaborationNote.is).length, 1)
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
                    reason: "runtime replan lease is unknown or no longer attributable",
                },
            )
            assert.equal(env.events.some(RuntimeReplanProposed.is), false)
        })
    })

    it("correlates a dependency block with the active lease and Board decision", async () => {
        await withTempDir("collaboration-bridge-block-", async (dir) => {
            const runId = "run-block"
            const broker = source("broker")
            const board = source("board")
            const attacker = source("attacker")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
            })
            bridge.setLeaseAuthority(broker)
            bridge.setDecisionAuthority(board)
            const env = joinWithCapture(bridge)
            env.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S6",
                    leaseId: "lease-S6",
                    workerId: "worker",
                    generation: 2,
                    request: {
                        storyId: "S6",
                        prompt: "provider",
                        model: "standard",
                        retries: 0,
                        timeoutSecs: 60,
                        graphVersion: 4,
                    },
                }),
            )
            await bridge.idle()
            writeFileSync(
                join(dir, "outbox", "block.json"),
                JSON.stringify({
                    leaseId: "lease-S6",
                    kind: "block",
                    blockId: "block-S6-S11",
                    requiredStoryIds: ["S11"],
                    reason: "iterateWithAbort must integrate first",
                }),
            )

            const blocked = await waitFor(env.events, WorkBlocked.is)
            assert.deepEqual(blocked.data, {
                runId,
                blockId: "block-S6-S11",
                storyId: "S6",
                leaseId: "lease-S6",
                generation: 2,
                requiredStoryIds: ["S11"],
                reason: "iterateWithAbort must integrate first",
            })
            const accepted = WorkBlockAccepted.create({
                ...blocked.data,
                graphVersion: 5,
            })
            env.deliverSemanticEvent(attacker, accepted)
            await bridge.idle()
            const decisionPath = join(dir, "decisions", "block-S6-S11.json")
            assert.equal(existsSync(decisionPath), false)

            env.deliverSemanticEvent(board, accepted)
            await waitForPath(decisionPath)
            assert.deepEqual(JSON.parse(readFileSync(decisionPath, "utf8")), {
                status: "accepted",
                ...accepted.data,
            })
        })
    })

    it("closes pending block and replan waits when the run completes", async () => {
        await withTempDir("collaboration-bridge-complete-pending-", async (dir) => {
            const runId = "run-complete-pending"
            const broker = source("broker")
            const board = source("board")
            const bridge = new CollaborationBridge({
                runId,
                sessionDir: dir,
                pollMs: 5,
                unsafeAllowFilesystemTransport: true,
            })
            bridge.setLeaseAuthority(broker)
            bridge.setDecisionAuthority(board)
            const env = joinWithCapture(bridge)
            env.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: "offer-S1",
                    leaseId: "lease-secret-S1",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "work",
                        model: "standard",
                        retries: 0,
                        timeoutSecs: 60,
                        graphVersion: 2,
                    },
                }),
            )
            await bridge.idle()
            writeFileSync(
                join(dir, "outbox", "block-pending.json"),
                JSON.stringify({
                    leaseId: "lease-secret-S1",
                    kind: "block",
                    blockId: "block-pending",
                    requiredStoryIds: ["S2"],
                    reason: "S2 is required",
                }),
            )
            writeFileSync(
                join(dir, "outbox", "replan-pending.json"),
                JSON.stringify({
                    leaseId: "lease-secret-S1",
                    kind: "replan",
                    proposalId: "replan-pending",
                    baseGraphVersion: 2,
                    mutation: {
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: { S1: ["S2"] },
                    },
                    reason: "rewire pending work",
                }),
            )
            await waitFor(env.events, WorkBlocked.is)
            await waitFor(env.events, RuntimeReplanProposed.is)

            env.deliverSemanticEvent(
                board,
                RunCompleted.create({
                    runId,
                    success: false,
                    completedStories: [],
                    failedStories: ["S1"],
                    totalDurationSecs: 1,
                    totalAttempts: 1,
                    abortReason: "test completion",
                }),
            )
            const blockDecision = join(dir, "decisions", "block-pending.json")
            const replanDecision = join(dir, "decisions", "replan-pending.json")
            await waitForPath(blockDecision)
            await waitForPath(replanDecision)
            assert.equal(
                JSON.parse(readFileSync(blockDecision, "utf8")).code,
                "run_completed",
            )
            assert.equal(
                JSON.parse(readFileSync(replanDecision, "utf8")).code,
                "run_completed",
            )
        })
    })

    it("binds broker inboxes and decisions to exact live lease capabilities", async () => {
        await withTempDir("collaboration-broker-capability-", async (dir) => {
            const runId = "run-broker-capability"
            const broker = source("broker")
            const board = source("board")
            const bridge = new CollaborationBridge({ runId, sessionDir: dir })
            bridge.setLeaseAuthority(broker)
            bridge.setDecisionAuthority(board)
            const env = joinWithCapture(bridge)
            await bridge.ready()

            grantLease(env, broker, runId, "S1", "lease-S1", 1, 3)
            grantLease(env, broker, runId, "S2", "lease-S2", 1, 3)
            await bridge.idle()
            const first = bridge.capabilityForLease({
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                deliveryMode: "poll",
            })
            const second = bridge.capabilityForLease({
                runId,
                storyId: "S2",
                leaseId: "lease-S2",
                generation: 1,
                deliveryMode: "poll",
            })

            const sent = await brokerFetch(first, "/v1/events", {
                method: "POST",
                body: {
                    kind: "message",
                    eventId: "event-capability-message",
                    to: "S2",
                    text: "only S2 may consume this",
                },
            })
            assert.equal(sent.status, 202)
            const recipientInbox = await brokerFetch(second, "/v1/inbox")
            assert.equal(recipientInbox.status, 200)
            assert.equal(recipientInbox.value.messages.length, 1)
            assert.match(
                JSON.stringify(recipientInbox.value.messages),
                /only S2 may consume this/,
            )
            await acknowledgeInbox(second, recipientInbox.value.messages)
            const consumed = await brokerFetch(second, "/v1/inbox")
            assert.deepEqual(consumed.value.messages, [])
            const senderInbox = await brokerFetch(first, "/v1/inbox")
            assert.deepEqual(senderInbox.value.messages, [])

            const proposalId = "replan-capability-owner"
            const proposal = await brokerFetch(first, "/v1/events", {
                method: "POST",
                body: {
                    kind: "replan",
                    proposalId,
                    baseGraphVersion: 3,
                    mutation: {
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: {},
                    },
                    reason: "verify decision ownership",
                },
            })
            assert.equal(proposal.status, 202)
            assert.equal(
                (await brokerFetch(
                    second,
                    `/v1/decisions/${proposalId}?waitMs=1`,
                )).status,
                404,
            )
            assert.equal(
                (await brokerFetch(
                    first,
                    `/v1/decisions/${proposalId}?waitMs=1`,
                )).status,
                202,
            )

            releaseLease(env, broker, runId, "S1", "lease-S1")
            await bridge.idle()
            assert.equal(
                (await brokerFetch(first, "/v1/events", {
                    method: "POST",
                    body: {
                        kind: "note",
                        eventId: "event-stale-note",
                        text: "stale",
                    },
                })).status,
                401,
            )
            const liveNote = {
                kind: "note",
                eventId: "event-live-note",
                text: "still live",
            }
            assert.equal((await brokerFetch(second, "/v1/events", {
                method: "POST",
                body: liveNote,
            })).status, 202)
            const duplicate = await brokerFetch(second, "/v1/events", {
                method: "POST",
                body: liveNote,
            })
            assert.equal(duplicate.status, 202)
            assert.equal(duplicate.value.duplicate, true)
            assert.equal(duplicate.value.originalStatus, 202)
            assert.equal(
                (await brokerFetch(second, "/v1/events", {
                    method: "POST",
                    body: { ...liveNote, text: "conflicting payload" },
                })).status,
                422,
            )
            await bridge.idle()
            assert.equal(
                env.events.filter(
                    (event) =>
                        CollaborationNote.is(event) &&
                        event.data.text === "still live",
                ).length,
                1,
            )
            assert.equal(existsSync(join(dir, "outbox")), false)
            assert.equal(existsSync(join(dir, "inbox")), false)
            assert.equal(existsSync(join(dir, "decisions")), false)
            await bridge.shutdown()
        })
    })

    it("selects exactly one model-facing delivery lane for live and poll workers", async () => {
        await withTempDir("collaboration-broker-delivery-mode-", async (dir) => {
            const runId = "run-broker-delivery-mode"
            const broker = source("broker")
            const operator = source("operator")
            const bridge = new CollaborationBridge({ runId, sessionDir: dir })
            bridge.setLeaseAuthority(broker)
            bridge.setMessageIntentAuthorities([operator])
            const env = joinWithCapture(bridge)
            await bridge.ready()
            grantLease(env, broker, runId, "S-live", "lease-live", 1, 2)
            grantLease(env, broker, runId, "S-poll", "lease-poll", 1, 2)
            await bridge.idle()

            env.deliverSemanticEvent(
                operator,
                AgentTargetedMessage.create({
                    recipientId: "S-live",
                    text: "bootstrap live message",
                    metadata: { source: "operator" },
                }),
            )
            env.deliverSemanticEvent(
                operator,
                AgentTargetedMessage.create({
                    recipientId: "S-poll",
                    text: "bootstrap poll message",
                    metadata: { source: "operator" },
                }),
            )
            await bridge.idle()
            const live = bridge.capabilityForLease({
                runId,
                storyId: "S-live",
                leaseId: "lease-live",
                generation: 1,
                deliveryMode: "live",
            })
            assert.deepEqual(live.initialMessages, ["bootstrap live message"])
            assert.equal((await brokerFetch(live, "/v1/inbox")).status, 409)
            env.deliverSemanticEvent(
                operator,
                AgentTargetedMessage.create({
                    recipientId: "S-live",
                    text: "future live message",
                    metadata: { source: "operator" },
                }),
            )

            const poll = bridge.capabilityForLease({
                runId,
                storyId: "S-poll",
                leaseId: "lease-poll",
                generation: 1,
                deliveryMode: "poll",
            })
            assert.deepEqual(poll.initialMessages, ["bootstrap poll message"])
            assert.deepEqual(
                (await brokerFetch(poll, "/v1/inbox")).value.messages,
                [],
            )
            env.deliverSemanticEvent(
                operator,
                AgentTargetedMessage.create({
                    recipientId: "S-poll",
                    text: "poll-only message",
                    metadata: { source: "operator" },
                }),
            )
            await bridge.idle()
            const firstPoll = await brokerFetch(poll, "/v1/inbox")
            assert.equal(firstPoll.value.messages.length, 1)
            assert.match(JSON.stringify(firstPoll.value), /poll-only message/)
            await acknowledgeInbox(poll, firstPoll.value.messages)
            assert.deepEqual(
                (await brokerFetch(poll, "/v1/inbox")).value.messages,
                [],
            )

            const correlated = env.events
                .filter(AgentTargetedMessage.is)
                .filter((event) => event.data.runId === runId)
            for (const text of [
                "bootstrap live message",
                "bootstrap poll message",
                "future live message",
                "poll-only message",
            ]) {
                assert.equal(
                    correlated.filter((event) => event.data.text === text).length,
                    1,
                )
            }
            await bridge.shutdown()
        })
    })

    it("revalidates a capability after a delayed request body", async () => {
        await withTempDir("collaboration-broker-body-race-", async (dir) => {
            const runId = "run-broker-body-race"
            const broker = source("broker")
            const bridge = new CollaborationBridge({ runId, sessionDir: dir })
            bridge.setLeaseAuthority(broker)
            const env = joinWithCapture(bridge)
            await bridge.ready()
            grantLease(env, broker, runId, "S1", "lease-S1", 1, 2)
            await bridge.idle()
            const capability = bridge.capabilityForLease({
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                deliveryMode: "poll",
            })
            const body = JSON.stringify({
                kind: "note",
                eventId: "event-delayed-note",
                text: "must not survive release",
            })
            const delayed = delayedBrokerPost(capability, body)
            await delayed.headersSent
            releaseLease(env, broker, runId, "S1", "lease-S1")
            await bridge.idle()
            delayed.finish()
            const response = await delayed.response
            assert.equal(response.status, 401)
            assert.equal(
                env.events.some(
                    (event) =>
                        CollaborationNote.is(event) &&
                        event.data.text === "must not survive release",
                ),
                false,
            )
            await bridge.shutdown()
        })
    })

    it("settles an authenticated pending decision before run-wide revocation", async () => {
        await withTempDir("collaboration-broker-run-complete-", async (dir) => {
            const runId = "run-broker-complete"
            const broker = source("broker")
            const board = source("board")
            const bridge = new CollaborationBridge({ runId, sessionDir: dir })
            bridge.setLeaseAuthority(broker)
            bridge.setDecisionAuthority(board)
            const env = joinWithCapture(bridge)
            await bridge.ready()
            grantLease(env, broker, runId, "S1", "lease-S1", 1, 4)
            await bridge.idle()
            const capability = bridge.capabilityForLease({
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                deliveryMode: "poll",
            })
            const proposalId = "replan-run-complete"
            assert.equal(
                (await brokerFetch(capability, "/v1/events", {
                    method: "POST",
                    body: {
                        kind: "replan",
                        proposalId,
                        baseGraphVersion: 4,
                        mutation: {
                            addedStories: [],
                            removedStoryIds: [],
                            modifiedDeps: {},
                        },
                        reason: "pending at completion",
                    },
                })).status,
                202,
            )
            const pending = brokerFetch(
                capability,
                `/v1/decisions/${proposalId}?waitMs=2000`,
            )
            // Let the long poll authenticate and register its waiter before
            // the terminal event closes the listening socket.
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            env.deliverSemanticEvent(
                board,
                RunCompleted.create({
                    runId,
                    success: false,
                    completedStories: [],
                    failedStories: ["S1"],
                    totalDurationSecs: 1,
                    totalAttempts: 1,
                    abortReason: "test completion",
                }),
            )
            const settled = await pending
            assert.equal(settled.status, 200)
            assert.equal(settled.value.decision.code, "run_completed")
            await bridge.shutdown()
        })
    })

    it("rejects pre-launch overflow without duplicating accepted poll context", async () => {
        await withTempDir("collaboration-broker-prelaunch-bound-", async (dir) => {
            const runId = "run-broker-prelaunch-bound"
            const broker = source("broker")
            const bridge = new CollaborationBridge({ runId, sessionDir: dir })
            bridge.setLeaseAuthority(broker)
            const env = joinWithCapture(bridge)
            await bridge.ready()
            grantLease(env, broker, runId, "S1", "lease-S1", 1, 2)
            grantLease(env, broker, runId, "S2", "lease-S2", 1, 2)
            await bridge.idle()
            const sender = bridge.capabilityForLease({
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                deliveryMode: "poll",
            })
            let rejectedBody: Record<string, unknown> | null = null
            for (let index = 0; index < 33; index += 1) {
                const body = {
                    kind: "message",
                    eventId: `event-prelaunch-${index}`,
                    to: "S2",
                    text: `prelaunch-${index}`,
                }
                const response = await brokerFetch(sender, "/v1/events", {
                    method: "POST",
                    body,
                })
                if (index < 32) {
                    assert.equal(response.status, 202)
                } else {
                    assert.equal(response.status, 429)
                    assert.equal(response.value.ok, false)
                    assert.equal(response.value.status, "delivery_gap")
                    assert.deepEqual(response.value.deliveryGaps, ["S2"])
                    rejectedBody = body
                }
            }

            const recipient = bridge.capabilityForLease({
                runId,
                storyId: "S2",
                leaseId: "lease-S2",
                generation: 1,
                deliveryMode: "poll",
            })
            assert.equal(recipient.initialMessages.length, 33)
            assert.equal(recipient.initialMessages[0], "prelaunch-0")
            assert.equal(recipient.initialMessages.includes("prelaunch-32"), false)
            assert.match(
                recipient.initialMessages.at(-1) ?? "",
                /COLLABORATION DELIVERY GAP.*1 message/u,
            )
            assert.deepEqual(
                (await brokerFetch(recipient, "/v1/inbox")).value.messages,
                [],
            )
            assert.deepEqual(
                bridge.capabilityForLease({
                    runId,
                    storyId: "S2",
                    leaseId: "lease-S2",
                    generation: 1,
                    deliveryMode: "poll",
                }).initialMessages,
                [],
            )

            assert.ok(rejectedBody)
            const retry = await brokerFetch(sender, "/v1/events", {
                method: "POST",
                body: rejectedBody,
            })
            assert.equal(retry.status, 429)
            assert.equal(retry.value.duplicate, true)
            assert.equal(retry.value.originalStatus, 429)
            assert.deepEqual(
                bridge.capabilityForLease({
                    runId,
                    storyId: "S2",
                    leaseId: "lease-S2",
                    generation: 1,
                    deliveryMode: "poll",
                }).initialMessages,
                [],
            )
            await bridge.shutdown()
        })
    })

    it("bounds broker inboxes without evicting unacknowledged messages", async () => {
        await withTempDir("collaboration-broker-inbox-bound-", async (dir) => {
            const runId = "run-broker-inbox-bound"
            const broker = source("broker")
            const bridge = new CollaborationBridge({ runId, sessionDir: dir })
            bridge.setLeaseAuthority(broker)
            const env = joinWithCapture(bridge)
            await bridge.ready()
            grantLease(env, broker, runId, "S1", "lease-S1", 1, 2)
            grantLease(env, broker, runId, "S2", "lease-S2", 1, 2)
            await bridge.idle()
            const sender = bridge.capabilityForLease({
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                deliveryMode: "poll",
            })
            const recipient = bridge.capabilityForLease({
                runId,
                storyId: "S2",
                leaseId: "lease-S2",
                generation: 1,
                deliveryMode: "poll",
            })
            const accepted: number[] = []
            const rejected: number[] = []
            let firstRejectedBody: Record<string, unknown> | null = null
            for (let index = 0; index < 10; index += 1) {
                const body = {
                    kind: "message",
                    eventId: `event-inbox-bound-${index}`,
                    to: "S2",
                    text: `marker-${index}-` + "x".repeat(7_000),
                }
                const response = await brokerFetch(sender, "/v1/events", {
                    method: "POST",
                    body,
                })
                if (response.status === 202) {
                    accepted.push(index)
                } else {
                    assert.equal(response.status, 429)
                    assert.equal(response.value.ok, false)
                    assert.equal(response.value.status, "delivery_gap")
                    assert.deepEqual(response.value.deliveryGaps, ["S2"])
                    rejected.push(index)
                    firstRejectedBody ??= body
                }
            }
            assert.ok(accepted.length > 0)
            assert.ok(rejected.length > 0)
            const inbox = await brokerFetch(recipient, "/v1/inbox")
            const serialized = JSON.stringify(inbox.value.messages)
            assert.ok(Buffer.byteLength(serialized, "utf8") <= 48 * 1024)
            assert.match(serialized, /marker-0-/)
            assert.doesNotMatch(serialized, new RegExp(`marker-${rejected[0]}-`))
            const gap = inbox.value.messages.find(
                (message: { type?: string }) =>
                    message.type === "collaboration_delivery_gap",
            )
            assert.ok(gap)
            assert.equal(gap.data.rejectedCount, rejected.length)

            assert.ok(firstRejectedBody)
            const duplicate = await brokerFetch(sender, "/v1/events", {
                method: "POST",
                body: firstRejectedBody,
            })
            assert.equal(duplicate.status, 429)
            assert.equal(duplicate.value.duplicate, true)
            assert.equal(duplicate.value.originalStatus, 429)
            const repeatedInbox = await brokerFetch(recipient, "/v1/inbox")
            const repeatedGap = repeatedInbox.value.messages.find(
                (message: { type?: string }) =>
                    message.type === "collaboration_delivery_gap",
            )
            assert.equal(repeatedGap.deliveryId, gap.deliveryId)
            assert.equal(repeatedGap.data.rejectedCount, rejected.length)

            await acknowledgeInbox(recipient, inbox.value.messages)
            assert.deepEqual(
                (await brokerFetch(recipient, "/v1/inbox")).value.messages,
                [],
            )
            await bridge.shutdown()
        })
    })

    it("persists surrogate and long story ids inside a random challenge envelope", async () => {
        await withTempDir("collaboration-broker-challenge-id-", async (dir) => {
            const runId = "run-broker-challenge-id"
            const broker = source("broker")
            const inflight = join(dir, "inflight")
            const storyId = `S-${"x".repeat(600)}-\ud800`
            const firstBridge = new CollaborationBridge({
                runId,
                sessionDir: join(dir, "epoch-1"),
                challengeInflightDir: inflight,
                goalInvariantIds: ["G-A1"],
            })
            firstBridge.setLeaseAuthority(broker)
            const firstEnv = joinWithCapture(firstBridge)
            await firstBridge.ready()
            grantLease(firstEnv, broker, runId, storyId, "lease-long", 1, 2)
            await firstBridge.idle()
            const capability = firstBridge.capabilityForLease({
                runId,
                storyId,
                leaseId: "lease-long",
                generation: 1,
                deliveryMode: "poll",
            })
            assert.equal(
                (await brokerFetch(capability, "/v1/events", {
                    method: "POST",
                    body: {
                        kind: "challenge",
                        challengeId: "challenge-unknown-invariant",
                        invariantId: "G-A2",
                        reason: "must not become an immortal retained record",
                    },
                })).status,
                400,
            )
            assert.deepEqual(readdirSync(inflight), [])
            assert.equal(
                (await brokerFetch(capability, "/v1/events", {
                    method: "POST",
                    body: {
                        kind: "challenge",
                        challengeId: "challenge-long-id",
                        invariantId: "G-A1",
                        reason: "durable attribution must be lossless",
                    },
                })).status,
                202,
            )
            const first = await waitFor(
                firstEnv.events,
                GoalInvariantChallengeRaised.is,
            )
            assert.equal(first.data.raisedBy, storyId)
            const duplicate = await brokerFetch(capability, "/v1/events", {
                method: "POST",
                body: {
                    kind: "challenge",
                    challengeId: "challenge-long-id",
                    invariantId: "G-A1",
                    reason: "durable attribution must be lossless",
                },
            })
            assert.equal(duplicate.status, 202)
            assert.equal(duplicate.value.duplicate, true)
            assert.equal(
                (await brokerFetch(capability, "/v1/events", {
                    method: "POST",
                    body: {
                        kind: "challenge",
                        challengeId: "challenge-long-id",
                        invariantId: "G-A1",
                        reason: "conflicting evidence under the same id",
                    },
                })).status,
                422,
            )
            const retainedNames = readdirSync(inflight)
            assert.equal(retainedNames.length, 1)
            assert.match(
                retainedNames[0]!,
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/,
            )
            await firstBridge.shutdown()

            const secondBridge = new CollaborationBridge({
                runId,
                sessionDir: join(dir, "epoch-2"),
                challengeInflightDir: inflight,
                pollMs: 5,
            })
            const secondEnv = joinWithCapture(secondBridge)
            await secondBridge.ready()
            const replay = await waitFor(
                secondEnv.events,
                GoalInvariantChallengeRaised.is,
            )
            assert.equal(replay.data.raisedBy, storyId)
            await secondBridge.shutdown()
        })
    })

    it("bounds shutdown even when an authenticated client never finishes its body", async () => {
        await withTempDir("collaboration-broker-shutdown-", async (dir) => {
            const runId = "run-broker-shutdown"
            const broker = source("broker")
            const bridge = new CollaborationBridge({ runId, sessionDir: dir })
            bridge.setLeaseAuthority(broker)
            const env = joinWithCapture(bridge)
            await bridge.ready()
            grantLease(env, broker, runId, "S1", "lease-S1", 1, 2)
            await bridge.idle()
            const capability = bridge.capabilityForLease({
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
                deliveryMode: "poll",
            })
            const stalled = stalledBrokerPost(capability)
            await stalled.headersSent
            const startedAt = Date.now()
            await bridge.shutdown()
            assert.ok(Date.now() - startedAt < 3_000)
            await stalled.settled
        })
    })
})

interface TestCapability {
    endpoint: string
    token: string
}

function grantLease(
    env: ReturnType<typeof joinWithCapture>,
    broker: ReturnType<typeof source>,
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
    graphVersion: number,
): void {
    env.deliverSemanticEvent(
        broker,
        WorkLeaseGranted.create({
            runId,
            offerId: `offer-${leaseId}`,
            leaseId,
            workerId: "worker",
            generation,
            request: {
                storyId,
                prompt: storyId,
                model: "standard",
                retries: 0,
                timeoutSecs: 60,
                graphVersion,
            },
        }),
    )
}

function releaseLease(
    env: ReturnType<typeof joinWithCapture>,
    broker: ReturnType<typeof source>,
    runId: string,
    storyId: string,
    leaseId: string,
): void {
    env.deliverSemanticEvent(
        broker,
        WorkLeaseReleased.create({
            runId,
            offerId: `offer-${leaseId}`,
            leaseId,
            storyId,
            workerId: "worker",
            reason: "test release",
        }),
    )
}

async function brokerFetch(
    capability: TestCapability,
    path: string,
    init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; value: any; raw: string }> {
    const response = await fetch(`${capability.endpoint}${path}`, {
        method: init.method ?? "GET",
        headers: {
            authorization: `Bearer ${capability.token}`,
            ...(init.body === undefined
                ? {}
                : { "content-type": "application/json" }),
        },
        ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
    })
    const raw = await response.text()
    return {
        status: response.status,
        value: raw ? JSON.parse(raw) : null,
        raw,
    }
}

async function acknowledgeInbox(
    capability: TestCapability,
    messages: Array<{ deliveryId: string }>,
): Promise<void> {
    const response = await brokerFetch(capability, "/v1/inbox/ack", {
        method: "POST",
        body: { deliveryIds: messages.map((message) => message.deliveryId) },
    })
    assert.equal(response.status, 200)
    assert.equal(response.value.acknowledged, messages.length)
}

function delayedBrokerPost(capability: TestCapability, body: string): {
    headersSent: Promise<void>
    finish: () => void
    response: Promise<{ status: number; body: string }>
} {
    let finish!: () => void
    let resolveHeaders!: () => void
    const headersSent = new Promise<void>((resolve) => {
        resolveHeaders = resolve
    })
    const response = new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
            const target = new URL("/v1/events", capability.endpoint)
            const request = httpRequest(
                target,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${capability.token}`,
                        "content-type": "application/json",
                        "content-length": Buffer.byteLength(body),
                    },
                },
                (incoming) => {
                    incoming.setEncoding("utf8")
                    let value = ""
                    incoming.on("data", (chunk: string) => {
                        value += chunk
                    })
                    incoming.on("end", () => {
                        resolve({ status: incoming.statusCode ?? 0, body: value })
                    })
                },
            )
            request.once("error", reject)
            const midpoint = Math.max(1, Math.floor(body.length / 2))
            request.write(body.slice(0, midpoint), () => {
                setTimeout(resolveHeaders, 20)
            })
            finish = () => request.end(body.slice(midpoint))
        },
    )
    return { headersSent, finish, response }
}

function stalledBrokerPost(capability: TestCapability): {
    headersSent: Promise<void>
    settled: Promise<void>
} {
    let resolveHeaders!: () => void
    const headersSent = new Promise<void>((resolve) => {
        resolveHeaders = resolve
    })
    const settled = new Promise<void>((resolve) => {
        const request = httpRequest(
            new URL("/v1/events", capability.endpoint),
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${capability.token}`,
                    "content-type": "application/json",
                    "content-length": "1000",
                },
            },
            (incoming) => {
                incoming.resume()
                incoming.once("end", resolve)
            },
        )
        request.once("error", () => resolve())
        request.write("{", () => setTimeout(resolveHeaders, 20))
    })
    return { headersSent, settled }
}

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
