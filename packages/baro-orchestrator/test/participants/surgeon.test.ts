import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Surgeon, type PrdSnapshot } from "../../src/participants/surgeon.js"
import { Replan, StoryResult } from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

const snapshot: PrdSnapshot = {
    project: "Surgeon test",
    description: "Exercise deterministic recovery",
    stories: [
        {
            id: "S1",
            title: "Foundation",
            description: "Done first",
            dependsOn: [],
            passes: true,
            model: "haiku",
        },
        {
            id: "S2",
            title: "Recoverable failure",
            description: "This story failed",
            dependsOn: ["S1"],
            passes: false,
            model: "sonnet",
        },
    ],
}

describe("Surgeon", () => {
    it("emits a deterministic replan for a failed story", async () => {
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
            maxReplans: 1,
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(
            source("S2"),
            StoryResult.create({
                storyId: "S2",
                success: false,
                attempts: 3,
                durationSecs: 45,
                error: "tests failed",
            }),
        )
        await surgeon.idle()

        const replan = env.events.find((event) => Replan.is(event))
        assert.ok(replan, "Replan emitted")
        assert.deepEqual(replan.data, {
            source: "surgeon",
            reason: "deterministic skip: S2 exhausted 3 attempts (tests failed)",
            addedStories: [],
            removedStoryIds: ["S2"],
            modifiedDeps: {},
        })
    })

    it("ignores successful StoryResult events", async () => {
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(
            source("S1"),
            StoryResult.create({
                storyId: "S1",
                success: true,
                attempts: 1,
                durationSecs: 8,
            }),
        )
        await surgeon.idle()

        assert.equal(env.events.filter(Replan.is).length, 0)
    })
})
