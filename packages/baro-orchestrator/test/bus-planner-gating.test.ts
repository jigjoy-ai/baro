import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    withoutLatchlessBusPlanner,
    type OrchestrateConfig,
} from "../src/orchestrate.js"

describe("bus planner gating (#209, #210)", () => {
    const base = {
        prdPath: "prd.json",
        cwd: ".",
        busPlanner: { backend: "openai" },
    } as OrchestrateConfig

    it("drops the bus planner from a run that has no progressive-planning latch", () => {
        assert.equal(withoutLatchlessBusPlanner(base).busPlanner, undefined)
    })

    it("keeps it for a progressive run", () => {
        const config = { ...base, progressivePlanningId: "planning-1" }
        assert.equal(withoutLatchlessBusPlanner(config), config)
    })
})
