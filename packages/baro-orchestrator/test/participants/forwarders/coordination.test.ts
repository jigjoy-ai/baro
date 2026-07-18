import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { SemanticEvent } from "@mozaik-ai/core"

import {
    CollaborationNote,
    Coordination,
    CoordinationModeSelected,
    Critique,
    PeerHelpRequested,
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
    StoryIntervention,
    StoryQualityCompleted,
    WorkClaimed,
    WorkDiscovered,
    WorkLeaseExpired,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkOffered,
} from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { CoordinationForwarder } from "../../../src/participants/forwarders/coordination.js"
import { captureStdout, source } from "../helpers.js"

type RequiredCollectiveFamily = "board" | "broker" | "verifier" | "bridge"
type OptionalCollectiveFamily = "coordination" | "quality" | "intervention"

interface CollectivePresentationCase {
    name: string
    family: RequiredCollectiveFamily | OptionalCollectiveFamily
    event: SemanticEvent<unknown>
    expectedText: string
}

function requiredCollectivePresentationCases(): CollectivePresentationCase[] {
    const request = {
        storyId: "S1",
        prompt: "implement S1",
        model: "standard",
        retries: 1,
        timeoutSecs: 60,
    }
    return [
        {
            name: "board coordination mode",
            family: "board",
            event: CoordinationModeSelected.create({
                runId: "run-1",
                mode: "collective",
            }),
            expectedText: "[coordination] collective",
        },
        {
            name: "board work offer",
            family: "board",
            event: WorkOffered.create({
                runId: "run-1",
                offerId: "offer-1",
                generation: 1,
                priority: 10,
                request,
            }),
            expectedText: "work offered (offer-1)",
        },
        {
            name: "board verification request",
            family: "board",
            event: RunVerificationRequested.create({
                runId: "run-1",
                verificationId: "verify-1",
            }),
            expectedText: "[verify] started (verify-1)",
        },
        {
            name: "board verification timeout",
            family: "board",
            event: RunVerificationTimedOut.create({
                runId: "run-1",
                verificationId: "verify-1",
                timeoutMs: 12_000,
            }),
            expectedText: "verification timed out after 12s",
        },
        {
            name: "broker lease grant",
            family: "broker",
            event: WorkLeaseGranted.create({
                runId: "run-1",
                offerId: "offer-1",
                leaseId: "lease-1",
                workerId: "worker-1",
                generation: 1,
                request,
                route: {
                    routeId: "claude:sonnet",
                    backend: "claude",
                    model: "sonnet",
                },
            }),
            expectedText: "lease granted to worker-1 → claude:sonnet",
        },
        {
            name: "broker lease expiry",
            family: "broker",
            event: WorkLeaseExpired.create({
                runId: "run-1",
                offerId: "offer-1",
                leaseId: "lease-1",
                storyId: "S1",
                workerId: "worker-1",
                reason: "lease deadline",
            }),
            expectedText: "lease expired: lease deadline",
        },
        {
            name: "verifier completion",
            family: "verifier",
            event: RunVerificationCompleted.create({
                runId: "run-1",
                verificationId: "verify-1",
                status: "passed",
                commands: [{
                    command: "node --test",
                    status: "passed",
                    durationMs: 1,
                }],
                durationMs: 1,
            }),
            expectedText: "node --test: passed",
        },
        {
            name: "bridge help",
            family: "bridge",
            event: PeerHelpRequested.create({
                runId: "run-1",
                sourceAgentId: "S1",
                text: "real help",
            }),
            expectedText: "[peer/help] real help",
        },
        {
            name: "bridge note",
            family: "bridge",
            event: CollaborationNote.create({
                runId: "run-1",
                sourceAgentId: "S1",
                text: "real note",
            }),
            expectedText: "[peer/note] real note",
        },
        {
            name: "bridge discovery",
            family: "bridge",
            event: WorkDiscovered.create({
                runId: "run-1",
                sourceAgentId: "S1",
                leaseId: "lease-1",
                generation: 1,
                reason: "real discovery",
                story: {
                    id: "S2",
                    title: "Follow-up",
                    description: "Implement the discovered follow-up.",
                    dependsOn: ["S1"],
                    acceptance: ["follow-up is complete"],
                    tests: ["node --test"],
                },
            }),
            expectedText: "[peer/discovered] S2: real discovery",
        },
    ]
}

function optionalCollectivePresentationCases(): CollectivePresentationCase[] {
    return [
        {
            name: "sentry coordination",
            family: "coordination",
            event: Coordination.create({
                fromAgentId: "sentry",
                recipientId: "S1",
                kind: "notice",
                reason: "optional coordination",
                payload: {},
            }),
            expectedText: "[sentry/notice] optional coordination",
        },
        {
            name: "acceptance-gate critique projection",
            family: "quality",
            event: StoryQualityCompleted.create({
                runId: "run-1",
                evaluationId: "quality-S1-1",
                storyId: "S1",
                leaseId: "lease-1",
                generation: 1,
                status: "passed",
                targetTurn: 1,
                reason: "optional critique",
                critique: {
                    verdict: "pass",
                    reasoning: "optional critique",
                    violatedCriteria: [],
                    turn: 1,
                    modelUsed: "critic",
                },
            }),
            expectedText: "[critic/pass] optional critique",
        },
        {
            name: "supervisor intervention",
            family: "intervention",
            event: StoryIntervention.create({
                storyId: "S1",
                source: "supervisor",
                action: "abort",
                reason: "optional intervention",
            }),
            expectedText: "optional intervention",
        },
    ]
}

function rawWorkClaim(): SemanticEvent<unknown> {
    return WorkClaimed.create({
        runId: "run-1",
        offerId: "offer-1",
        storyId: "S1",
        workerId: "worker-1",
        backend: "claude",
        model: "sonnet",
    })
}

describe("CoordinationForwarder", () => {
    it("emits story_log BaroEvents for coordination notices and critiques", async () => {
        const forwarder = new CoordinationForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("sentry"),
                Coordination.create({
                    fromAgentId: "sentry",
                    recipientId: "S9",
                    kind: "wait",
                    reason: "blocked by S8",
                    payload: {},
                }),
            )
            await forwarder.onExternalEvent(
                source("critic"),
                Critique.create({
                    agentId: "S9",
                    verdict: "fail",
                    reasoning: "missing test coverage",
                    violatedCriteria: ["tests"],
                    turn: 1,
                    modelUsed: "test-model",
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            {
                type: "story_log",
                id: "S9",
                line: "[sentry/wait] blocked by S8",
            },
            {
                type: "critique",
                id: "S9",
                verdict: "fail",
                reasoning: "missing test coverage",
                violated: ["tests"],
            },
            // story_log mirror stays for one release alongside `critique`.
            {
                type: "story_log",
                id: "S9",
                line: "[critic/fail] missing test coverage",
            },
        ])
    })

    it("emits structured intervention plus its story_log mirror", async () => {
        const forwarder = new CoordinationForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("supervisor"),
                StoryIntervention.create({
                    storyId: "S7",
                    source: "supervisor",
                    action: "abort",
                    reason: "stalled for 10m",
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events[0], {
            type: "intervention",
            id: "S7",
            source: "supervisor",
            action: "abort",
            reason: "stalled for 10m",
        })
        // story_log + activity mirrors stay for one release.
        assert.deepEqual(
            events.slice(1).map((e) => e.type),
            ["story_log", "activity"],
        )
    })

    it("source-binds intervention UI evidence when an authority is configured", async () => {
        const forwarder = new CoordinationForwarder()
        const supervisor = source("supervisor")
        forwarder.setInterventionAuthority(supervisor)
        forwarder.setInterventionAuthority(supervisor)
        assert.throws(
            () => forwarder.setInterventionAuthority(source("supervisor")),
            /already bound/,
        )
        const intervention = StoryIntervention.create({
            storyId: "S7",
            source: "supervisor",
            action: "abort",
            reason: "exact authority only",
        })

        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(source("supervisor"), intervention)
            await forwarder.onExternalEvent(supervisor, intervention)
        })

        assert.equal(lines.length, 3)
        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.equal(events[0]?.type, "intervention")
    })

    it("emits exact story_log shape for merge coordination", async () => {
        const forwarder = new CoordinationForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("conductor"),
                Coordination.create({
                    fromAgentId: "conductor",
                    recipientId: "S4",
                    kind: "merge",
                    reason: "shared dependency complete",
                    payload: { level: 2 },
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            {
                type: "story_log",
                id: "S4",
                line: "[sentry/merge] shared dependency complete",
            },
        ])
    })

    it("surfaces objective run verification without claiming a skipped pass", async () => {
        const forwarder = new CoordinationForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("board"),
                RunVerificationRequested.create({
                    runId: "run-1",
                    verificationId: "verify-1",
                }),
            )
            await forwarder.onExternalEvent(
                source("verifier"),
                RunVerificationCompleted.create({
                    runId: "run-1",
                    verificationId: "verify-1",
                    status: "skipped",
                    commands: [],
                    durationMs: 1,
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events.map((event) => event.type), [
            "activity",
            "story_log",
            "activity",
            "story_log",
        ])
        const completion = events[2]
        assert.equal(completion.type, "activity")
        if (completion.type === "activity") {
            assert.equal(completion.ok, undefined)
            assert.match(completion.text, /verification skipped/i)
        }
    })

    it("source-binds every required collective presentation family", async () => {
        const forwarder = new CoordinationForwarder(true)
        const board = source("board")
        const broker = source("broker")
        const verifier = source("verifier")
        const bridge = source("bridge")
        forwarder.sealCollectiveAuthorities({
            runId: "run-1",
            board,
            broker,
            verifier,
            bridge,
        })
        assert.throws(
            () => forwarder.sealCollectiveAuthorities({
                runId: "run-1",
                board,
                broker,
                verifier,
                bridge,
            }),
            /already sealed/,
        )

        const authorities = { runId: "run-1", board, broker, verifier, bridge }
        const cases = requiredCollectivePresentationCases()

        const forgedLines = await captureStdout(async () => {
            for (const item of cases) {
                await forwarder.onExternalEvent(
                    source(`forged-${item.family}`),
                    item.event,
                )
            }
        })
        assert.deepEqual(forgedLines, [])

        const acceptedLines = await captureStdout(async () => {
            for (const item of cases) {
                await forwarder.onExternalEvent(
                    authorities[item.family as RequiredCollectiveFamily],
                    item.event,
                )
            }
        })
        const transcript = acceptedLines.join("\n")
        for (const item of cases) {
            assert.equal(
                transcript.includes(item.expectedText),
                true,
                `${item.name} was not presented by its authority`,
            )
        }

        const rawClaimLines = await captureStdout(async () => {
            await forwarder.onExternalEvent(source("claim-forger"), rawWorkClaim())
            await forwarder.onExternalEvent(broker, rawWorkClaim())
        })
        assert.deepEqual(
            rawClaimLines,
            [],
            "raw WorkClaimed must not be presented after collective authorities are sealed",
        )
    })

    it("source-binds configured optional families and disables absent ones", async () => {
        const board = source("board")
        const broker = source("broker")
        const verifier = source("verifier")
        const bridge = source("bridge")
        const coordination = source("sentry")
        const quality = source("acceptance-gate")
        const intervention = source("supervisor")
        const authorities = {
            runId: "run-1",
            board,
            broker,
            verifier,
            bridge,
            coordination,
            quality,
            intervention,
        }
        const cases = optionalCollectivePresentationCases()
        const configured = new CoordinationForwarder(true)
        configured.sealCollectiveAuthorities(authorities)
        await captureStdout(async () => {
            await configured.onExternalEvent(
                broker,
                requiredCollectivePresentationCases().find(
                    (item) => item.name === "broker lease grant",
                )!.event,
            )
        })

        const forgedLines = await captureStdout(async () => {
            for (const item of cases) {
                await configured.onExternalEvent(
                    source(`forged-${item.family}`),
                    item.event,
                )
            }
        })
        assert.deepEqual(forgedLines, [])

        const acceptedLines = await captureStdout(async () => {
            for (const item of cases) {
                await configured.onExternalEvent(
                    authorities[item.family as OptionalCollectiveFamily],
                    item.event,
                )
            }
        })
        const transcript = acceptedLines.join("\n")
        for (const item of cases) {
            assert.equal(
                transcript.includes(item.expectedText),
                true,
                `${item.name} was not presented by its configured authority`,
            )
        }

        const withoutOptionalAuthorities = new CoordinationForwarder(true)
        withoutOptionalAuthorities.sealCollectiveAuthorities({
            runId: "run-1",
            board,
            broker,
            verifier,
            bridge,
        })
        const absentLines = await captureStdout(async () => {
            for (const item of cases) {
                await withoutOptionalAuthorities.onExternalEvent(
                    authorities[item.family as OptionalCollectiveFamily],
                    item.event,
                )
            }
        })
        assert.deepEqual(
            absentLines,
            [],
            "omitted optional authorities must disable their event families",
        )
    })

    it("is deny-all for every collective presentation family before sealing", async () => {
        const forwarder = new CoordinationForwarder(true)
        const cases = [
            ...requiredCollectivePresentationCases(),
            ...optionalCollectivePresentationCases(),
        ]
        const lines = await captureStdout(async () => {
            for (const item of cases) {
                await forwarder.onExternalEvent(
                    source(`early-${item.family}-lookalike`),
                    item.event,
                )
            }
            await forwarder.onExternalEvent(source("early-worker"), rawWorkClaim())
        })
        assert.deepEqual(lines, [])
    })

    it("presents only the AcceptanceGate projection for the active collective lease", async () => {
        const forwarder = new CoordinationForwarder(true)
        const board = source("board")
        const broker = source("broker")
        const verifier = source("verifier")
        const bridge = source("bridge")
        const critic = source("critic")
        const quality = source("acceptance-gate")
        forwarder.sealCollectiveAuthorities({
            runId: "run-quality",
            board,
            broker,
            verifier,
            bridge,
            quality,
        })
        const raw = Critique.create({
            agentId: "S1",
            verdict: "pass",
            reasoning: "uncorrelated raw replay",
            violatedCriteria: [],
            turn: 1,
            modelUsed: "critic",
        })
        const projected = (evaluationId: string, generation = 2) =>
            StoryQualityCompleted.create({
                runId: "run-quality",
                evaluationId,
                storyId: "S1",
                leaseId: "lease-1",
                generation,
                status: "failed",
                targetTurn: 1,
                reason: "tests missing",
                critique: {
                    verdict: "fail",
                    reasoning: "tests missing",
                    violatedCriteria: ["tests"],
                    turn: 1,
                    modelUsed: "critic",
                },
            })
        const grant = WorkLeaseGranted.create({
            runId: "run-quality",
            offerId: "offer-1",
            leaseId: "lease-1",
            workerId: "worker",
            generation: 2,
            request: {
                storyId: "S1",
                prompt: "work",
                retries: 0,
                timeoutSecs: 60,
            },
        })

        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(critic, raw)
            await forwarder.onExternalEvent(quality, projected("before-grant"))
            await forwarder.onExternalEvent(broker, grant)
            await forwarder.onExternalEvent(source("forged-gate"), projected("forged"))
            await forwarder.onExternalEvent(quality, projected("wrong-generation", 1))
            await forwarder.onExternalEvent(quality, projected("accepted"))
            await forwarder.onExternalEvent(quality, projected("accepted"))
            await forwarder.onExternalEvent(
                broker,
                WorkLeaseReleased.create({
                    runId: "run-quality",
                    storyId: "S1",
                    leaseId: "lease-1",
                    workerId: "worker",
                    reason: "integrated",
                }),
            )
            await forwarder.onExternalEvent(quality, projected("after-release"))
        })
        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.equal(events.filter((event) => event.type === "critique").length, 1)
        assert.equal(
            events.filter(
                (event) =>
                    event.type === "story_log" &&
                    event.line.includes("tests missing"),
            ).length,
            1,
        )
        assert.equal(JSON.stringify(events).includes("uncorrelated raw replay"), false)
    })
})
