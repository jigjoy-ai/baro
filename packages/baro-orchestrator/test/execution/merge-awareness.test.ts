import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { noticesForLanding } from "../../src/execution/merge-awareness.js"

const S1 = { storyId: "S1", paths: ["internal/order/helpers_test.go", "internal/order/model_test.go"] }

describe("merge awareness", () => {
    // S12 wrote allowed_status_for_payment_test.go and forbidden_status_transition_test.go
    // and died at integration on "conflicts with already-merged work". Nothing
    // had told it those files landed while it was working.
    it("warns the agent whose own files just landed under it", () => {
        const [notice] = noticesForLanding(S1, [
            { agentId: "S12", writes: ["internal/order/helpers_test.go"] },
        ])
        assert.equal(notice!.recipientId, "S12")
        assert.equal(notice!.collides, true)
        assert.match(notice!.text, /helpers_test\.go/u)
        assert.match(notice!.text, /Its version is on the branch now/u)
    })

    it("still tells uninvolved agents what ground is no longer free", () => {
        const [notice] = noticesForLanding(S1, [
            { agentId: "S7", writes: ["internal/transport/http/server_test.go"] },
        ])
        assert.equal(notice!.collides, false)
        assert.match(notice!.text, /Do not write them again/u)
        assert.match(notice!.text, /helpers_test\.go/u)
    })

    it("never talks to the story that just merged", () => {
        assert.deepEqual(noticesForLanding(S1, [{ agentId: "S1", writes: [] }]), [])
    })

    it("says nothing when the landing wrote nothing observable", () => {
        assert.deepEqual(
            noticesForLanding({ storyId: "S1", paths: [] }, [{ agentId: "S2", writes: ["a.go"] }]),
            [],
        )
    })

    it("names the collision separately from the rest of the landing", () => {
        const [notice] = noticesForLanding(
            { storyId: "S1", paths: ["a.go", "b.go", "c.go"] },
            [{ agentId: "S2", writes: ["b.go"] }],
        )
        assert.match(notice!.text, /you also wrote:\n {2}b\.go/u)
        assert.match(notice!.text, /It also landed: a\.go, c\.go/u)
    })

    it("bounds a large landing instead of pasting a hundred paths", () => {
        const many = Array.from({ length: 30 }, (_, i) => `pkg/file${i}.go`)
        const [notice] = noticesForLanding({ storyId: "S1", paths: many }, [
            { agentId: "S2", writes: [] },
        ])
        assert.match(notice!.text, /and 18 more/u)
        assert.ok(notice!.text.split("\n").length < 20)
    })

    it("treats ./x and x as the same file", () => {
        const [notice] = noticesForLanding({ storyId: "S1", paths: ["./a.go"] }, [
            { agentId: "S2", writes: ["a.go"] },
        ])
        assert.equal(notice!.collides, true)
    })

    it("tells every working agent, not only the colliding one", () => {
        const notices = noticesForLanding(S1, [
            { agentId: "S2", writes: ["internal/order/model_test.go"] },
            { agentId: "S3", writes: ["other.go"] },
        ])
        assert.deepEqual(notices.map((n) => n.recipientId), ["S2", "S3"])
        assert.deepEqual(notices.map((n) => n.collides), [true, false])
    })
})
