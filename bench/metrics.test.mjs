import assert from "node:assert/strict"
import { test } from "node:test"
import { metrics, parseStream } from "./metrics.mjs"

const usage = (phase, storyId, usd, input, cached, output, durationMs) => ({
    type: "model_usage",
    measurement: {
        phase,
        storyId,
        cost: { equivalentUsd: { state: "known", value: usd } },
        durationMs: { state: "known", value: durationMs },
        tokens: {
            inputTotal: { state: "known", value: input },
            cachedInput: { state: "known", value: cached },
            cacheWriteInput: { state: "known", value: input - cached },
            outputTotal: { state: "known", value: output },
        },
    },
})
const at = (s) => new Date(Date.UTC(2026, 10, 6, 12, 0, s)).toISOString()

const stream = [
    { ts: at(0), type: "architect_start" },
    { ts: at(10), type: "architect_complete" },
    "not json",
    { ts: at(20), type: "init", stories: [] },
    { ts: at(25), type: "replan", added: [{ id: "S1" }, { id: "S2" }] },
    { ts: at(30), type: "story_start", id: "S1" },
    { ts: at(31), type: "story_start", id: "S2" },
    { ts: at(40), type: "story_retry", id: "S2", attempt: 2 },
    { ts: at(41), type: "story_start", id: "S2" },
    { ts: at(45), type: "turn_review", id: "S1", turn: 1, status: "inconclusive", verdict: "fail", stale_commands: ["npm test"] },
    { ts: at(48), type: "turn_review", id: "S1", turn: 2, status: "evaluated", verdict: "fail" },
    { ts: at(49), type: "turn_review", id: "S1", turn: 3, status: "evaluated", verdict: "pass" },
    { ts: at(50), type: "story_merged", id: "S1" },
    { ts: at(55), type: "story_merged", id: "S2" },
    { ts: at(59), type: "done", success: true, verification_status: "passed" },
    usage("planner", null, 0.5, 1000, 600, 100, 4000),
    usage("story", "S1", 0.25, 2000, 1800, 50, 9000),
    usage("story", "S2", 0.25, 1000, 0, 50, 3000),
]
    .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
    .join("\n")

test("derives phase timings, cost and tokens from the event stream", () => {
    const m = metrics(parseStream(stream))
    assert.equal(m.success, true)
    assert.equal(m.verification, "passed")
    assert.equal(m.total_secs, 59)
    assert.equal(m.architect_secs, 10)
    assert.equal(m.to_first_story_secs, 30)
    assert.equal(m.stories_secs, 25)
    assert.equal(m.finalize_secs, 4)
    assert.equal(m.story_count, 2)
    assert.equal(m.retries, 1)
    assert.equal(m.replans, 1)
    assert.deepEqual(m.critic_reviews, { total: 3, rejected: 1, stale_evidence: 1 })
    assert.equal(m.cost_usd, 1)
    assert.deepEqual(m.tokens, { input: 4000, cached_input: 2400, cache_write: 1600, output: 200 })
    assert.equal(m.cache_hit_ratio, 0.6)
    assert.deepEqual(m.phases.story, { calls: 2, cost_usd: 0.5, model_secs: 12 })
    assert.deepEqual(m.stories, [
        { id: "S1", secs: 20, attempts: 1, reviews: 3, cost_usd: 0.25 },
        { id: "S2", secs: 24, attempts: 2, reviews: 0, cost_usd: 0.25 },
    ])
})

test("measures from the runner's start when it is given", () => {
    const m = metrics(parseStream(stream), { startedAt: Date.parse(at(0)) - 5000 })
    assert.equal(m.total_secs, 64)
    assert.equal(m.to_first_story_secs, 35)
})

test("an unfinished run is not a success", () => {
    const m = metrics(parseStream(stream.split("\n").slice(0, 7).join("\n")))
    assert.equal(m.critic_reviews, null)
    assert.equal(m.success, false)
    assert.equal(m.finalize_secs, null)
})
