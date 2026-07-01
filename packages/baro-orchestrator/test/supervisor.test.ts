import { test } from "node:test"
import assert from "node:assert/strict"

import { Supervisor } from "../src/participants/supervisor.js"

// Minimal fakes: the Supervisor only reads source.agentId, item.name, item.args.
function feed(sup: Supervisor, id: string, name: string, args = "{}") {
    return sup.onExternalFunctionCall({ agentId: id } as never, { name, args } as never)
}

test("aborts a story exploring with no file changes", async () => {
    const stalled: string[] = []
    const sup = new Supervisor({ onStall: (id, r) => stalled.push(`${id}:${r}`), noProgressToolCalls: 10 })
    for (let i = 0; i < 9; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    assert.equal(stalled.length, 0, "no trip before threshold")
    await feed(sup, "S1", "grep", `{"n":99}`) // 10th no-change call
    assert.equal(stalled.length, 1)
    assert.match(stalled[0]!, /no file change/)
})

test("a file change resets the no-progress counter", async () => {
    const stalled: string[] = []
    const sup = new Supervisor({ onStall: (id) => stalled.push(id), noProgressToolCalls: 5 })
    for (let i = 0; i < 4; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    await feed(sup, "S1", "edit_file", `{"path":"a.ts"}`) // resets sinceLastChange
    for (let i = 0; i < 4; i++) await feed(sup, "S1", "read_file", `{"m":${i}}`)
    assert.equal(stalled.length, 0)
})

test("aborts on a repeated identical tool call", async () => {
    const stalled: string[] = []
    const sup = new Supervisor({ onStall: (_id, r) => stalled.push(r), repeatThreshold: 3, noProgressToolCalls: 999 })
    await feed(sup, "S1", "grep", `{"q":"x"}`)
    await feed(sup, "S1", "grep", `{"q":"x"}`)
    await feed(sup, "S1", "grep", `{"q":"x"}`) // 3rd identical
    assert.equal(stalled.length, 1)
    assert.match(stalled[0]!, /repeated/)
})

test("wall-clock with zero file changes trips", async () => {
    let now = 0
    const stalled: string[] = []
    const sup = new Supervisor({
        onStall: (id) => stalled.push(id),
        softCapMs: 1000,
        noProgressToolCalls: 999,
        repeatThreshold: 999,
        now: () => now,
    })
    await feed(sup, "S1", "read_file", `{"n":1}`) // startedAt = 0
    now = 1500
    await feed(sup, "S1", "read_file", `{"n":2}`) // elapsed 1500 > 1000, 0 file changes
    assert.equal(stalled.length, 1)
})

test("does not false-positive on steady progress", async () => {
    let now = 0
    const stalled: string[] = []
    const sup = new Supervisor({
        onStall: (id) => stalled.push(id),
        softCapMs: 1000,
        noProgressToolCalls: 5,
        repeatThreshold: 3,
        now: () => now,
    })
    for (let i = 0; i < 30; i++) {
        now += 10_000
        await feed(sup, "S1", i % 2 ? "edit_file" : "read_file", `{"i":${i}}`) // writes every other call
    }
    assert.equal(stalled.length, 0, "steady file changes → no stall")
})

test("intervenes only once per story", async () => {
    const stalled: string[] = []
    const sup = new Supervisor({ onStall: (id) => stalled.push(id), noProgressToolCalls: 3, repeatThreshold: 999 })
    for (let i = 0; i < 10; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    assert.equal(stalled.length, 1, "one intervention despite continued spinning")
})

test("tracks stories independently", async () => {
    const stalled: string[] = []
    const sup = new Supervisor({ onStall: (id) => stalled.push(id), noProgressToolCalls: 3, repeatThreshold: 999 })
    await feed(sup, "S1", "read_file", "{}")
    await feed(sup, "S2", "edit_file", `{"path":"b.ts"}`)
    for (let i = 0; i < 3; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    assert.deepEqual(stalled, ["S1"], "only the spinning story trips")
})
