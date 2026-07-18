import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { WorkContextProvider } from "../../src/participants/work-context-provider.js"
import {
    CollaborationNote,
    WorkContextProvided,
    WorkContextRequested,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("WorkContextProvider", () => {
    it("fails closed before request and collaboration authorities are bound", async () => {
        const provider = new WorkContextProvider("run-unbound", null)
        const env = joinWithCapture(provider)
        env.deliverSemanticEvent(
            source("ambient-bridge"),
            CollaborationNote.create({
                runId: "run-unbound",
                sourceAgentId: "forged",
                text: "poison launch context",
            }),
        )
        env.deliverSemanticEvent(
            source("ambient-board"),
            WorkContextRequested.create({
                runId: "run-unbound",
                requestId: "unbound-request",
                storyId: "S1",
                hints: [],
            }),
        )
        await provider.idle()

        assert.equal(env.events.filter(WorkContextProvided.is).length, 0)

        const board = source("board")
        const bridge = source("bridge")
        provider.setRequestAuthority(board)
        provider.setCollaborationAuthority(bridge)
        env.deliverSemanticEvent(
            board,
            WorkContextRequested.create({
                runId: "run-unbound",
                requestId: "bound-request",
                storyId: "S1",
                hints: [],
            }),
        )
        await provider.idle()

        const result = env.events.find(
            (event) =>
                WorkContextProvided.is(event) &&
                event.data.requestId === "bound-request",
        )
        assert.equal(result?.data.context, null)
    })

    it("accepts context requests only from the bound Board", async () => {
        const calls: string[] = []
        const board = source("board")
        const provider = new WorkContextProvider("run-authority", {
            gatherContext: async (storyId) => {
                calls.push(storyId)
                return "authorized context"
            },
        })
        provider.setRequestAuthority(board)
        const env = joinWithCapture(provider)
        const request = WorkContextRequested.create({
            runId: "run-authority",
            requestId: "context-authority-1",
            storyId: "S1",
            hints: [],
        })

        env.deliverSemanticEvent(source("observer"), request)
        await provider.idle()
        assert.deepEqual(calls, [])
        assert.equal(env.events.filter(WorkContextProvided.is).length, 0)

        env.deliverSemanticEvent(board, request)
        await provider.idle()
        assert.deepEqual(calls, ["S1"])
        assert.equal(env.events.filter(WorkContextProvided.is).length, 1)
    })

    it("returns launch context through events", async () => {
        const calls: Array<{ storyId: string; hints: readonly string[] }> = []
        const provider = new WorkContextProvider("run-context", {
            gatherContext: async (storyId, hints = []) => {
                calls.push({ storyId, hints })
                return "context from a peer"
            },
        })
        const board = source("board")
        provider.setRequestAuthority(board)
        const env = joinWithCapture(provider)

        env.deliverSemanticEvent(
            board,
            WorkContextRequested.create({
                runId: "run-context",
                requestId: "context-1",
                storyId: "S2",
                hints: ["auth", "token"],
            }),
        )
        await provider.idle()

        assert.deepEqual(calls, [{ storyId: "S2", hints: ["auth", "token"] }])
        const result = env.events.find(WorkContextProvided.is)
        assert.deepEqual(result?.data, {
            runId: "run-context",
            requestId: "context-1",
            storyId: "S2",
            context: "context from a peer",
        })
    })

    it("retains authorized peer notes for agents launched in later waves", async () => {
        const board = source("board")
        const bridge = source("collaboration-bridge")
        const provider = new WorkContextProvider("run-notes", {
            gatherContext: () => "repository context",
        })
        provider.setRequestAuthority(board)
        provider.setCollaborationAuthority(bridge)
        const env = joinWithCapture(provider)

        const note = CollaborationNote.create({
            runId: "run-notes",
            sourceAgentId: "G3",
            text: "Only response.completed carries trustworthy terminal usage.",
        })
        // A forged note with the right run id is rejected by source identity.
        env.deliverSemanticEvent(source("untrusted"), note)
        env.deliverSemanticEvent(bridge, note)
        // Duplicate delivery must not inflate downstream prompts.
        env.deliverSemanticEvent(bridge, note)
        env.deliverSemanticEvent(
            bridge,
            CollaborationNote.create({
                runId: "another-run",
                sourceAgentId: "G4",
                text: "wrong run",
            }),
        )
        env.deliverSemanticEvent(
            board,
            WorkContextRequested.create({
                runId: "run-notes",
                requestId: "context-later-wave",
                storyId: "G5",
                hints: [],
            }),
        )
        await provider.idle()

        const result = env.events.find(
            (event) =>
                WorkContextProvided.is(event) &&
                event.data.requestId === "context-later-wave",
        )
        assert.match(result?.data.context ?? "", /repository context/)
        assert.match(
            result?.data.context ?? "",
            /Shared findings from earlier agents/,
        )
        assert.match(result?.data.context ?? "", /\[G3\].*response\.completed/)
        assert.doesNotMatch(result?.data.context ?? "", /wrong run/)
        assert.equal(
            (result?.data.context?.match(/trustworthy terminal usage/g) ?? [])
                .length,
            1,
        )
    })

    it("falls back to empty context when a context source hangs", async () => {
        const provider = new WorkContextProvider(
            "run-timeout",
            { gatherContext: () => new Promise(() => {}) },
            5,
        )
        const board = source("board")
        provider.setRequestAuthority(board)
        const env = joinWithCapture(provider)

        env.deliverSemanticEvent(
            board,
            WorkContextRequested.create({
                runId: "run-timeout",
                requestId: "context-timeout",
                storyId: "S1",
                hints: [],
            }),
        )
        await provider.idle()

        const result = env.events.find(WorkContextProvided.is)
        assert.equal(result?.data.context, null)
    })
})
