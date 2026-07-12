import { test } from "node:test"
import assert from "node:assert/strict"

import { Supervisor, type SupervisorOptions } from "../src/participants/supervisor.js"
import {
    AgentState,
    StoryIntervention,
    StorySpawned,
    type StoryInterventionData,
} from "../src/semantic-events.js"
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

test("real Claude write-tool casing counts as progress", async () => {
    for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
        const { sup, env } = supervised({ noProgressToolCalls: 3 })
        await feed(sup, "S1", "Read", `{"before":"${name}"}`)
        await feed(sup, "S1", "Grep", `{"before":"${name}"}`)
        await feed(sup, "S1", name, `{"file_path":"a.ts"}`)
        await feed(sup, "S1", "Read", `{"after":"${name}"}`)
        await feed(sup, "S1", "Grep", `{"after":"${name}"}`)
        assert.equal(
            interventions(env).length,
            0,
            `${name} must reset the no-progress counter`,
        )
    }
})

test("lowercase OpenAI and Codex write tools count as progress case-insensitively", async () => {
    for (const name of ["write_file", "EDIT_FILE", "edit", "apply_patch"]) {
        const { sup, env } = supervised({ noProgressToolCalls: 2 })
        await feed(sup, "S1", "read_file", `{"before":"${name}"}`)
        await feed(sup, "S1", name, `{"path":"a.ts"}`)
        await feed(sup, "S1", "read_file", `{"after":"${name}"}`)
        assert.equal(interventions(env).length, 0, `${name} must count as progress`)
    }
})

test("aborts on a repeated identical tool call with no progress", async () => {
    // repeatsNeedNoProgress defaults to floor(noProgressToolCalls/2) = 3, and the
    // 3 read-only greps push sinceLastChange to 3 — so the loop guard is satisfied.
    const { sup, env } = supervised({ repeatThreshold: 3, noProgressToolCalls: 6 })
    await feed(sup, "S1", "grep", `{"q":"x"}`)
    await feed(sup, "S1", "grep", `{"q":"x"}`)
    await feed(sup, "S1", "grep", `{"q":"x"}`) // 3rd identical
    const got = interventions(env)
    assert.equal(got.length, 1)
    assert.match(got[0]!.reason, /repeated/)
})

test("does NOT abort a repeated call while file changes keep happening", async () => {
    // Same edit signature over and over, but each is a write → sinceLastChange
    // stays 0, so the repeat is real progress, not a stuck loop.
    const { sup, env } = supervised({ repeatThreshold: 3, noProgressToolCalls: 6 })
    for (let i = 0; i < 10; i++) await feed(sup, "S1", "edit_file", `{"path":"a.ts"}`)
    assert.equal(interventions(env).length, 0, "re-editing the same file is progress, not a loop")
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

test("wall-clock cap is measured from the most recent recognized progress", async () => {
    let now = 0
    const { sup, env } = supervised({
        softCapMs: 1000,
        noProgressToolCalls: 999,
        repeatThreshold: 999,
        now: () => now,
    })
    await feed(sup, "S1", "read_file", `{"n":1}`)
    now = 900
    await feed(sup, "S1", "Write", `{"file_path":"a.ts"}`)
    now = 1500
    await feed(sup, "S1", "read_file", `{"n":2}`)
    assert.equal(interventions(env).length, 0, "recent write restarts the wall-clock window")
    now = 2000
    await feed(sup, "S1", "read_file", `{"n":3}`)
    const got = interventions(env)
    assert.equal(got.length, 1)
    assert.match(got[0]!.reason, /since last recognized file change/)
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
        now += 100
        await feed(sup, "S1", i % 2 ? "edit_file" : "read_file", `{"i":${i}}`) // writes every other call
    }
    assert.equal(interventions(env).length, 0, "steady file changes → no stall")
})

test("intervenes only once per story", async () => {
    const { sup, env } = supervised({ noProgressToolCalls: 3, repeatThreshold: 999 })
    for (let i = 0; i < 10; i++) await feed(sup, "S1", "read_file", `{"n":${i}}`)
    assert.equal(interventions(env).length, 1, "one intervention despite continued spinning")
})

test("supervises a retry as a fresh attempt after intervening", async () => {
    const { sup, env } = supervised({ noProgressToolCalls: 2, repeatThreshold: 999 })
    await feed(sup, "S1", "Read", `{"attempt":1,"n":1}`)
    await feed(sup, "S1", "Grep", `{"attempt":1,"n":2}`)
    assert.equal(interventions(env).length, 1, "attempt 1 intervened")

    await sup.onExternalEvent(
        { agentId: "S2" } as never,
        AgentState.create({ agentId: "S1", phase: "waiting" }),
    )
    await feed(sup, "S1", "Read", `{"unrelated":"must not reset S1"}`)
    assert.equal(interventions(env).length, 1, "an uncorrelated lifecycle source cannot reset S1")

    await sup.onExternalEvent(
        { agentId: "S1" } as never,
        AgentState.create({
            agentId: "S1",
            phase: "waiting",
            detail: "retrying (attempt 2/3)",
        }),
    )
    await feed(sup, "S1", "Read", `{"attempt":2,"n":1}`)
    assert.equal(interventions(env).length, 1, "fresh attempt does not inherit counters")
    await feed(sup, "S1", "Grep", `{"attempt":2,"n":2}`)
    assert.equal(interventions(env).length, 2, "attempt 2 is independently supervised")
})

test("a real respawn clears prior intervention state", async () => {
    const { sup, env } = supervised({ noProgressToolCalls: 1, repeatThreshold: 999 })
    await feed(sup, "S1", "Read", `{"execution":1}`)
    assert.equal(interventions(env).length, 1)

    await sup.onExternalEvent(
        { agentId: "story-factory" } as never,
        StorySpawned.create({ storyId: "S1" }),
    )
    await feed(sup, "S1", "Read", `{"execution":2}`)
    assert.equal(interventions(env).length, 2, "recovery spawn is supervised independently")
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
