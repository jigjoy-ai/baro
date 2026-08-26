import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { describe, it } from "node:test"

import { capRunDiff, MAX_RUN_DIFF_BYTES } from "../src/integration/run-diff-cap.js"

/** Splits a truncated result into the kept diff text and the trailing marker line. */
function splitAtMarker(result: string): { kept: string; marker: string } {
    const at = result.lastIndexOf("… (run diff truncated: ")
    assert.ok(at >= 0, "result carries the truncation marker")
    return { kept: result.slice(0, at), marker: result.slice(at) }
}

function repeatLines(line: string, totalBytes: number): string {
    const per = Buffer.byteLength(line, "utf8")
    return line.repeat(Math.ceil(totalBytes / per))
}

describe("capRunDiff", () => {
    it("passes an under-cap diff through byte-identically, so current output is unchanged", () => {
        const under = repeatLines("diff --git a/x b/x\n+line\n", MAX_RUN_DIFF_BYTES - 4096)
        assert.ok(Buffer.byteLength(under, "utf8") <= MAX_RUN_DIFF_BYTES)

        assert.equal(capRunDiff(under), under)
    })

    it("passes a diff sitting exactly on the cap through unchanged", () => {
        const exact = "d".repeat(MAX_RUN_DIFF_BYTES)
        assert.equal(Buffer.byteLength(exact, "utf8"), MAX_RUN_DIFF_BYTES)

        assert.equal(capRunDiff(exact), exact)
    })

    it("passes undefined and the empty string through unchanged", () => {
        assert.equal(capRunDiff(undefined), undefined)
        assert.equal(capRunDiff(""), "")
    })

    it("truncates an over-cap diff on a line boundary and reports the omitted bytes", () => {
        const line = "+ some added line of diff text\n"
        const input = repeatLines(line, MAX_RUN_DIFF_BYTES * 2)
        const inputBytes = Buffer.byteLength(input, "utf8")
        assert.ok(inputBytes > MAX_RUN_DIFF_BYTES)

        const result = capRunDiff(input)!
        const { kept, marker } = splitAtMarker(result)

        assert.ok(input.startsWith(kept), "kept text is a prefix of the input")
        assert.ok(kept.endsWith("\n"), "the last pre-marker character is a newline")
        assert.ok(!result.endsWith("\n"), "no trailing newline, per the event-field rule")

        const keptBytes = Buffer.byteLength(kept, "utf8")
        assert.ok(keptBytes <= MAX_RUN_DIFF_BYTES)
        assert.ok(
            keptBytes + Buffer.byteLength(line, "utf8") > MAX_RUN_DIFF_BYTES,
            "the cut is the last whole line that fits, not an earlier one",
        )
        assert.equal(marker, `… (run diff truncated: ${inputBytes - keptBytes} bytes omitted)`)
        assert.ok(
            Buffer.byteLength(result, "utf8") <=
                MAX_RUN_DIFF_BYTES + Buffer.byteLength(marker, "utf8"),
        )
    })

    it("emits marker-only output when no newline falls inside the cap", () => {
        const input = "x".repeat(MAX_RUN_DIFF_BYTES + 1024) + "\ntail\n"
        const inputBytes = Buffer.byteLength(input, "utf8")

        const result = capRunDiff(input)!

        assert.equal(result, `… (run diff truncated: ${inputBytes} bytes omitted)`)
    })

    it("never splits a multi-byte character, because the cut lands on a newline", () => {
        const line = `+ héllo ünïcode — ${"é".repeat(40)}\n`
        const input = repeatLines(line, MAX_RUN_DIFF_BYTES * 2)

        const result = capRunDiff(input)!
        const { kept } = splitAtMarker(result)

        assert.ok(!result.includes("�"), "no replacement character from a split code point")
        assert.equal(Buffer.from(kept, "utf8").toString("utf8"), kept, "kept text round-trips")
        assert.ok(input.startsWith(kept))
    })
})

describe("aggregate run-level story_diff payload", () => {
    // Mirrors the emit at src/orchestrate.ts: only `diff` is capped.
    const files = [
        { path: "a.ts", added: 12, removed: 3 },
        { path: "b.ts", added: 0, removed: 7 },
    ]
    const payloadFor = (diff: string) => ({
        type: "story_diff" as const,
        id: "(run)",
        files,
        diff: capRunDiff(diff || undefined),
    })

    it("keeps the files array complete when the diff is truncated", () => {
        const payload = payloadFor(repeatLines("+ line\n", MAX_RUN_DIFF_BYTES * 2))

        assert.deepEqual(payload.files, files)
        assert.equal(payload.id, "(run)")
        assert.ok(payload.diff!.endsWith(" bytes omitted)"))
    })

    it("keeps the files array complete and the diff byte-identical under the cap", () => {
        const diff = "diff --git a/a.ts b/a.ts\n+one\n"
        const payload = payloadFor(diff)

        assert.deepEqual(payload.files, files)
        assert.equal(payload.diff, diff)
    })

    it("carries no diff field when the run diff is empty, as before", () => {
        assert.equal(payloadFor("").diff, undefined)
    })
})
