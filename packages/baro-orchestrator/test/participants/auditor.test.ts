import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { ModelMessageItem } from "@mozaik-ai/core"

import { AgentState, ClaudeStreamChunk } from "../../src/semantic-events.js"
import { Auditor } from "../../src/participants/auditor.js"
import { source, withTempDir } from "./helpers.js"

function readJsonl(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("Auditor", () => {
    it("writes semantic events and model messages to JSONL", async () => {
        await withTempDir("baro-auditor-", async (dir) => {
            const logPath = join(dir, "audit", "events.jsonl")
            const auditor = new Auditor({ path: logPath })
            const agent = source("S1")

            await auditor.onExternalEvent(
                agent,
                AgentState.create({ agentId: "S1", phase: "running", detail: "reading" }),
            )
            await auditor.onExternalModelMessage(
                agent,
                ModelMessageItem.rehydrate({ text: "model answer" }),
            )

            const entries = readJsonl(logPath)
            assert.equal(entries.length, 2)
            assert.equal(entries[0].source, "Object:S1")
            assert.deepEqual(entries[0].item, {
                type: "agent_state",
                data: { agentId: "S1", phase: "running", detail: "reading" },
            })
            assert.deepEqual(entries[1].item, {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "model answer" }],
            })
        })
    })

    it("skips stream chunks by default", async () => {
        await withTempDir("baro-auditor-", async (dir) => {
            const logPath = join(dir, "audit.jsonl")
            const auditor = new Auditor({ path: logPath })

            await auditor.onExternalEvent(
                source("S1"),
                ClaudeStreamChunk.create({ agentId: "S1", raw: { delta: "x" } }),
            )

            assert.equal(existsSync(logPath), false)
        })
    })
})
