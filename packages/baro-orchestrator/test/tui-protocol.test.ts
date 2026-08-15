import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { emit } from "../src/tui-protocol.js"

function captureEmit(event: Parameters<typeof emit>[0]): Record<string, unknown> {
    const written: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string) => {
        written.push(chunk)
        return true
    }) as typeof process.stdout.write
    try {
        emit(event)
    } finally {
        process.stdout.write = original
    }
    assert.equal(written.length, 1)
    assert.ok(written[0]!.endsWith("\n"), "one newline-terminated line")
    return JSON.parse(written[0]!)
}

describe("headless event stream", () => {
    it("timestamps every line, so a consumer can tell how long anything took", () => {
        const before = Date.now()
        const line = captureEmit({ type: "architect_start" })
        const after = Date.now()

        const ts = Date.parse(String(line.ts))
        assert.ok(Number.isFinite(ts), "ts parses as a date")
        assert.ok(ts >= before && ts <= after, "ts is the moment of emission")
    })

    it("never lets the timestamp displace a field the event carries", () => {
        const line = captureEmit({
            type: "story_log",
            id: "S1",
            line: "verified",
        })

        assert.equal(line.type, "story_log")
        assert.equal(line.id, "S1")
        assert.equal(line.line, "verified")
    })
})
