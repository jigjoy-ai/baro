import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    Coordination,
    Critique,
    StoryIntervention,
} from "../../../src/semantic-events.js"
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
                type: "critique",
                id: "S9",
                verdict: "fail",
                reasoning: "missing test coverage",
                violated: ["tests"],
            },
            // story_log mirror stays for one release alongside `critique`.
            {
                type: "story_log",
                id: "S9",
                line: "[critic/fail] missing test coverage",
            },
        ])
    })

    it("emits structured intervention plus its story_log mirror", async () => {
        const forwarder = new CoordinationForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("supervisor"),
                StoryIntervention.create({
                    storyId: "S7",
                    source: "supervisor",
                    action: "abort",
                    reason: "stalled for 10m",
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events[0], {
            type: "intervention",
            id: "S7",
            source: "supervisor",
            action: "abort",
            reason: "stalled for 10m",
        })
        // story_log + activity mirrors stay for one release.
        assert.deepEqual(
            events.slice(1).map((e) => e.type),
            ["story_log", "activity"],
        )
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
