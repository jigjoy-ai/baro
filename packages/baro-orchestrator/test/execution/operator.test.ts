import { describe, it } from "@rstest/core"
import assert from "node:assert/strict"

import { Operator } from "../../src/execution/operator.js"
import { AgentTargetedMessage } from "../../src/semantic-events.js"
import { joinWithCapture } from "./helpers.js"

describe("Operator", () => {
    it("ignores redirect commands until it has joined an environment", () => {
        const operator = new Operator()

        assert.doesNotThrow(() => {
            operator.dispatch({
                kind: "redirect",
                storyId: "S1",
                message: "No environment yet.",
            })
        })
    })

    it("translates redirect commands into targeted semantic messages", () => {
        const operator = new Operator()
        const env = joinWithCapture(operator)

        operator.dispatch({
            kind: "redirect",
            storyId: "S2",
            message: "Focus on the failing test first.",
        })

        assert.equal(env.events.length, 1)
        const event = env.events[0]
        assert.equal(AgentTargetedMessage.is(event), true)
        if (!AgentTargetedMessage.is(event)) return

        assert.deepEqual(event.payload, {
            recipientId: "S2",
            text: "Focus on the failing test first.",
            metadata: { source: "operator" },
        })
    })
})
