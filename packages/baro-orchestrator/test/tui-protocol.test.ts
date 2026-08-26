import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    emit,
    flushTuiProtocol,
    flushTuiProtocolWithTimeout,
    resetTuiProtocolFlushState,
    toVerificationEvidenceInfo,
} from "../src/tui-protocol.js"

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

/**
 * Only the emitted event lines report backpressure; every other chunk (the
 * test reporter's own output) passes straight through, so stubbing here can
 * never pause node:test's stdout pipe or register a drain listener of its own.
 */
function stubStdoutWrite(acceptEventLines: boolean): () => void {
    const original = process.stdout.write
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string" && chunk.startsWith('{"ts":')) return acceptEventLines
        return (original as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest)
    }) as typeof process.stdout.write
    return () => {
        process.stdout.write = original
    }
}

const settleTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

describe("stdout flush before exit", () => {
    it("resolves immediately when no write is pending", async () => {
        const restore = stubStdoutWrite(true)
        const pending = Symbol("pending")
        try {
            emit({ type: "architect_start" })

            assert.equal(process.stdout.listenerCount("drain"), 0, "no drain listener")
            const winner = await Promise.race([flushTuiProtocol(), Promise.resolve(pending)])
            assert.notEqual(winner, pending, "flush was already resolved, no drain needed")
        } finally {
            restore()
            resetTuiProtocolFlushState()
        }
    })

    it("waits for drain when a write was refused, then clears the pending state", async () => {
        const restore = stubStdoutWrite(false)
        const pending = Symbol("pending")
        try {
            emit({ type: "architect_start" })
            assert.ok(process.stdout.listenerCount("drain") <= 1, "one drain listener at most")

            let settled = false
            const flush = flushTuiProtocol().then(() => {
                settled = true
            })
            await settleTurn()
            assert.equal(settled, false, "still queued in the stream buffer")

            process.stdout.emit("drain")
            await flush
            assert.equal(settled, true, "drain releases the flush")

            const winner = await Promise.race([flushTuiProtocol(), Promise.resolve(pending)])
            assert.notEqual(winner, pending, "pending state cleared, next flush is immediate")
        } finally {
            restore()
            resetTuiProtocolFlushState()
            process.stdout.emit("drain")
        }
    })

    it("covers a line emitted after the flush started, on a single drain", async () => {
        const restore = stubStdoutWrite(false)
        try {
            emit({ type: "architect_start" })
            const listeners = process.stdout.listenerCount("drain")
            assert.ok(listeners <= 1, "one drain listener at most")

            let settled = false
            const flush = flushTuiProtocol().then(() => {
                settled = true
            })

            emit({ type: "story_log", id: "S1", line: "late" })
            assert.equal(
                process.stdout.listenerCount("drain"),
                listeners,
                "the second refused write reuses the pending drain promise",
            )
            assert.ok(process.stdout.listenerCount("drain") <= 1, "one drain listener at most")

            await settleTurn()
            assert.equal(settled, false, "both lines still queued")

            process.stdout.emit("drain")
            await flush
            assert.equal(settled, true, "one drain covers every queued line")
            assert.equal(process.stdout.listenerCount("drain"), 0, "listener removed")
        } finally {
            restore()
            resetTuiProtocolFlushState()
            process.stdout.emit("drain")
        }
    })

    it("gives up on a flush that never settles, so a stuck pipe cannot stall exit", async () => {
        const stuck = await flushTuiProtocolWithTimeout(10, () => new Promise<void>(() => {}))
        assert.equal(stuck, "timeout")
    })

    it("reports a completed flush, and treats a failed one as done rather than rejecting", async () => {
        assert.equal(await flushTuiProtocolWithTimeout(10, () => Promise.resolve()), "flushed")
        assert.equal(
            await flushTuiProtocolWithTimeout(10, () => Promise.reject(new Error("EPIPE"))),
            "flushed",
        )
    })
})
