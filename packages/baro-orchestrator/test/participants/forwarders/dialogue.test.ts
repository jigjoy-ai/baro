import assert from "node:assert/strict"
import { it } from "node:test"

import { DialogueForwarder } from "../../../src/participants/forwarders/dialogue.js"
import {
    ConversationFailed,
    ConversationResponded,
} from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { joinWithCapture, source } from "../helpers.js"

it("forwards dialogue output only from the bound participant", () => {
    const authority = source("dialogue")
    const observer = source("observer")
    const output: BaroEvent[] = []
    const forwarder = new DialogueForwarder(authority, (event) => output.push(event))
    const env = joinWithCapture(forwarder)
    const response = ConversationResponded.create({
        runId: "run-1",
        messageId: "message-1",
        agentId: "dialogue",
        text: "One worker is active.",
        actions: [{ kind: "message", recipientId: "S1", text: "Run tests." }],
    })

    env.deliverSemanticEvent(observer, response)
    env.deliverSemanticEvent(authority, response)
    env.deliverSemanticEvent(
        authority,
        ConversationFailed.create({
            runId: "run-1",
            messageId: "message-2",
            agentId: "dialogue",
            error: "responder failed",
        }),
    )

    assert.deepEqual(output, [
        { type: "activity", id: "_dialogue", kind: "agent_msg", text: "One worker is active." },
        { type: "story_log", id: "_dialogue", line: "[collective] One worker is active." },
        { type: "activity", id: "_dialogue", kind: "agent_msg", text: "→ S1: Run tests." },
        { type: "story_log", id: "_dialogue", line: "[collective → S1] Run tests." },
        { type: "activity", id: "_dialogue", kind: "error", text: "responder failed", ok: false },
        { type: "story_log", id: "_dialogue", line: "[collective/unavailable] responder failed" },
    ])
})
