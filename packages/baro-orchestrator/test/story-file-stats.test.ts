import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FunctionCallItem, type Participant } from "@mozaik-ai/core"

import { StoryResult } from "../src/semantic-events.js"
import { StoryLifecycleForwarder } from "../src/participants/forwarders/story-lifecycle.js"

// The forwarder reads `source.agentId`; a story's agentId == its storyId.
function source(agentId: string): Participant {
    return { agentId } as unknown as Participant
}

function call(name: string, args: Record<string, unknown>): FunctionCallItem {
    return FunctionCallItem.rehydrate({ callId: "c", name, args: JSON.stringify(args) })
}

function result(storyId: string, success: boolean) {
    return StoryResult.create({ storyId, success, attempts: 1, durationSecs: 3, error: success ? null : "boom" })
}

/**
 * Run `fn` (which synchronously triggers `emit` → stdout) with stdout
 * captured, then restore and return the parsed BaroEvents. Capturing only
 * around the synchronous emit avoids swallowing the test runner's own output.
 */
function capture(fn: () => void): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
        const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
        for (const line of s.split("\n")) {
            const t = line.trim()
            if (t) { try { out.push(JSON.parse(t)) } catch { /* not ours */ } }
        }
        return true
    }) as typeof process.stdout.write
    try {
        fn()
    } finally {
        process.stdout.write = orig
    }
    return out
}

function complete(events: Array<Record<string, unknown>>, id: string) {
    return events.filter((e) => e.type === "story_complete" && e.id === id).pop()
}

describe("StoryLifecycleForwarder — per-story file stats (#39)", () => {
    it("classifies a whole-file write as created and an edit as modified", () => {
        const f = new StoryLifecycleForwarder()
        const events = capture(() => {
            void f.onExternalFunctionCall(source("S1"), call("Write", { file_path: "a.ts", content: "x" }))
            void f.onExternalFunctionCall(source("S1"), call("Edit", { file_path: "b.ts", old: "x", new: "y" }))
            void f.onExternalEvent(source("S1"), result("S1", true))
        })
        const ev = complete(events, "S1")
        assert.ok(ev, "story_complete emitted")
        assert.equal(ev!.files_created, 1)
        assert.equal(ev!.files_modified, 1)
    })

    it("counts a path once, keeping its first-touch classification", () => {
        const f = new StoryLifecycleForwarder()
        const events = capture(() => {
            void f.onExternalFunctionCall(source("S2"), call("Write", { file_path: "a.ts", content: "1" }))
            void f.onExternalFunctionCall(source("S2"), call("Edit", { file_path: "a.ts", old: "1", new: "2" }))
            void f.onExternalFunctionCall(source("S2"), call("Write", { file_path: "a.ts", content: "3" }))
            void f.onExternalEvent(source("S2"), result("S2", true))
        })
        const ev = complete(events, "S2")
        assert.equal(ev!.files_created, 1, "distinct path counted once")
        assert.equal(ev!.files_modified, 0, "stays created despite a later edit")
    })

    it("attributes the OpenAI/Codex story tools (write_file/edit_file, `path` arg)", () => {
        const f = new StoryLifecycleForwarder()
        const events = capture(() => {
            void f.onExternalFunctionCall(source("S3"), call("write_file", { path: "new.ts", content: "x" }))
            void f.onExternalFunctionCall(source("S3"), call("edit_file", { path: "old.ts", old: "a", new: "b" }))
            void f.onExternalEvent(source("S3"), result("S3", true))
        })
        const ev = complete(events, "S3")
        assert.equal(ev!.files_created, 1)
        assert.equal(ev!.files_modified, 1)
    })

    it("ignores non-write tool calls", () => {
        const f = new StoryLifecycleForwarder()
        const events = capture(() => {
            void f.onExternalFunctionCall(source("S4"), call("Bash", { command: "ls" }))
            void f.onExternalFunctionCall(source("S4"), call("Read", { file_path: "a.ts" }))
            void f.onExternalEvent(source("S4"), result("S4", true))
        })
        const ev = complete(events, "S4")
        assert.equal(ev!.files_created, 0)
        assert.equal(ev!.files_modified, 0)
    })

    it("does not attribute one story's touches to another", () => {
        const f = new StoryLifecycleForwarder()
        const events = capture(() => {
            void f.onExternalFunctionCall(source("S5"), call("Write", { file_path: "a.ts", content: "x" }))
            void f.onExternalFunctionCall(source("S6"), call("Write", { file_path: "b.ts", content: "y" }))
            void f.onExternalFunctionCall(source("S6"), call("Write", { file_path: "c.ts", content: "z" }))
            void f.onExternalEvent(source("S5"), result("S5", true))
            void f.onExternalEvent(source("S6"), result("S6", true))
        })
        assert.equal(complete(events, "S5")!.files_created, 1)
        assert.equal(complete(events, "S6")!.files_created, 2)
    })

    it("emits story_error (not story_complete) on failure and forgets the touches", () => {
        const f = new StoryLifecycleForwarder()
        const events = capture(() => {
            void f.onExternalFunctionCall(source("S7"), call("Write", { file_path: "a.ts", content: "x" }))
            void f.onExternalEvent(source("S7"), result("S7", false))
        })
        assert.equal(complete(events, "S7"), undefined, "no story_complete on failure")
        assert.ok(events.some((e) => e.type === "story_error" && e.id === "S7"), "story_error emitted")
    })
})
