import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { Operator } from "../../src/participants/operator.js"
import { AgentTargetedMessage } from "../../src/semantic-events.js"
import { joinWithCapture } from "./helpers.js"

describe("Operator", () => {
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

        assert.deepEqual(event.data, {
            recipientId: "S2",
            text: "Focus on the failing test first.",
            metadata: { source: "operator" },
        })
    })

    it("routes abort and shutdown commands to hooks", () => {
        const calls: string[] = []
        const operator = new Operator({
            onAbort: (storyId) => calls.push(`abort:${storyId}`),
            onAbortAll: () => calls.push("abort_all"),
            onShutdown: () => calls.push("shutdown"),
        })
        joinWithCapture(operator)

        operator.dispatch({ kind: "abort", storyId: "S3" })
        operator.dispatch({ kind: "abort_all" })
        operator.dispatch({ kind: "shutdown" })

        assert.deepEqual(calls, ["abort:S3", "abort_all", "shutdown"])
    })
})
