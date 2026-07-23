import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ModelMessageItem } from "../../src/runtime/mozaik.js"

import { AgentTurnProjector } from "../../src/participants/agent-turn-projector.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import {
    AgentTurnCompleted,
    CodexTurnEvent,
    OneShotAttemptFinalized,
    OpenCodeSystem,
    PiTurnEvent,
    StoryQualityReverificationRequested,
    StoryRouted,
    WorkLeaseGranted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("AgentTurnProjector", () => {
    it("projects a completed Codex turn with accumulated assistant text", async () => {
        const projector = new AgentTurnProjector()
        const env = joinWithCapture(projector)
        const codex = source("S1")

        await projector.onExternalEvent(
            source("factory"),
            StoryRouted.create({
                storyId: "S1",
                backend: "codex",
                model: "gpt-5.3-codex",
            }),
        )
        await projector.onExternalModelMessage(
            codex,
            ModelMessageItem.rehydrate({ text: "first part" }),
        )
        await projector.onExternalModelMessage(
            codex,
            ModelMessageItem.rehydrate({ text: "second part" }),
        )
        await projector.onExternalEvent(
            codex,
            CodexTurnEvent.create({
                agentId: "S1",
                phase: "completed",
                raw: {},
            }),
        )

        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 1)
        assert.deepEqual(projected[0]?.data, {
            agentId: "S1",
            terminalId: "projected:S1:1",
            backend: "codex",
            isError: false,
            resultText: "first part\nsecond part",
            canContinue: false,
        })
    })

    it("marks a failed Codex terminal turn as an error", async () => {
        const projector = new AgentTurnProjector()
        const env = joinWithCapture(projector)

        await projector.onExternalModelMessage(
            source("S1"),
            ModelMessageItem.rehydrate({ text: "partial answer" }),
        )
        await projector.onExternalEvent(
            source("S1"),
            CodexTurnEvent.create({
                agentId: "S1",
                phase: "failed",
                raw: { error: "backend failed" },
            }),
        )

        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 1)
        assert.equal(projected[0]?.data.backend, "codex")
        assert.equal(projected[0]?.data.isError, true)
        assert.equal(projected[0]?.data.resultText, "partial answer")
        assert.equal(projected[0]?.data.canContinue, false)
    })

    it("projects OpenCode step_finish and Pi assistant message_end", async () => {
        const projector = new AgentTurnProjector()
        const env = joinWithCapture(projector)

        await projector.onExternalModelMessage(
            source("OC"),
            ModelMessageItem.rehydrate({ text: "OpenCode done" }),
        )
        await projector.onExternalEvent(
            source("OC"),
            OpenCodeSystem.create({
                agentId: "OC",
                subtype: "step_finish",
                raw: {},
            }),
        )

        await projector.onExternalModelMessage(
            source("P"),
            ModelMessageItem.rehydrate({ text: "Pi done" }),
        )
        // A user message ending is lifecycle noise, not a terminal assistant turn.
        await projector.onExternalEvent(
            source("P"),
            PiTurnEvent.create({
                agentId: "P",
                turnType: "message_end",
                raw: { message: { role: "user" } },
            }),
        )
        await projector.onExternalEvent(
            source("P"),
            PiTurnEvent.create({
                agentId: "P",
                turnType: "message_end",
                raw: { message: { role: "assistant" } },
            }),
        )

        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 2)
        assert.deepEqual(
            projected.map((event) => event.data),
            [
                {
                    agentId: "OC",
                    terminalId: "projected:OC:1",
                    backend: "opencode",
                    isError: false,
                    resultText: "OpenCode done",
                    canContinue: false,
                },
                {
                    agentId: "P",
                    terminalId: "projected:P:1",
                    backend: "pi",
                    isError: false,
                    resultText: "Pi done",
                    canContinue: false,
                },
            ],
        )
    })

    it("suppresses a replayed terminal event but allows a newly started turn", async () => {
        const projector = new AgentTurnProjector()
        const env = joinWithCapture(projector)
        const codex = source("S1")
        const completed = CodexTurnEvent.create({
            agentId: "S1",
            phase: "completed",
            raw: {},
        })

        await projector.onExternalModelMessage(
            codex,
            ModelMessageItem.rehydrate({ text: "first turn" }),
        )
        await projector.onExternalEvent(codex, completed)
        await projector.onExternalEvent(codex, completed)

        assert.equal(env.events.filter(AgentTurnCompleted.is).length, 1)

        await projector.onExternalEvent(
            codex,
            CodexTurnEvent.create({
                agentId: "S1",
                phase: "started",
                raw: {},
            }),
        )
        await projector.onExternalModelMessage(
            codex,
            ModelMessageItem.rehydrate({ text: "second turn" }),
        )
        await projector.onExternalEvent(codex, completed)

        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 2)
        assert.equal(projected[1]?.data.resultText, "second turn")
        assert.equal(projected[0]?.data.terminalId, "projected:S1:1")
        assert.equal(projected[1]?.data.terminalId, "projected:S1:2")
    })

    it("rejects forged native sources without disturbing replay identity", async () => {
        const authority = new StoryOutcomeAuthority("run-1")
        const worker = source("S1")
        const nativeCli = source("S1")
        const attacker = source("S1")
        const correlation = {
            runId: "run-1",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }
        authority.registerResultAuthority(correlation, worker)
        authority.registerTerminalAuthority(correlation, nativeCli)

        const projector = new AgentTurnProjector({ outcomeAuthority: authority })
        const env = joinWithCapture(projector)
        const completed = CodexTurnEvent.create({
            agentId: "S1",
            phase: "completed",
            raw: {},
        })

        await projector.onExternalModelMessage(
            nativeCli,
            ModelMessageItem.rehydrate({ text: "first real turn" }),
        )
        await projector.onExternalEvent(nativeCli, completed)

        await projector.onExternalEvent(
            attacker,
            CodexTurnEvent.create({ agentId: "S1", phase: "started", raw: {} }),
        )
        await projector.onExternalModelMessage(
            attacker,
            ModelMessageItem.rehydrate({ text: "forged turn" }),
        )
        await projector.onExternalEvent(attacker, completed)
        await projector.onExternalEvent(nativeCli, completed)

        let projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 1)
        assert.equal(projected[0]?.data.terminalId, "projected:S1:1")
        assert.equal(projected[0]?.data.resultText, "first real turn")

        await projector.onExternalEvent(
            nativeCli,
            CodexTurnEvent.create({ agentId: "S1", phase: "started", raw: {} }),
        )
        await projector.onExternalModelMessage(
            nativeCli,
            ModelMessageItem.rehydrate({ text: "second real turn" }),
        )
        await projector.onExternalEvent(nativeCli, completed)

        projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 2)
        assert.equal(projected[1]?.data.terminalId, "projected:S1:2")
        assert.equal(projected[1]?.data.resultText, "second real turn")
    })

    it("accepts collective route metadata only from the exact leased factory", async () => {
        const runId = "run-route-authority"
        const broker = source("broker")
        const factory = source("factory")
        const attacker = source("factory")
        const worker = source("S1")
        const nativeCli = source("S1")
        const authority = new StoryOutcomeAuthority(runId)
        const correlation = {
            runId,
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }
        authority.registerSpawnAuthority(correlation, factory)
        authority.registerResultAuthority(correlation, worker)
        authority.registerTerminalAuthority(correlation, nativeCli)
        const projector = new AgentTurnProjector({ outcomeAuthority: authority })
        projector.setLeaseAuthority(broker)
        const env = joinWithCapture(projector)
        env.deliverSemanticEvent(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: "offer-1",
                leaseId: "lease-1",
                workerId: "worker",
                generation: 1,
                request: {
                    storyId: "S1",
                    prompt: "work",
                    retries: 0,
                    timeoutSecs: 60,
                },
            }),
        )
        const route = StoryRouted.create({
            storyId: "S1",
            backend: "codex",
            model: "gpt-test",
            runId,
            leaseId: "lease-1",
            generation: 1,
        })
        env.deliverSemanticEvent(
            attacker,
            StoryRouted.create({
                ...route.data,
                backend: "claude",
                model: "forged-model",
            }),
        )
        env.deliverSemanticEvent(factory, route)
        await projector.onExternalModelMessage(
            nativeCli,
            ModelMessageItem.rehydrate({ text: "real candidate" }),
        )
        await projector.onExternalEvent(
            nativeCli,
            CodexTurnEvent.create({
                agentId: "S1",
                phase: "completed",
                raw: {},
            }),
        )

        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 1)
        assert.equal(projected[0]?.data.backend, "codex")
    })

    it("publishes a collective one-shot candidate only behind the exact quiescence barrier", async () => {
        const runId = "run-quiescence-barrier"
        const broker = source("broker")
        const worker = source("S1")
        const nativeCli = source("S1")
        const attacker = source("S1")
        const authority = new StoryOutcomeAuthority(runId)
        const correlation = {
            runId,
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }
        authority.registerResultAuthority(correlation, worker)
        authority.registerTerminalAuthority(correlation, nativeCli)
        const projector = new AgentTurnProjector({
            outcomeAuthority: authority,
            requireQuiescenceBarrier: true,
        })
        projector.setLeaseAuthority(broker)
        const env = joinWithCapture(projector)
        env.deliverSemanticEvent(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: "offer-1",
                leaseId: correlation.leaseId,
                workerId: "worker",
                generation: correlation.generation,
                request: {
                    storyId: correlation.storyId,
                    prompt: "work",
                    retries: 0,
                    timeoutSecs: 60,
                },
            }),
        )

        await projector.onExternalModelMessage(
            nativeCli,
            ModelMessageItem.rehydrate({ text: "stable candidate bytes" }),
        )
        await projector.onExternalEvent(
            nativeCli,
            CodexTurnEvent.create({
                agentId: correlation.storyId,
                phase: "completed",
                raw: {},
            }),
        )
        assert.equal(env.events.filter(AgentTurnCompleted.is).length, 0)

        const finalized = OneShotAttemptFinalized.create({
            ...correlation,
            attempt: 1,
            disposition: "publish",
            ownedProcessGroup: true,
            quiescenceAssurance: "cooperative-observed",
        })
        env.deliverSemanticEvent(attacker, finalized)
        env.deliverSemanticEvent(
            worker,
            OneShotAttemptFinalized.create({
                ...finalized.data,
                generation: 0,
            }),
        )
        assert.equal(env.events.filter(AgentTurnCompleted.is).length, 0)

        env.deliverSemanticEvent(worker, finalized)
        env.deliverSemanticEvent(worker, finalized)
        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 1)
        assert.equal(projected[0]?.data.resultText, "stable candidate bytes")
        assert.equal(
            projected[0]?.data.terminalId,
            "quiesced:run-quiescence-barrier:S1:lease-1:1:1",
        )

        const retryCli = source("S1")
        authority.registerTerminalAuthority(correlation, retryCli)
        await projector.onExternalModelMessage(
            retryCli,
            ModelMessageItem.rehydrate({ text: "second candidate bytes" }),
        )
        await projector.onExternalEvent(
            retryCli,
            CodexTurnEvent.create({
                agentId: correlation.storyId,
                phase: "completed",
                raw: {},
            }),
        )
        env.deliverSemanticEvent(worker, finalized)
        assert.equal(env.events.filter(AgentTurnCompleted.is).length, 1)

        env.deliverSemanticEvent(
            worker,
            OneShotAttemptFinalized.create({
                ...finalized.data,
                attempt: 2,
            }),
        )
        const retried = env.events.filter(AgentTurnCompleted.is)
        assert.equal(retried.length, 2)
        assert.equal(retried[1]?.data.resultText, "second candidate bytes")
        assert.equal(
            retried[1]?.data.terminalId,
            "quiesced:run-quiescence-barrier:S1:lease-1:1:2",
        )
    })

    it("does not publish a superseded CLI terminal for a silent retry", async () => {
        const runId = "run-superseded-terminal"
        const broker = source("broker")
        const worker = source("S1")
        const firstCli = source("S1")
        const silentRetryCli = source("S1")
        const authority = new StoryOutcomeAuthority(runId)
        const correlation = {
            runId,
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }
        authority.registerResultAuthority(correlation, worker)
        authority.registerTerminalAuthority(correlation, firstCli)
        const projector = new AgentTurnProjector({
            outcomeAuthority: authority,
            requireQuiescenceBarrier: true,
        })
        projector.setLeaseAuthority(broker)
        const env = joinWithCapture(projector)
        env.deliverSemanticEvent(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: "offer-1",
                leaseId: correlation.leaseId,
                workerId: "worker",
                generation: correlation.generation,
                request: {
                    storyId: correlation.storyId,
                    prompt: "work",
                    retries: 1,
                    timeoutSecs: 60,
                },
            }),
        )

        // Attempt one can settle without a projected terminal (for example an
        // abort won before the provider's buffered terminal reached the bus).
        env.deliverSemanticEvent(
            worker,
            OneShotAttemptFinalized.create({
                ...correlation,
                attempt: 1,
                disposition: "discard",
                ownedProcessGroup: true,
                quiescenceAssurance: "cooperative-observed",
            }),
        )

        // Its old CLI then races in a buffered terminal while it is still the
        // registered source, so the projector stages it as attempt two.
        await projector.onExternalModelMessage(
            firstCli,
            ModelMessageItem.rehydrate({ text: "late first-attempt text" }),
        )
        await projector.onExternalEvent(
            firstCli,
            CodexTurnEvent.create({
                agentId: correlation.storyId,
                phase: "completed",
                raw: {},
            }),
        )

        // Registration is the attempt boundary even if the successor emits no
        // terminal event of its own.
        authority.registerTerminalAuthority(correlation, silentRetryCli)
        env.deliverSemanticEvent(
            worker,
            OneShotAttemptFinalized.create({
                ...correlation,
                attempt: 2,
                disposition: "publish",
                ownedProcessGroup: true,
                quiescenceAssurance: "cooperative-observed",
            }),
        )

        assert.equal(env.events.filter(AgentTurnCompleted.is).length, 0)
    })

    it("does not mix output across registered CLI retry sources", async () => {
        const authority = new StoryOutcomeAuthority("run-1")
        const worker = source("S1")
        const firstCli = source("S1")
        const retryCli = source("S1")
        const correlation = {
            runId: "run-1",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }
        authority.registerResultAuthority(correlation, worker)
        authority.registerTerminalAuthority(correlation, firstCli)

        const projector = new AgentTurnProjector({ outcomeAuthority: authority })
        const env = joinWithCapture(projector)
        await projector.onExternalModelMessage(
            firstCli,
            ModelMessageItem.rehydrate({ text: "abandoned first attempt" }),
        )

        authority.registerTerminalAuthority(correlation, retryCli)
        await projector.onExternalModelMessage(
            retryCli,
            ModelMessageItem.rehydrate({ text: "retry output" }),
        )
        await projector.onExternalEvent(
            retryCli,
            CodexTurnEvent.create({ agentId: "S1", phase: "completed", raw: {} }),
        )

        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 1)
        assert.equal(projected[0]?.data.resultText, "retry output")
        assert.equal(projected[0]?.data.terminalId, "projected:S1:1")
    })

    it("replays only the exact active candidate for the bound gate", async () => {
        const runId = "run-reverify-authority"
        const broker = source("broker")
        const gate = source("acceptance-gate")
        const attacker = source("acceptance-gate")
        const codex = source("S1")
        const projector = new AgentTurnProjector()
        projector.setLeaseAuthority(broker)
        projector.setReverificationAuthority(gate)
        const env = joinWithCapture(projector)

        env.deliverSemanticEvent(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: "offer-S1",
                leaseId: "lease-1",
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
        await projector.onExternalModelMessage(
            codex,
            ModelMessageItem.rehydrate({ text: "candidate bytes A" }),
        )
        await projector.onExternalEvent(
            codex,
            CodexTurnEvent.create({
                agentId: "S1",
                phase: "completed",
                raw: {},
            }),
        )
        const original = env.events.find(AgentTurnCompleted.is)!

        const request = StoryQualityReverificationRequested.create({
            runId,
            requestId: "reverify-1",
            previousEvaluationId: "quality-1",
            evaluationId: "quality-2",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 3,
            targetTurn: 1,
            terminalId: original.data.terminalId,
            attempt: 1,
            reason: "critic unavailable",
        })
        env.deliverSemanticEvent(attacker, request)
        env.deliverSemanticEvent(
            gate,
            StoryQualityReverificationRequested.create({
                ...request.data,
                requestId: "stale-generation",
                generation: 2,
            }),
        )
        env.deliverSemanticEvent(
            gate,
            StoryQualityReverificationRequested.create({
                ...request.data,
                requestId: "wrong-terminal",
                terminalId: "some-other-candidate",
            }),
        )
        assert.equal(env.events.filter(AgentTurnCompleted.is).length, 1)

        env.deliverSemanticEvent(gate, request)
        env.deliverSemanticEvent(gate, request)

        const projected = env.events.filter(AgentTurnCompleted.is)
        assert.equal(projected.length, 2)
        assert.equal(projected[1]?.data.resultText, original.data.resultText)
        assert.equal(projected[1]?.data.backend, original.data.backend)
        assert.equal(projected[1]?.data.canContinue, false)
        assert.notEqual(projected[1]?.data.terminalId, original.data.terminalId)
        assert.match(projected[1]?.data.terminalId ?? "", /^reverification:/)
    })
})
