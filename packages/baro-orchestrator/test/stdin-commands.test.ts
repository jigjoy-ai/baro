import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { Operator } from "../src/participants/operator.js"
import {
    AgentTargetedMessage,
    ConversationRequested,
} from "../src/semantic-events.js"
import { handleStdinCommand } from "../src/stdin-commands.js"
import type { BaroCommand, BaroEvent } from "../src/tui-protocol.js"
import { joinWithCapture } from "./participants/helpers.js"

function wired() {
    const operator = new Operator({}, { runId: "run-stdin" })
    const env = joinWithCapture(operator)
    const emitted: BaroEvent[] = []
    const ctx = {
        getOperator: () => operator,
        emitEvent: (ev: BaroEvent) => emitted.push(ev),
    }
    return { operator, env, emitted, ctx }
}

describe("stdin agent_message commands", () => {
    it("reaches the bus as a user-sourced AgentTargetedMessage and mirrors a story_log", () => {
        const { env, emitted, ctx } = wired()

        handleStdinCommand(
            { type: "agent_message", id: "S2", text: "focus on the failing spec" },
            ctx,
        )

        assert.equal(env.events.length, 1)
        const event = env.events[0]
        assert.equal(AgentTargetedMessage.is(event), true)
        if (!AgentTargetedMessage.is(event)) return
        assert.deepEqual(event.data, {
            recipientId: "S2",
            text: "focus on the failing spec",
            metadata: { source: "user" },
        })

        assert.deepEqual(emitted, [
            { type: "story_log", id: "S2", line: "[you → S2] focus on the failing spec" },
        ])
    })

    it("drops unknown types, blank payloads, and pre-bus messages without throwing", () => {
        const { env, emitted, ctx } = wired()

        handleStdinCommand({ type: "abort_all" }, ctx)
        handleStdinCommand({ type: "agent_message", id: "S2", text: "   " }, ctx)
        handleStdinCommand(
            { type: "agent_message", id: "", text: "hi" } as BaroCommand,
            ctx,
        )
        // Not-yet-ready operator (startup window).
        handleStdinCommand(
            { type: "agent_message", id: "S2", text: "hi" },
            { getOperator: () => null, emitEvent: ctx.emitEvent },
        )

        assert.equal(env.events.length, 0)
        assert.equal(emitted.length, 0)
    })

    it("routes dialogue messages through Operator without targeting a story", () => {
        const { env, emitted, ctx } = wired()

        handleStdinCommand(
            {
                type: "dialogue_message",
                message_id: "user-message-1",
                text: "What is the collective doing?",
            },
            ctx,
        )

        const requests = env.events.filter(ConversationRequested.is)
        assert.equal(requests.length, 1)
        assert.deepEqual(requests[0]?.data, {
            runId: "run-stdin",
            messageId: "user-message-1",
            text: "What is the collective doing?",
            source: "user",
        })
        assert.deepEqual(emitted, [
            {
                type: "story_log",
                id: "_dialogue",
                line: "[you → collective] What is the collective doing?",
            },
        ])
    })
})
