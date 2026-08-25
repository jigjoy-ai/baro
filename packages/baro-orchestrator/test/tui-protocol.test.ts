import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { emit, toVerificationEvidenceInfo } from "../src/tui-protocol.js"

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

    it("carries retry evidence into the emitted verification summary", () => {
        const info = toVerificationEvidenceInfo({
            verificationId: "V1",
            status: "passed",
            durationMs: 34,
            commands: [
                {
                    command: "npm test",
                    status: "passed",
                    durationMs: 12,
                    tail: "ok",
                    retriedAfterFailure: true,
                    firstFailureTail: "first attempt failed",
                },
            ],
        })

        assert.deepEqual(info, {
            verification_id: "V1",
            status: "passed",
            duration_ms: 34,
            commands: [
                {
                    command: "npm test",
                    status: "passed",
                    duration_ms: 12,
                    tail: "ok",
                    retried_after_failure: true,
                    first_failure_tail: "first attempt failed",
                },
            ],
        })
    })

    it("serializes a command without retry evidence exactly as before", () => {
        const info = toVerificationEvidenceInfo({
            verificationId: "V1",
            status: "passed",
            durationMs: 34,
            commands: [{ command: "npm test", status: "passed", durationMs: 12 }],
        })

        assert.deepEqual(info.commands[0], {
            command: "npm test",
            status: "passed",
            duration_ms: 12,
        })
        // deepEqual alone would accept a present-but-undefined key, which
        // crosses the language boundary as an explicit null.
        assert.deepEqual(Object.keys(info.commands[0] ?? {}), [
            "command",
            "status",
            "duration_ms",
        ])
    })
})
