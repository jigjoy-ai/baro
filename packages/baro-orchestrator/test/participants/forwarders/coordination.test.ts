import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Coordination, Critique } from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { CoordinationForwarder } from "../../../src/participants/forwarders/coordination.js"
import { captureStdout, source } from "../helpers.js"

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
                type: "story_log",
                id: "S9",
                line: "[critic/fail] missing test coverage",
            },
        ])
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
})
