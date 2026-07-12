import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ModelMessageItem } from "@mozaik-ai/core"

import { AgentTurnProjector } from "../../src/participants/agent-turn-projector.js"
import {
    AgentTurnCompleted,
    CodexTurnEvent,
    OpenCodeSystem,
    PiTurnEvent,
    StoryRouted,
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
                    backend: "opencode",
                    isError: false,
                    resultText: "OpenCode done",
                    canContinue: false,
                },
                {
                    agentId: "P",
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
    })
})
