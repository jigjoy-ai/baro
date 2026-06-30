import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FunctionCallItem, FunctionCallOutputItem } from "@mozaik-ai/core"

import { MemoryLibrarian } from "../../src/participants/memory-librarian.js"
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
})
