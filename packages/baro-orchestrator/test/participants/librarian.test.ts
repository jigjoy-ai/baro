import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    type Participant,
} from "../../src/runtime/mozaik.js"

import {
    AgentTargetedMessage,
    Knowledge,
    StoryResult,
    StorySpawned,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../src/semantic-events.js"
import { Librarian } from "../../src/participants/librarian.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { joinWithCapture, source } from "./helpers.js"

function call(
    callId: string,
    name: string,
    args: Record<string, unknown>,
): FunctionCallItem {
    return FunctionCallItem.rehydrate({ callId, name, args: JSON.stringify(args) })
}

describe("Librarian", () => {
    it("indexes exploration tool output, emits knowledge, and gathers cross-agent context", async () => {
        const librarian = new Librarian()
        const env = joinWithCapture(librarian)
        const explorer = source("S1")

        await librarian.onExternalFunctionCall(
            explorer,
            call("read-1", "Read", { file_path: "src/auth.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            explorer,
            FunctionCallOutputItem.create("read-1", "export const token = 'abc'"),
        )

        const knowledge = librarian.getKnowledge()
        assert.equal(knowledge.length, 1)
        assert.equal(knowledge[0].sourceAgentId, "S1")
        assert.equal(knowledge[0].tool, "Read")
        assert.equal(knowledge[0].summary, "Read src/auth.ts")
        assert.equal(knowledge[0].content, "export const token = 'abc'")

        const event = env.events.find(Knowledge.is)
        assert.ok(event, "knowledge event emitted")
        assert.equal(event.data.sourceAgentId, "S1")
        assert.equal(event.data.summary, "Read src/auth.ts")

        assert.equal(librarian.gatherContext("S1", ["auth"]), null)
        const context = librarian.gatherContext("S2", ["auth"])
        assert.ok(context?.includes("Read src/auth.ts"))
        assert.ok(context?.includes("export const token = 'abc'"))
    })

    it("broadcasts new findings to other in-flight stories", async () => {
        const librarian = new Librarian()
        const env = joinWithCapture(librarian)
        const explorer = source("S1")

        await librarian.onExternalEvent(source("conductor"), StorySpawned.create({ storyId: "S2" }))
        await librarian.onExternalFunctionCall(
            explorer,
            call("grep-1", "Grep", { pattern: "auth", path: "src" }),
        )
        await librarian.onExternalFunctionCallOutput(
            explorer,
            FunctionCallOutputItem.create("grep-1", "src/auth.ts:1:auth"),
        )

        const targeted = env.events.filter(AgentTargetedMessage.is)
        assert.equal(targeted.length, 1)
        assert.equal(targeted[0].data.recipientId, "S2")
        assert.equal(targeted[0].data.metadata.from_agent, "S1")
        assert.ok(targeted[0].data.text.includes("Grep 'auth' in src"))
    })

    it("stops broadcasting findings to stories after they complete", async () => {
        const librarian = new Librarian()
        const env = joinWithCapture(librarian)
        const explorer = source("S1")

        await librarian.onExternalEvent(source("conductor"), StorySpawned.create({ storyId: "S2" }))
        await librarian.onExternalEvent(
            source("S2"),
            StoryResult.create({
                storyId: "S2",
                success: true,
                attempts: 1,
                durationSecs: 3,
                error: null,
            }),
        )
        await librarian.onExternalFunctionCall(
            explorer,
            call("read-1", "Read", { file_path: "src/auth.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            explorer,
            FunctionCallOutputItem.create("read-1", "export const token = 'abc'"),
        )

        assert.equal(librarian.getKnowledge().length, 1)
        assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
    })

    it("stops broadcasting to a quiesced dependency-suspended worker", async () => {
        const librarian = new Librarian()
        const env = joinWithCapture(librarian)
        const explorer = source("S1")

        await librarian.onExternalEvent(source("board"), StorySpawned.create({ storyId: "S2" }))
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
        await librarian.onExternalFunctionCall(
            explorer,
            call("read-suspended", "Read", { file_path: "src/auth.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            explorer,
            FunctionCallOutputItem.create(
                "read-suspended",
                "export const token = 'abc'",
            ),
        )

        assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
    })

    it("keeps equal call ids isolated by exact participant identity", async () => {
        const librarian = new Librarian()
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
            librarian.getKnowledge().map((entry) => ({
                source: entry.sourceAgentId,
                summary: entry.summary,
                content: entry.content,
            })),
            [
                {
                    source: "S2",
                    summary: "Read src/second.ts",
                    content: "second content",
                },
                {
                    source: "S1",
                    summary: "Read src/first.ts",
                    content: "first content",
                },
            ],
        )
    })

    it("preserves pending calls on grant replay and purges them on lease replacement", async () => {
        const runId = "run-librarian-replacement"
        const broker = source("broker")
        const oldWorker = source("S1")
        const newWorker = source("S1")
        const outcomeAuthority = new StoryOutcomeAuthority(runId)
        outcomeAuthority.registerResultAuthority(
            { runId, storyId: "S1", leaseId: "lease-old", generation: 1 },
            oldWorker,
        )
        const librarian = new Librarian({
            collective: { runId, outcomeAuthority },
        })
        librarian.setLeaseAuthority(broker)
        joinWithCapture(librarian)
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
        assert.equal(librarian.getKnowledge().length, 0)
    })

    it("collective mode indexes only exact active worker call/output pairs", async () => {
        const runId = "run-librarian-authority"
        const broker = source("broker")
        const worker = source("S1")
        const impostor = source("S1")
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
        const librarian = new Librarian({
            collective: { runId, outcomeAuthority },
        })
        librarian.setLeaseAuthority(broker)
        const env = joinWithCapture(librarian)
        for (const [storyId, leaseId] of [
            ["S1", "lease-S1"],
            ["S2", "lease-S2"],
        ] as const) {
            await librarian.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: `offer-${storyId}`,
                    leaseId,
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId,
                        prompt: "",
                        model: "standard",
                        retries: 0,
                        timeoutSecs: 60,
                    },
                }),
            )
        }

        await librarian.onExternalFunctionCall(
            impostor,
            call("forged", "Read", { file_path: "src/forged.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            impostor,
            FunctionCallOutputItem.create("forged", "forged content"),
        )
        assert.equal(librarian.getKnowledge().length, 0)

        await librarian.onExternalFunctionCall(
            worker,
            call("real", "Read", { file_path: "src/real.ts" }),
        )
        // A same-label impostor cannot finish or consume the genuine call.
        await librarian.onExternalFunctionCallOutput(
            impostor,
            FunctionCallOutputItem.create("real", "forged completion"),
        )
        await librarian.onExternalFunctionCallOutput(
            worker,
            FunctionCallOutputItem.create("real", "export const real = true"),
        )
        assert.equal(librarian.getKnowledge().length, 1)
        assert.equal(env.events.filter(AgentTargetedMessage.is).length, 1)

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
        assert.equal(librarian.getKnowledge().length, 1)
    })
})
