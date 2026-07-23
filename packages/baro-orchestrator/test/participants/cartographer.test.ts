import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { ModelMessageItem } from "../../src/runtime/mozaik.js"

import { AgentState, ClaudeStreamChunk } from "../../src/semantic-events.js"
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

    it("emits stream chunk frames only when enabled", async () => {
        const defaultFrames: Frame[] = []
        const defaultCartographer = new Cartographer({
            sink: (frame) => defaultFrames.push(frame),
        })

        await defaultCartographer.onExternalEvent(
            source("S1"),
            ClaudeStreamChunk.create({ agentId: "S1", raw: { delta: "hidden" } }),
        )

        assert.deepEqual(defaultFrames, [])

        const frames: Frame[] = []
        const cartographer = new Cartographer({
            emitStreamChunks: true,
            sink: (frame) => frames.push(frame),
        })

        await cartographer.onExternalEvent(
            source("S1"),
            ClaudeStreamChunk.create({ agentId: "S1", raw: { delta: "visible" } }),
        )

        assert.deepEqual(frames, [{ kind: "stream_chunk", agentId: "S1" }])
    })
})
