// mozaik 3.12 delivers with `void this.react(...)` and no try/catch: anything
// thrown in a handler becomes an unhandled rejection and kills the run. It did
// exactly that on a Coordination event that carried no payload, 88 seconds
// into a live replay. Every participant we add has to survive malformed input.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { AgenticEnvironment, BaseObserver } from "../../src/runtime/mozaik.js"
import { Coordination } from "../../src/events/collaboration.js"
import { StoryMerged } from "../../src/events/integration.js"
import { OverlapAwarenessRunner } from "../../src/execution/overlap-awareness-runner.js"
import { MergeAwarenessRunner } from "../../src/execution/merge-awareness-runner.js"

class Src extends BaseObserver {}

describe("a participant must never throw out of a handler", () => {
    it("overlap: Coordination with no payload", () => {
        const env = new AgenticEnvironment("p")
        const src = new Src(); src.join(env)
        new OverlapAwarenessRunner({ runId: "r" }).join(env)
        assert.doesNotThrow(() => {
            env.deliverSemanticEvent(src, Coordination.create({
                fromAgentId: "a", recipientId: "b", kind: "notice", reason: "x",
            } as never))
        })
    })
    it("merge: StoryMerged with no runId", () => {
        const env = new AgenticEnvironment("p")
        const src = new Src(); src.join(env)
        new MergeAwarenessRunner({ runId: "r" }).join(env)
        assert.doesNotThrow(() => {
            env.deliverSemanticEvent(src, StoryMerged.create({ storyId: "S1" } as never))
        })
    })
})
