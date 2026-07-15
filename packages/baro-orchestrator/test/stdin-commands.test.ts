import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { Operator } from "../src/participants/operator.js"
import {
    AgentTargetedMessage,
    ConversationRequested,
} from "../src/semantic-events.js"
import {
    handleStdinCommand,
    type PlanningFeed,
} from "../src/stdin-commands.js"
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
                type: "conversation_request",
                message_id: "user-message-1",
                text: "What is the collective doing?",
            },
            {
                type: "story_log",
                id: "_dialogue",
                line: "[you → collective] What is the collective doing?",
            },
        ])
    })
})

describe("stdin progressive-planning commands", () => {
    function planningHarness() {
        const received: Array<{ method: keyof PlanningFeed; command: BaroCommand }> = []
        const feed: PlanningFeed = {
            open: (command) => received.push({ method: "open", command }),
            fragment: (command) => received.push({ method: "fragment", command }),
            complete: (command) => received.push({ method: "complete", command }),
            failed: (command) => received.push({ method: "failed", command }),
        }
        const ctx = {
            getOperator: () => null,
            getPlanningFeed: () => feed,
        }
        return { received, feed, ctx }
    }

    it("delegates every correlated lifecycle command without rewriting it", () => {
        const { received, ctx } = planningHarness()
        const commands: BaroCommand[] = [
            {
                type: "planning_open",
                run_id: "run-7",
                planning_id: "planning-3",
            },
            {
                type: "plan_fragment",
                run_id: "run-7",
                planning_id: "planning-3",
                fragment_id: "fragment-1",
                ordinal: 1,
                stories: [{ id: "S1", acceptance: ["works"] }],
            },
            {
                type: "plan_complete",
                run_id: "run-7",
                planning_id: "planning-3",
                final_prd: { project: "progressive", userStories: [] },
            },
            {
                type: "plan_failed",
                run_id: "run-7",
                planning_id: "planning-3",
                code: "planner_crashed",
                reason: "planner process exited with code 1",
            },
        ]

        for (const command of commands) handleStdinCommand(command, ctx)

        assert.deepEqual(received, [
            { method: "open", command: commands[0] },
            { method: "fragment", command: commands[1] },
            { method: "complete", command: commands[2] },
            { method: "failed", command: commands[3] },
        ])
        assert.equal(received[0]?.command, commands[0])
        assert.equal(received[1]?.command, commands[1])
        assert.equal(received[2]?.command, commands[2])
        assert.equal(received[3]?.command, commands[3])
    })

    it("is a safe no-op before a planning feed is attached", () => {
        const commands: BaroCommand[] = [
            { type: "planning_open", run_id: "run-1", planning_id: "plan-1" },
            {
                type: "plan_fragment",
                run_id: "run-1",
                planning_id: "plan-1",
                fragment_id: "fragment-1",
                ordinal: 1,
                stories: [],
            },
            {
                type: "plan_complete",
                run_id: "run-1",
                planning_id: "plan-1",
                final_prd: null,
            },
            {
                type: "plan_failed",
                run_id: "run-1",
                planning_id: "plan-1",
                code: "unavailable",
                reason: "not attached yet",
            },
        ]

        assert.doesNotThrow(() => {
            for (const command of commands) {
                handleStdinCommand(command, { getOperator: () => null })
            }
        })
    })

    it("contains exceptions from a late-bound feed", () => {
        const command: BaroCommand = {
            type: "planning_open",
            run_id: "run-1",
            planning_id: "plan-1",
        }

        assert.doesNotThrow(() =>
            handleStdinCommand(command, {
                getOperator: () => null,
                getPlanningFeed: () => {
                    throw new Error("feed startup failed")
                },
            }),
        )
        assert.doesNotThrow(() =>
            handleStdinCommand(command, {
                getOperator: () => null,
                getPlanningFeed: () => ({
                    open: () => {
                        throw new Error("feed rejected command")
                    },
                    fragment: () => {},
                    complete: () => {},
                    failed: () => {},
                }),
            }),
        )
    })
})
