import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"

import { fallbackPrdJson, resolvePlannerModelName } from "../src/planning/planner-openai.js"

describe("PlannerOpenAI fallback PRD", () => {
    it("returns a valid one-story PRD when planning cannot finalize", () => {
        const prd = JSON.parse(fallbackPrdJson("Redesign the execute screen into a run workspace", "test"))

        assert.equal(prd.project, "baro-run")
        assert.match(prd.branchName, /^baro\/redesign-the-execute-screen/)
        assert.equal(prd.userStories.length, 1)
        assert.equal(prd.userStories[0].id, "S1")
        assert.deepEqual(prd.userStories[0].dependsOn, [])
        assert.equal(prd.userStories[0].model, "heavy")
        assert.ok(prd.userStories[0].description.includes("Planner fallback: test"))
    })
})

describe("PlannerOpenAI complexity routing", () => {
    const saved = process.env.BARO_PLANNER_FOCUSED_MODEL
    afterEach(() => {
        if (saved === undefined) delete process.env.BARO_PLANNER_FOCUSED_MODEL
        else process.env.BARO_PLANNER_FOCUSED_MODEL = saved
    })

    it("routes a focused goal to the cheap floor model even on a high ceiling", () => {
        process.env.BARO_PLANNER_FOCUSED_MODEL = "deepseek-v4-pro"
        assert.equal(resolvePlannerModelName("focused", "gpt-5.5"), "deepseek-v4-pro")
    })

    it("routes a parallel goal to the tier ceiling model", () => {
        process.env.BARO_PLANNER_FOCUSED_MODEL = "deepseek-v4-pro"
        assert.equal(resolvePlannerModelName("parallel", "gpt-5.5"), "gpt-5.5")
    })

    it("routes a sequential goal to the tier ceiling model", () => {
        process.env.BARO_PLANNER_FOCUSED_MODEL = "deepseek-v4-pro"
        assert.equal(resolvePlannerModelName("sequential", "glm-5.2"), "glm-5.2")
    })

    it("does not downgrade a focused local run when the floor env is unset", () => {
        delete process.env.BARO_PLANNER_FOCUSED_MODEL
        assert.equal(resolvePlannerModelName("focused", "gpt-5.5"), "gpt-5.5")
    })
})
