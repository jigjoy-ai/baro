import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { fallbackPrdJson } from "../src/planning/planner-openai.js"

describe("PlannerOpenAI fallback PRD", () => {
    it("returns a valid one-story PRD when planning cannot finalize", () => {
        const prd = JSON.parse(fallbackPrdJson("Redesign the execute screen into a run workspace", "test"))

        assert.equal(prd.project, "baro-run")
        assert.match(prd.branchName, /^baro\/redesign-the-execute-screen/)
        assert.equal(prd.userStories.length, 1)
        assert.equal(prd.userStories[0].id, "S1")
        assert.deepEqual(prd.userStories[0].dependsOn, [])
        assert.equal(prd.userStories[0].model, "opus")
        assert.ok(prd.userStories[0].description.includes("Planner fallback: test"))
    })
})
