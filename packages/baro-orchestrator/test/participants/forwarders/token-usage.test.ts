import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { AgentResult, CodexTurnEvent } from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { TokenUsageForwarder } from "../../../src/participants/forwarders/token-usage.js"
import { captureStdout, source } from "../helpers.js"

function parseEvents(lines: string[]): BaroEvent[] {
    return lines.map((line) => JSON.parse(line) as BaroEvent)
}

describe("TokenUsageForwarder", () => {
    it("emits token_usage events for Claude and Codex totals", async () => {
        const forwarder = new TokenUsageForwarder()
        const agent = source("S1")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                agent,
                AgentResult.create({
                    agentId: "S1",
                    subtype: "success",
                    sessionId: "session-1",
                    isError: false,
                    resultText: "done",
                    usage: { input_tokens: 11, output_tokens: 7 },
                    totalCostUsd: null,
                    numTurns: null,
                    durationMs: null,
                }),
            )
            await forwarder.onExternalEvent(
                agent,
                CodexTurnEvent.create({
                    agentId: "S2",
                    phase: "completed",
                    raw: {
                        usage: {
                            input_tokens: 13,
                            output_tokens: 5,
                            reasoning_output_tokens: 3,
                        },
                    },
                }),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "token_usage",
                id: "S1",
                input_tokens: 11,
                output_tokens: 7,
            },
            {
                type: "token_usage",
                id: "S2",
                input_tokens: 13,
                output_tokens: 8,
            },
        ])
    })
})
