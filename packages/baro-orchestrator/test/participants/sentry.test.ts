import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { FunctionCallItem } from "../../src/runtime/mozaik.js"

import { Sentry } from "../../src/participants/sentry.js"
import { Coordination } from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

function call(name: string, args: Record<string, unknown>): FunctionCallItem {
    return FunctionCallItem.rehydrate({
        callId: "call-1",
        name,
        args: JSON.stringify(args),
    })
}

describe("Sentry", () => {
    it("emits one coordination notice when two agents touch the same file", async () => {
        const overlaps: Array<{ path: string; agents: string[] }> = []
        const sentry = new Sentry({
            onOverlap: (info) => overlaps.push(info),
        })
        const env = joinWithCapture(sentry)

        await sentry.onExternalFunctionCall(
            source("S1"),
            call("Write", { file_path: "src/conflict.ts", content: "first" }),
        )
        await sentry.onExternalFunctionCall(
            source("S2"),
            call("Edit", {
                file_path: "src/conflict.ts",
                old_string: "first",
                new_string: "second",
            }),
        )
        await sentry.onExternalFunctionCall(
            source("S3"),
            call("MultiEdit", { file_path: "src/conflict.ts", edits: [] }),
        )

        assert.equal(sentry.getTouches().length, 3)
        assert.deepEqual(overlaps, [
            { path: "src/conflict.ts", agents: ["S2", "S1"] },
            { path: "src/conflict.ts", agents: ["S3", "S1", "S2"] },
        ])

        const notices = env.events.filter((event) => Coordination.is(event))
        assert.equal(notices.length, 1, "only first overlap for a path emits notice")
        assert.deepEqual(notices[0].data, {
            fromAgentId: "S2",
            recipientId: "S1",
            kind: "notice",
            reason: "agents [S2, S1] both touched src/conflict.ts",
            payload: { path: "src/conflict.ts", agents: ["S2", "S1"] },
        })
    })

    it("tracks overlaps without emitting coordination when notices are disabled", async () => {
        const overlaps: Array<{ path: string; agents: string[] }> = []
        const sentry = new Sentry({
            emitNotice: false,
            onOverlap: (info) => overlaps.push(info),
        })
        const env = joinWithCapture(sentry)

        await sentry.onExternalFunctionCall(
            source("S1"),
            call("Write", { file_path: "src/shared.ts", content: "first" }),
        )
        await sentry.onExternalFunctionCall(
            source("S2"),
            call("Write", { file_path: "src/shared.ts", content: "second" }),
        )

        assert.equal(sentry.getTouches().length, 2)
        assert.deepEqual(overlaps, [{ path: "src/shared.ts", agents: ["S2", "S1"] }])
        assert.equal(env.events.filter(Coordination.is).length, 0)
    })
})
