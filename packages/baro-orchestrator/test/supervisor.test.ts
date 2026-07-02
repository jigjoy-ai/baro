import { test } from "node:test"
import assert from "node:assert/strict"

import { Supervisor, type SupervisorOptions } from "../src/participants/supervisor.js"
import { StoryIntervention, type StoryInterventionData } from "../src/semantic-events.js"
import { joinWithCapture, type CapturedEnvironment } from "./participants/helpers.js"

// Minimal fakes: the Supervisor only reads source.agentId, item.name, item.args.
function feed(sup: Supervisor, id: string, name: string, args = "{}") {
    return sup.onExternalFunctionCall({ agentId: id } as never, { name, args } as never)
}

function interventions(env: CapturedEnvironment): StoryInterventionData[] {
    return env.events.filter(StoryIntervention.is).map((e) => e.data)
}

function supervised(opts: SupervisorOptions = {}): { sup: Supervisor; env: CapturedEnvironment } {
    const sup = new Supervisor(opts)
    return { sup, env: joinWithCapture(sup) }
}

test("aborts a story exploring with no file changes", async () => {
    const { sup, env } = supervised({ noProgressToolCalls: 10 })
    for (let i = 0; i < 9; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    assert.equal(interventions(env).length, 0, "no trip before threshold")
    await feed(sup, "S1", "grep", `{"n":99}`) // 10th no-change call
    const got = interventions(env)
    assert.equal(got.length, 1)
    assert.equal(got[0]!.storyId, "S1")
    assert.equal(got[0]!.action, "abort")
    assert.equal(got[0]!.source, "supervisor")
    assert.match(got[0]!.reason, /no file change/)
})

test("a file change resets the no-progress counter", async () => {
    const { sup, env } = supervised({ noProgressToolCalls: 5 })
    for (let i = 0; i < 4; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    await feed(sup, "S1", "edit_file", `{"path":"a.ts"}`) // resets sinceLastChange
    for (let i = 0; i < 4; i++) await feed(sup, "S1", "read_file", `{"m":${i}}`)
    assert.equal(interventions(env).length, 0)
})

test("aborts on a repeated identical tool call", async () => {
    const { sup, env } = supervised({ repeatThreshold: 3, noProgressToolCalls: 999 })
    await feed(sup, "S1", "grep", `{"q":"x"}`)
    await feed(sup, "S1", "grep", `{"q":"x"}`)
    await feed(sup, "S1", "grep", `{"q":"x"}`) // 3rd identical
    const got = interventions(env)
    assert.equal(got.length, 1)
    assert.match(got[0]!.reason, /repeated/)
})

test("wall-clock with zero file changes trips", async () => {
    let now = 0
    const { sup, env } = supervised({
        softCapMs: 1000,
        noProgressToolCalls: 999,
        repeatThreshold: 999,
        now: () => now,
    })
    await feed(sup, "S1", "read_file", `{"n":1}`) // startedAt = 0
    now = 1500
    await feed(sup, "S1", "read_file", `{"n":2}`) // elapsed 1500 > 1000, 0 file changes
    assert.equal(interventions(env).length, 1)
})

test("does not false-positive on steady progress", async () => {
    let now = 0
    const { sup, env } = supervised({
        softCapMs: 1000,
        noProgressToolCalls: 5,
        repeatThreshold: 3,
        now: () => now,
    })
    for (let i = 0; i < 30; i++) {
        now += 10_000
        await feed(sup, "S1", i % 2 ? "edit_file" : "read_file", `{"i":${i}}`) // writes every other call
    }
    assert.equal(interventions(env).length, 0, "steady file changes → no stall")
})

test("intervenes only once per story", async () => {
    const { sup, env } = supervised({ noProgressToolCalls: 3, repeatThreshold: 999 })
    for (let i = 0; i < 10; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    assert.equal(interventions(env).length, 1, "one intervention despite continued spinning")
})

test("tracks stories independently", async () => {
    const { sup, env } = supervised({ noProgressToolCalls: 3, repeatThreshold: 999 })
    await feed(sup, "S1", "read_file", "{}")
    await feed(sup, "S2", "edit_file", `{"path":"b.ts"}`)
    for (let i = 0; i < 3; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    assert.deepEqual(
        interventions(env).map((d) => d.storyId),
        ["S1"],
        "only the spinning story trips",
    )
})
