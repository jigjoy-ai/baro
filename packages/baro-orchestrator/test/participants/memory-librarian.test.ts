import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    type Participant,
} from "../../src/runtime/mozaik.js"
import type { Finding, MemoryStore } from "@baro/memory"

import { MemoryLibrarian } from "../../src/participants/memory-librarian.js"
import {
    Knowledge,
    StoryResult,
    StorySpawned,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../src/semantic-events.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { joinWithCapture, source } from "./helpers.js"

function call(
    callId: string,
    name: string,
    args: Record<string, unknown>,
): FunctionCallItem {
    return FunctionCallItem.rehydrate({ callId, name, args: JSON.stringify(args) })
}

describe("MemoryLibrarian", () => {
    it("returns no launch context when disabled", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })

        assert.equal(await librarian.gatherContext("S2", ["auth"]), null)
    })

    it("does not store or emit knowledge when disabled", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })
        const env = joinWithCapture(librarian)

        await librarian.onExternalFunctionCall(
            source("S1"),
            call("read-1", "Read", { file_path: "src/auth.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            source("S1"),
            FunctionCallOutputItem.create("read-1", "export const token = 'abc'"),
        )

        assert.deepEqual(env.events, [])
    })

    it("stays silent for story lifecycle events when disabled", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })
        const env = joinWithCapture(librarian)

        await librarian.onExternalEvent(source("conductor"), StorySpawned.create({ storyId: "S2" }))
        await librarian.onExternalEvent(
            source("S2"),
            StoryResult.create({
                storyId: "S2",
                success: false,
                attempts: 2,
                durationSecs: 10,
                error: "failed",
            }),
        )

        assert.deepEqual(env.events, [])
        assert.equal(await librarian.gatherContext("S3", ["auth"]), null)
    })

    it("removes a dependency-suspended worker from the in-flight set", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })
        const state = librarian as unknown as { inFlight: Set<string> }

        await librarian.onExternalEvent(
            source("board"),
            StorySpawned.create({ storyId: "S2" }),
        )
        assert.equal(state.inFlight.has("S2"), true)
        await librarian.onExternalEvent(
            source("S2"),
            StoryResult.create({
                storyId: "S2",
                success: false,
                attempts: 1,
                durationSecs: 2,
                error: null,
                suspension: {
                    kind: "dependency",
                    blockId: "block-S2-S1",
                },
            }),
        )

        assert.equal(state.inFlight.has("S2"), false)
    })

    it("keeps equal call ids isolated by exact participant identity", async () => {
        const remembered: Finding[] = []
        const librarian = new MemoryLibrarian()
        ;(librarian as unknown as { store: MemoryStore }).store = memoryStore({
            remembered,
        })
        const first = source("S1")
        const second = source("S2")
        const sameLabelImpostor = source("S1")

        await librarian.onExternalFunctionCall(
            first,
            call("shared-call", "Read", { file_path: "src/first.ts" }),
        )
        await librarian.onExternalFunctionCall(
            second,
            call("shared-call", "Read", { file_path: "src/second.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            sameLabelImpostor,
            FunctionCallOutputItem.create("shared-call", "forged"),
        )
        await librarian.onExternalFunctionCallOutput(
            second,
            FunctionCallOutputItem.create("shared-call", "second content"),
        )
        await librarian.onExternalFunctionCallOutput(
            first,
            FunctionCallOutputItem.create("shared-call", "first content"),
        )

        assert.deepEqual(
            remembered.map((finding) => ({
                agentId: finding.agentId,
                filePath: finding.filePath,
                content: finding.content,
            })),
            [
                {
                    agentId: "S2",
                    filePath: "src/second.ts",
                    content: "second content",
                },
                {
                    agentId: "S1",
                    filePath: "src/first.ts",
                    content: "first content",
                },
            ],
        )
    })

    it("does not expose a direct memory transport to collective workers", async () => {
        const secretSessionPath = "/private/run/memory-session"
        let cachedPathsRead = false
        const librarian = new MemoryLibrarian({
            sessionPath: secretSessionPath,
            collective: {
                runId: "run-memory-prompt",
                outcomeAuthority: new StoryOutcomeAuthority("run-memory-prompt"),
            },
        })
        ;(librarian as unknown as { store: MemoryStore }).store = memoryStore({
            gatheredContext: "A verified finding.",
            totalFindings: 1,
            onGetCachedPaths: () => {
                cachedPathsRead = true
                return [secretSessionPath]
            },
        })

        const prompt = await librarian.gatherContext("S2", ["auth"])

        assert.match(prompt ?? "", /indexed automatically/)
        assert.match(prompt ?? "", /agent-collab note/)
        assert.doesNotMatch(prompt ?? "", /baro-memory\.mjs/)
        assert.doesNotMatch(prompt ?? "", /--agent/)
        assert.doesNotMatch(prompt ?? "", /memory-session/)
        assert.equal(cachedPathsRead, false)
    })

    it("pins every advertised legacy memory command to an explicit quoted session path", async () => {
        const sessionPath = "/tmp/baro-memory/session with spaces-$HOME-`id`"
        const librarian = new MemoryLibrarian({ sessionPath })
        ;(librarian as unknown as { store: MemoryStore }).store = memoryStore()

        const prompt = await librarian.gatherContext("S2", ["auth"])
        const commandLines = (prompt ?? "")
            .split("\n")
            .filter((line) => line.includes("baro-memory.mjs"))
        const quotedPath = JSON.stringify(sessionPath)
            .replace(/\$/g, "\\$")
            .replace(/`/g, "\\`")

        assert.equal(commandLines.length, 4)
        for (const line of commandLines) {
            assert.match(line, /\b(query|cache|store)\b/)
            assert.ok(line.includes(`--path ${quotedPath}`), line)
        }
        assert.doesNotMatch(prompt ?? "", /BARO_MEMORY_PATH/)
        assert.ok(commandLines.some((line) => line.includes(" query ")))
        assert.equal(commandLines.filter((line) => line.includes(" cache ")).length, 2)
        assert.ok(commandLines.some((line) => line.includes(" store ")))
    })

    it("does not advertise cross-process memory CLI without a session path", async () => {
        const librarian = new MemoryLibrarian()
        ;(librarian as unknown as { store: MemoryStore }).store = memoryStore({
            gatheredContext: "In-process finding.",
            totalFindings: 1,
        })

        const prompt = await librarian.gatherContext("S2", ["auth"])

        assert.match(prompt ?? "", /no explicit session-scoped memory path/)
        assert.match(prompt ?? "", /In-process finding/)
        assert.doesNotMatch(prompt ?? "", /baro-memory(?:\.mjs)?/)
        assert.doesNotMatch(prompt ?? "", /BARO_MEMORY_PATH/)
        assert.doesNotMatch(prompt ?? "", /--path/)
    })

    it("preserves pending calls on grant replay and purges them on lease replacement", async () => {
        const runId = "run-memory-librarian-replacement"
        const broker = source("broker")
        const oldWorker = source("S1")
        const newWorker = source("S1")
        const outcomeAuthority = new StoryOutcomeAuthority(runId)
        outcomeAuthority.registerResultAuthority(
            { runId, storyId: "S1", leaseId: "lease-old", generation: 1 },
            oldWorker,
        )
        const remembered: Finding[] = []
        const librarian = new MemoryLibrarian({
            collective: { runId, outcomeAuthority },
        })
        librarian.setLeaseAuthority(broker)
        ;(librarian as unknown as { store: MemoryStore }).store = memoryStore({
            remembered,
        })
        const oldGrant = WorkLeaseGranted.create({
            runId,
            offerId: "offer-old",
            leaseId: "lease-old",
            workerId: "worker-old",
            generation: 1,
            request: {
                storyId: "S1",
                prompt: "old generation",
                retries: 0,
                timeoutSecs: 60,
            },
        })
        await librarian.onExternalEvent(broker, oldGrant)
        await librarian.onExternalFunctionCall(
            oldWorker,
            call("unfinished", "Read", { file_path: "src/old.ts" }),
        )
        await librarian.onExternalEvent(broker, oldGrant)
        const state = librarian as unknown as {
            pending: Map<Participant, Map<string, unknown>>
        }
        assert.equal(state.pending.get(oldWorker)?.has("unfinished"), true)

        outcomeAuthority.registerResultAuthority(
            { runId, storyId: "S1", leaseId: "lease-new", generation: 2 },
            newWorker,
        )
        await librarian.onExternalEvent(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: "offer-new",
                leaseId: "lease-new",
                workerId: "worker-new",
                generation: 2,
                request: {
                    storyId: "S1",
                    prompt: "new generation",
                    retries: 0,
                    timeoutSecs: 60,
                },
            }),
        )
        assert.equal(state.pending.get(oldWorker)?.has("unfinished") ?? false, false)
        await librarian.onExternalFunctionCallOutput(
            oldWorker,
            FunctionCallOutputItem.create("unfinished", "stale output"),
        )
        assert.equal(remembered.length, 0)
    })

    it("collective mode stores only exact active worker call/output pairs", async () => {
        const runId = "run-memory-librarian-authority"
        const broker = source("broker")
        const brokerImpostor = source("broker")
        const worker = source("S1")
        const workerImpostor = source("S1")
        const outcomeAuthority = new StoryOutcomeAuthority(runId)
        outcomeAuthority.registerResultAuthority(
            {
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
            },
            worker,
        )

        const cached: Array<{ path: string; content: string; agentId: string }> = []
        const remembered: Finding[] = []
        const store: MemoryStore = {
            async remember(finding) {
                remembered.push(finding)
                return true
            },
            async recall() { return [] },
            async gatherContext() { return null },
            async cacheFile(path, content, agentId) {
                cached.push({ path, content, agentId })
            },
            async getCachedFile() { return null },
            async hasFile() { return false },
            async getCachedPaths() { return [] },
            async getStats() {
                return {
                    totalFindings: remembered.length,
                    uniqueTools: 0,
                    uniqueAgents: 0,
                    toolsList: [],
                    agentsList: [],
                    cachedFiles: cached.length,
                    cacheSizeBytes: 0,
                }
            },
            async close() {},
        }
        const librarian = new MemoryLibrarian({
            collective: { runId, outcomeAuthority },
        })
        librarian.setLeaseAuthority(broker)
        ;(librarian as unknown as { store: MemoryStore }).store = store
        const env = joinWithCapture(librarian)
        const grant = WorkLeaseGranted.create({
            runId,
            offerId: "offer-S1",
            leaseId: "lease-S1",
            workerId: "worker",
            generation: 1,
            request: {
                storyId: "S1",
                prompt: "inspect authentication",
                model: "standard",
                retries: 0,
                timeoutSecs: 60,
            },
        })

        // Same-label sources cannot establish either half of the authority
        // chain: only the exact Broker grant activates the exact worker.
        await librarian.onExternalEvent(brokerImpostor, grant)
        await librarian.onExternalFunctionCall(
            worker,
            call("before-real-grant", "Read", { file_path: "src/early.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            worker,
            FunctionCallOutputItem.create("before-real-grant", "early"),
        )
        assert.equal(remembered.length, 0)

        await librarian.onExternalEvent(broker, grant)
        await librarian.onExternalFunctionCall(
            workerImpostor,
            call("forged", "Read", { file_path: "src/forged.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            workerImpostor,
            FunctionCallOutputItem.create("forged", "forged content"),
        )
        assert.equal(remembered.length, 0)

        await librarian.onExternalFunctionCall(
            worker,
            call("real", "Read", { file_path: "src/real.ts" }),
        )
        // An impostor cannot consume the pending genuine call either.
        await librarian.onExternalFunctionCallOutput(
            workerImpostor,
            FunctionCallOutputItem.create("real", "forged completion"),
        )
        assert.equal(remembered.length, 0)
        await librarian.onExternalFunctionCallOutput(
            worker,
            FunctionCallOutputItem.create("real", "export const real = true"),
        )

        assert.deepEqual(cached, [{
            path: "src/real.ts",
            content: "export const real = true",
            agentId: "S1",
        }])
        assert.equal(remembered.length, 1)
        assert.equal(remembered[0].filePath, "src/real.ts")
        assert.equal(env.events.filter(Knowledge.is).length, 1)

        await librarian.onExternalFunctionCall(
            worker,
            call("unfinished", "Read", { file_path: "src/unfinished.ts" }),
        )

        await librarian.onExternalEvent(
            broker,
            WorkLeaseReleased.create({
                runId,
                offerId: "offer-S1",
                leaseId: "lease-S1",
                storyId: "S1",
                workerId: "worker",
                reason: "integrated",
            }),
        )
        const state = librarian as unknown as {
            pending: Map<Participant, Map<string, unknown>>
        }
        assert.equal(state.pending.get(worker)?.has("unfinished") ?? false, false)
        await librarian.onExternalFunctionCall(
            worker,
            call("stale", "Read", { file_path: "src/stale.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            worker,
            FunctionCallOutputItem.create("stale", "stale content"),
        )
        assert.equal(remembered.length, 1)
    })
})

function memoryStore(opts: {
    remembered?: Finding[]
    gatheredContext?: string | null
    totalFindings?: number
    onGetCachedPaths?: () => string[]
} = {}): MemoryStore {
    return {
        async remember(finding) {
            opts.remembered?.push(finding)
            return true
        },
        async recall() { return [] },
        async gatherContext() { return opts.gatheredContext ?? null },
        async cacheFile() {},
        async getCachedFile() { return null },
        async hasFile() { return false },
        async getCachedPaths() { return opts.onGetCachedPaths?.() ?? [] },
        async getStats() {
            return {
                totalFindings: opts.totalFindings ?? opts.remembered?.length ?? 0,
                uniqueTools: 0,
                uniqueAgents: 0,
                toolsList: [],
                agentsList: [],
                cachedFiles: 0,
                cacheSizeBytes: 0,
            }
        },
        async close() {},
    }
}
