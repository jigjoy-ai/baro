import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { ModelMessageItem } from "../../src/runtime/mozaik.js"

import {
    AgentState,
    ClaudeStreamChunk,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../src/semantic-events.js"
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

    it("fingerprints lease bearers consistently and keeps the log private", async () => {
        await withTempDir("baro-auditor-lease-", async (dir) => {
            const logPath = join(dir, "audit.jsonl")
            const auditor = new Auditor({ path: logPath })
            const rawLease = "run:lease:raw-secret-bearer"

            await auditor.onExternalEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run",
                    offerId: "offer-S1",
                    leaseId: rawLease,
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: `node helper emit --lease "${rawLease}" --kind note`,
                        retries: 0,
                        timeoutSecs: 30,
                    },
                }),
            )
            await auditor.onExternalEvent(
                source("broker"),
                WorkLeaseReleased.create({
                    runId: "run",
                    offerId: "offer-S1",
                    leaseId: rawLease,
                    storyId: "S1",
                    workerId: "worker",
                    reason: "aborted",
                }),
            )

            const raw = readFileSync(logPath, "utf8")
            assert.doesNotMatch(raw, new RegExp(rawLease))
            const fingerprints = raw.match(/audit-lease:[a-f0-9]{24}/g) ?? []
            assert.ok(fingerprints.length >= 3)
            assert.equal(new Set(fingerprints).size, 1)
            if (process.platform !== "win32") {
                assert.equal(statSync(logPath).mode & 0o777, 0o600)
            }
        })
    })

    it("applies custom filters before writing entries", async () => {
        await withTempDir("baro-auditor-", async (dir) => {
            const logPath = join(dir, "audit.jsonl")
            const auditor = new Auditor({
                path: logPath,
                filter: (participant) =>
                    (participant as unknown as { agentId?: string }).agentId === "S2",
            })

            await auditor.onExternalEvent(
                source("S1"),
                AgentState.create({ agentId: "S1", phase: "running" }),
            )
            await auditor.onExternalEvent(
                source("S2"),
                AgentState.create({ agentId: "S2", phase: "done" }),
            )

            const entries = readJsonl(logPath)
            assert.equal(entries.length, 1)
            assert.equal(entries[0].source, "Object:S2")
            assert.deepEqual(entries[0].item, {
                type: "agent_state",
                data: { agentId: "S2", phase: "done" },
            })
        })
    })
})
