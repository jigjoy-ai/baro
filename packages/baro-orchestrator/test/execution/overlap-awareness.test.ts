import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
} from "../../src/runtime/mozaik.js"
import { Coordination } from "../../src/events/collaboration.js"
import { StoryResult } from "../../src/semantic-events.js"
import { noticesForOverlap } from "../../src/execution/overlap-awareness.js"
import { OverlapAwarenessRunner } from "../../src/execution/overlap-awareness-runner.js"
import { Sentry } from "../../src/execution/sentry.js"

describe("overlap awareness policy", () => {
    it("tells both sides, each about the other", () => {
        const notices = noticesForOverlap("internal/order/helpers_test.go", ["S3", "S7"])
        assert.deepEqual(notices.map((n) => n.recipientId), ["S3", "S7"])
        assert.match(notices[0]!.text, /S7 is writing it too/u)
        assert.match(notices[1]!.text, /S3 is writing it too/u)
    })

    it("gives facts and a way to talk, never a verdict", () => {
        const [notice] = noticesForOverlap("a.go", ["S1", "S2"])
        assert.match(notice!.text, /Settle it between you/u)
        assert.match(notice!.text, /agent-collab/u)
        // A host that picked the winner would be the coordinator we avoid.
        assert.doesNotMatch(notice!.text, /you must yield|stop working|S2 owns/iu)
    })

    it("says nothing when there is no overlap to report", () => {
        assert.deepEqual(noticesForOverlap("a.go", ["S1"]), [])
        assert.deepEqual(noticesForOverlap("a.go", ["S1", "S1"]), [])
        assert.deepEqual(noticesForOverlap("  ", ["S1", "S2"]), [])
    })

    it("bounds how many peers it names", () => {
        const [notice] = noticesForOverlap("a.go", ["S1", "S2", "S3", "S4", "S5", "S6", "S7"])
        assert.match(notice!.text, /and 2 other agent\(s\)/u)
    })
})

class FakeAgent extends BaseObserver {
    constructor(readonly agentId: string) {
        super()
    }
}

describe("OverlapAwarenessRunner closes Sentry's circuit", () => {
    // Sentry has emitted this notice since it was written and nothing ever
    // consumed it, so the first either agent heard of the other was at the
    // merge — after both had paid for the work.
    function harness() {
        const env = new AgenticEnvironment("overlap")
        const sentry = new Sentry({})
        sentry.join(env)
        const runner = new OverlapAwarenessRunner({
            runId: "run-1",
            detectionAuthority: sentry,
        })
        runner.join(env)

        const delivered: Array<{ recipientId: string; text: string }> = []
        const real = env.deliverSemanticEvent.bind(env)
        env.deliverSemanticEvent = (source, event) => {
            const data = (event as { data?: { recipientId?: string } }).data
            if (data?.recipientId && (event as { type?: string }).type === "agent_targeted_message") {
                delivered.push(data as never)
            }
            real(source, event)
        }

        const agents = new Map<string, FakeAgent>()
        const write = (agentId: string, path: string) => {
            let agent = agents.get(agentId)
            if (!agent) {
                agent = new FakeAgent(agentId)
                agent.join(env)
                agents.set(agentId, agent)
            }
            env.deliverFunctionCall(
                agent,
                FunctionCallItem.rehydrate({
                    callId: `c-${agentId}-${path}`,
                    name: "Write",
                    args: JSON.stringify({ file_path: path }),
                }),
            )
        }
        return { env, sentry, runner, delivered, write }
    }

    it("turns a real Sentry detection into messages both agents receive", () => {
        const h = harness()
        h.write("S3", "internal/order/helpers_test.go")
        h.write("S7", "internal/order/helpers_test.go")

        assert.deepEqual(
            h.delivered.map((d) => d.recipientId).sort(),
            ["S3", "S7"],
            "detection existed already; delivery is what was missing",
        )
    })

    it("does not repeat itself for the same file", () => {
        const h = harness()
        h.write("S3", "a.go")
        h.write("S7", "a.go")
        const first = h.delivered.length
        h.write("S7", "a.go")
        assert.equal(h.delivered.length, first)
    })

    it("believes only the detector it was given", () => {
        const h = harness()
        const impostor = new FakeAgent("impostor")
        impostor.join(h.env)
        h.env.deliverSemanticEvent(
            impostor,
            Coordination.create({
                fromAgentId: "S3",
                recipientId: "S7",
                kind: "notice",
                reason: "forged",
                payload: { path: "a.go", agents: ["S3", "S7"] },
            }),
        )
        assert.equal(h.delivered.length, 0)
    })

    it("stays quiet toward an agent that already finished", () => {
        const h = harness()
        h.write("S3", "a.go")
        h.env.deliverSemanticEvent(
            h.sentry,
            StoryResult.create({
                storyId: "S7", runId: "run-1", success: true,
                attempts: 1, durationSecs: 1, error: null,
            } as never),
        )
        h.write("S7", "a.go")
        assert.deepEqual(h.delivered.map((d) => d.recipientId), ["S3"])
    })
})
