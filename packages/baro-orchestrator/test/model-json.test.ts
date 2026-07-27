import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { extractModelJsonObject } from "../src/model-json.js"

describe("extractModelJsonObject", () => {
    it("returns a complete object untouched, braces inside strings included", () => {
        const whole = '{"a":[1,2],"b":{"c":"}"},"d":"[\\"x\\"]"}'
        assert.equal(extractModelJsonObject(whole), whole)
        assert.equal(JSON.parse(extractModelJsonObject(whole)).b.c, "}")
    })

    it("unwraps a fenced or prose-wrapped object", () => {
        assert.equal(
            JSON.parse(extractModelJsonObject('here:\n```json\n{"a":1}\n```')).a,
            1,
        )
        assert.equal(
            JSON.parse(extractModelJsonObject('Sure! {"a":2} — done.')).a,
            2,
        )
    })

    it("closes containers a model left open after a heavily escaped string", () => {
        // Verbatim shape of a real opus obligation reply: stop_reason=end_turn,
        // ~800 output tokens (no cap in play), yet the final `}` is missing
        // after evidence full of escaped quotes and backslashes.
        const dropped =
            '{"schemaVersion":1,"obligations":[{"invariantIds":["G-C3"],' +
            '"evidence":["grep -nE \\"require\\\\\\\\([\'\\\\\\"]\\" kit.js | wc -l"]}]'
        assert.throws(() => JSON.parse(dropped))
        const parsed = JSON.parse(extractModelJsonObject(dropped)) as {
            obligations: Array<{ evidence: string[] }>
        }
        assert.equal(parsed.obligations.length, 1)
        assert.match(parsed.obligations[0]!.evidence[0]!, /^grep -nE /u)
    })

    it("closes nested arrays and objects in the order they were opened", () => {
        const parsed = JSON.parse(
            extractModelJsonObject('{"a":{"b":[{"c":1}'),
        ) as { a: { b: Array<{ c: number }> } }
        assert.equal(parsed.a.b[0]!.c, 1)
    })

    it("leaves a reply cut inside a string broken", () => {
        // A genuine mid-stream truncation must stay detectable: appending
        // closers here would invent a value the model never finished.
        const cut = '{"schemaVersion":1,"obligations":[{"subject":"half writ'
        assert.throws(() => JSON.parse(extractModelJsonObject(cut)))
    })

    it("passes prose without any object through unchanged", () => {
        assert.equal(extractModelJsonObject("no json here"), "no json here")
    })
})
