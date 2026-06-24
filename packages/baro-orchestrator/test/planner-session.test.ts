import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    PlannerSession,
    type PlannerModelCall,
} from "../src/planning/planner-session.js"
import { buildDag } from "../src/dag.js"

// A scripted model: seed → 5-story draft; each refinement turn returns a
// canned mutation keyed on the user message. Detect seed vs turn by the
// presence of "CURRENT DRAFT:" in the user prompt.
const SEED = JSON.stringify({
    project: "reservations",
    branchName: "add-reservations",
    description: "Add a reservations module",
    userStories: [
        { id: "S1", priority: 1, title: "Entity", description: "entity", dependsOn: [], acceptance: ["x"], tests: ["npm test"], model: "opus" },
        { id: "S2", priority: 2, title: "DTOs", description: "dtos", dependsOn: ["S1"], acceptance: ["x"], tests: ["npm test"], model: "haiku" },
        { id: "S3", priority: 2, title: "Migration", description: "mig", dependsOn: ["S1"], acceptance: ["x"], tests: ["npm test"], model: "haiku" },
        { id: "S4", priority: 3, title: "Service", description: "svc", dependsOn: ["S2", "S3"], acceptance: ["x"], tests: ["npm test"], model: "opus" },
        { id: "S5", priority: 4, title: "Controller", description: "ctrl", dependsOn: ["S4"], acceptance: ["x"], tests: ["npm test"], model: "sonnet" },
    ],
})

const SPLIT = JSON.stringify({
    reply: "Split the service into CRUD + overlap.",
    removedStoryIds: ["S4"],
    addedStories: [
        { id: "S4a", priority: 3, title: "Service CRUD", description: "crud", dependsOn: ["S2", "S3"], acceptance: ["x"], tests: ["npm test"], model: "sonnet" },
        { id: "S4b", priority: 3, title: "Overlap guard", description: "overlap", dependsOn: ["S2", "S3"], acceptance: ["x"], tests: ["npm test"], model: "opus" },
    ],
    modifiedDeps: [{ id: "S5", newDependsOn: ["S4a", "S4b"] }],
})

const RETIER = JSON.stringify({ reply: "Overlap guard → sonnet.", retier: { S4b: "sonnet" } })
const CYCLE = JSON.stringify({ reply: "Make S1 depend on S5.", modifiedDeps: [{ id: "S1", newDependsOn: ["S5"] }] })
const QUESTION = JSON.stringify({ reply: "There are 5 stories; the critical path is S1→S4→S5." })

function scriptedModel(): PlannerModelCall {
    return async (_system, user) => {
        if (!user.includes("CURRENT DRAFT:")) return SEED
        // Key only on the user MESSAGE, not the rendered draft (which
        // itself contains tier words like "sonnet").
        const msg = user.split("USER MESSAGE:")[1] ?? ""
        if (msg.includes("split")) return SPLIT
        if (msg.includes("sonnet")) return RETIER
        if (msg.includes("cycle")) return CYCLE
        return QUESTION
    }
}

describe("PlannerSession — conversational draft mutation", () => {
    it("seeds a valid, acyclic draft from the goal", async () => {
        const s = new PlannerSession({ goal: "Add reservations", call: scriptedModel() })
        const draft = await s.seed()
        assert.equal(draft.userStories.length, 5)
        assert.deepEqual(draft.userStories.map((x) => x.id), ["S1", "S2", "S3", "S4", "S5"])
        // doesn't throw → acyclic; S1 alone on L0, so >1 level
        assert.ok(buildDag(draft.userStories).length >= 2)
    })

    it("splits a story and rewires its dependents", async () => {
        const s = new PlannerSession({ goal: "g", call: scriptedModel() })
        await s.seed()
        const turn = await s.handleMessage("please split the service story")

        const ids = turn.draft.userStories.map((x) => x.id)
        assert.ok(!ids.includes("S4"), "S4 removed")
        assert.ok(ids.includes("S4a") && ids.includes("S4b"), "S4a/S4b added")
        const s5 = turn.draft.userStories.find((x) => x.id === "S5")!
        assert.deepEqual([...s5.dependsOn].sort(), ["S4a", "S4b"], "S5 rewired")
        // still acyclic
        assert.doesNotThrow(() => buildDag(turn.draft.userStories))
    })

    it("re-tiers an existing story", async () => {
        const s = new PlannerSession({ goal: "g", call: scriptedModel() })
        await s.seed()
        await s.handleMessage("split the service story")
        const turn = await s.handleMessage("make the overlap guard sonnet")
        const s4b = turn.draft.userStories.find((x) => x.id === "S4b")!
        assert.equal(s4b.model, "sonnet")
    })

    it("rejects a mutation that introduces a cycle and keeps the prior draft", async () => {
        const s = new PlannerSession({ goal: "g", call: scriptedModel() })
        await s.seed()
        const before = s.draft!.userStories.find((x) => x.id === "S1")!.dependsOn
        const turn = await s.handleMessage("introduce a cycle")
        assert.ok(turn.rejected, "turn marked rejected")
        assert.match(turn.rejected!, /cycle/i)
        // draft unchanged: S1 still has no deps
        const after = s.draft!.userStories.find((x) => x.id === "S1")!.dependsOn
        assert.deepEqual([...after], [...before])
        assert.deepEqual([...after], [])
    })

    it("answers a question without mutating the draft", async () => {
        const s = new PlannerSession({ goal: "g", call: scriptedModel() })
        await s.seed()
        const idsBefore = s.draft!.userStories.map((x) => x.id)
        const turn = await s.handleMessage("how many stories are there?")
        assert.match(turn.reply, /5 stories/)
        assert.deepEqual(turn.draft.userStories.map((x) => x.id), idsBefore)
    })
})
