import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { ModelMessageItem } from "@mozaik-ai/core"

import { AgentState } from "../../src/semantic-events.js"
import { Cartographer, type Frame } from "../../src/participants/cartographer.js"
import { source } from "./helpers.js"

describe("Cartographer", () => {
    it("maps semantic state and model messages to frames", async () => {
        const frames: Frame[] = []
        const cartographer = new Cartographer({ sink: (frame) => frames.push(frame) })
        const agent = source("S1")

        await cartographer.onExternalEvent(
            agent,
            AgentState.create({ agentId: "S1", phase: "running", detail: "thinking" }),
        )
        await cartographer.onExternalModelMessage(
            agent,
            ModelMessageItem.rehydrate({ text: "hello from model" }),
        )

        assert.deepEqual(frames, [
            {
                kind: "agent_state",
                agentId: "S1",
                phase: "running",
                detail: "thinking",
            },
            {
                kind: "model_message",
                agentId: "S1",
                text: "hello from model",
            },
        ])
    })
})
