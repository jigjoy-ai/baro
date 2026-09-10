import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isMilestone, parseLine } from "../../src/operator/protocol.js"
import {
    RunTracker,
    classifyDone,
    renderOutcome,
    renderProgress,
    resolveTerminal,
} from "../../src/operator/run-tracker.js"

describe("operator protocol", () => {
    it("parses only JSON objects with a string type", () => {
        assert.equal(parseLine("not json"), null)
        assert.equal(parseLine('{"no":"type"}'), null)
        assert.equal(parseLine("[1,2]"), null)
        assert.deepEqual(parseLine(' {"type":"progress","completed":1,"total":3} '), {
            type: "progress",
            completed: 1,
            total: 3,
        })
    })

    it("splits milestone from live feed by type", () => {
        assert.equal(isMilestone({ type: "critique" }), true)
        assert.equal(isMilestone({ type: "activity" }), false)
    })
})

describe("operator run tracker", () => {
    it("classifies done by success first, then the one code it knows", () => {
        assert.equal(classifyDone({ type: "done", success: true }), "completed")
        assert.equal(classifyDone({ type: "done", success: false, abort_code: "token_ceiling" }), "max-tokens")
        assert.equal(classifyDone({ type: "done", success: false, abort_code: "shell_timeout" }), "error")
    })

    it("treats a run whose stories all merged with verification passed as delivered", () => {
        const done = {
            type: "done",
            success: false,
            abort_reason: "global goal is not satisfied (G-A1): 1 open invariant(s)",
            verification_status: "passed",
            stats: { stories_completed: 3, stories_skipped: 0, total_commits: 6 },
        }
        assert.equal(classifyDone(done), "completed")
        const tracker = new RunTracker()
        tracker.accept(done)
        const text = renderOutcome(tracker.summary(), "completed")
        assert.match(text, /^baro run delivered: every story merged and verification passed/)
        assert.match(text, /commits: 6/)
        assert.equal(classifyDone({ ...done, stats: { ...done.stats, stories_skipped: 1 } }), "error")
    })

    it("resolves a terminal without a done line from the exit code", () => {
        assert.equal(resolveTerminal(true, 0, undefined), "aborted")
        assert.equal(resolveTerminal(false, 0, undefined), "completed")
        assert.equal(resolveTerminal(false, 1, undefined), "error")
    })

    it("returns the milestone line it recorded and keeps the log bounded", () => {
        const tracker = new RunTracker(3)
        assert.equal(tracker.accept({ type: "activity", text: "noise" }), null)
        assert.match(tracker.accept({ type: "init", project: "demo", stories: [{ id: "S1" }, { id: "S2" }] }) ?? "", /^init demo \(2 stories\)$/)
        assert.match(tracker.accept({ type: "story_start", id: "S1", ts: "2026-09-09T10:00:01.000Z" }) ?? "", /^10:00:01 story_start S1$/)
        tracker.accept({ type: "progress", completed: 1, total: 2 })
        tracker.accept({ type: "push_status", pr_url: "https://example.test/pr/1" })
        tracker.accept({ type: "done", success: true, stats: { stories_completed: 2, stories_skipped: 0 } })
        const summary = tracker.summary()
        assert.equal(summary.phase, "done")
        assert.deepEqual([summary.completed, summary.total], [1, 2])
        assert.equal(summary.prUrl, "https://example.test/pr/1")
        assert.equal(summary.milestones.length, 3, "oldest milestone dropped past the limit")
        assert.match(renderProgress(summary), /^phase: done\nactivity: noise\nproject: demo\nprogress: 1\/2\npr: https/)
    })

    it("follows the phases the stream announces before the first milestone", () => {
        const tracker = new RunTracker()
        assert.equal(tracker.summary().phase, "intake")
        tracker.accept({ type: "architect_start" })
        assert.equal(tracker.summary().phase, "architect")
        tracker.accept({ type: "plan_fragment", stories: [{ id: "S1", title: "Title case" }] })
        assert.equal(tracker.summary().phase, "planning")
        assert.equal(tracker.summary().storiesTotal, 1)
        // Progressive planning inits with an empty graph; the fragment count stays.
        tracker.accept({ type: "init", project: "p", stories: [] })
        assert.equal(tracker.summary().phase, "executing")
        assert.equal(tracker.summary().storiesTotal, 1)
        tracker.accept({ type: "activity", id: "S1", text: "npm test" })
        assert.equal(tracker.summary().activity, "S1: npm test")
        tracker.accept({ type: "finalize_start" })
        assert.equal(tracker.summary().phase, "finalizing")
    })

    it("keeps each story's latest state for the drill-in", () => {
        const tracker = new RunTracker()
        tracker.accept({ type: "plan_fragment", stories: [{ id: "S1", title: "Core" }, { id: "S2", title: "CLI" }] })
        // The lifecycle forwarder sends the id as the title; the fragment's title wins.
        tracker.accept({ type: "story_start", id: "S1", title: "S1" })
        tracker.accept({ type: "story_start", id: "S2" })
        tracker.accept({ type: "story_log", id: "S2", line: "1I{" })
        assert.notEqual(tracker.summary().activity, "S2: 1I{", "raw story_log lines are not status")
        tracker.accept({ type: "story_complete", id: "S1" })
        tracker.accept({ type: "story_merged", id: "S1" })
        tracker.accept({ type: "story_error", id: "S2", error: "boom" })
        assert.deepEqual(
            tracker.summary().stories.map((s) => [s.id, s.title, s.status]),
            [["S1", "Core", "merged"], ["S2", "CLI", "failed"]],
        )
        tracker.accept({ type: "done", success: false, abort_reason: "verification failed: npm test" })
        assert.equal(tracker.summary().abortReason, "verification failed: npm test")
    })
})
