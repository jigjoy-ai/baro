import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
} from "../../src/runtime/mozaik.js"
import { StoryMerged } from "../../src/events/integration.js"
import { StoryResult } from "../../src/semantic-events.js"
import { MergeAwarenessRunner } from "../../src/execution/merge-awareness-runner.js"

class FakeAgent extends BaseObserver {
    constructor(readonly agentId: string) {
        super()
    }
}

class FakeIntegrator extends BaseObserver {}

function harness(withAuthority = true) {
    const env = new AgenticEnvironment("merge-awareness")
    const integrator = new FakeIntegrator()
    integrator.join(env)
    const runner = new MergeAwarenessRunner({
        runId: "run-1",
        ...(withAuthority ? { integrationAuthority: integrator } : {}),
    })
    runner.join(env)

    const delivered: Array<{ recipientId: string; text: string; metadata: Record<string, unknown> }> = []
    const real = env.deliverSemanticEvent.bind(env)
    env.deliverSemanticEvent = (source, event) => {
        const data = (event as { data?: unknown }).data as { recipientId?: string }
        if (data?.recipientId) delivered.push(data as never)
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
    const merge = (storyId: string, by: BaseObserver = integrator) =>
        env.deliverSemanticEvent(by, StoryMerged.create({ storyId, mode: "worktree", runId: "run-1" }))
    const finish = (storyId: string) =>
        env.deliverSemanticEvent(
            integrator,
            StoryResult.create({ storyId, runId: "run-1", success: true, attempts: 1, durationSecs: 1, error: null } as never),
        )
    return { env, integrator, runner, delivered, write, merge, finish }
}

describe("MergeAwarenessRunner on a real bus", () => {
    it("warns the agent that was writing the same file", () => {
        const h = harness()
        h.write("S1", "internal/order/helpers_test.go")
        h.write("S12", "internal/order/helpers_test.go")
        h.merge("S1")

        assert.equal(h.delivered.length, 1)
        assert.equal(h.delivered[0]!.recipientId, "S12")
        assert.equal(h.delivered[0]!.metadata.collides, true)
        assert.match(h.delivered[0]!.text, /helpers_test\.go/u)
    })

    it("tells uninvolved workers what ground is taken", () => {
        const h = harness()
        h.write("S1", "a_test.go")
        h.write("S7", "b_test.go")
        h.merge("S1")

        assert.equal(h.delivered.length, 1)
        assert.equal(h.delivered[0]!.recipientId, "S7")
        assert.equal(h.delivered[0]!.metadata.collides, false)
    })

    it("says nothing to an agent that already finished", () => {
        const h = harness()
        h.write("S1", "a_test.go")
        h.write("S7", "b_test.go")
        h.finish("S7")
        h.merge("S1")

        assert.equal(h.delivered.length, 0, "a finished agent cannot act on news")
    })

    it("believes only the integration authority", () => {
        const h = harness()
        h.write("S1", "a_test.go")
        h.write("S7", "b_test.go")
        const impostor = new FakeAgent("impostor")
        impostor.join(h.env)
        h.merge("S1", impostor)

        assert.equal(h.delivered.length, 0, "an unfenced merge claim must not move anyone")
        h.merge("S1")
        assert.equal(h.delivered.length, 1)
    })

    it("ignores merges from another run", () => {
        const h = harness()
        h.write("S1", "a_test.go")
        h.write("S7", "b_test.go")
        h.env.deliverSemanticEvent(
            h.integrator,
            StoryMerged.create({ storyId: "S1", mode: "worktree", runId: "other-run" }),
        )
        assert.equal(h.delivered.length, 0)
    })

    it("stays silent when the landed story wrote nothing it saw", () => {
        const h = harness()
        h.write("S7", "b_test.go")
        h.merge("S1")
        assert.equal(h.delivered.length, 0)
    })

    it("does not record reads as writes", () => {
        const h = harness()
        const reader = new FakeAgent("S7")
        reader.join(h.env)
        h.env.deliverFunctionCall(
            reader,
            FunctionCallItem.rehydrate({
                callId: "r1",
                name: "Read",
                args: JSON.stringify({ file_path: "a_test.go" }),
            }),
        )
        h.write("S1", "a_test.go")
        h.merge("S1")
        assert.equal(h.delivered.length, 0, "a reader is not an audience and never collides")
    })
})

describe("one file, one name across worktrees", () => {
    // The first live run fired 21 notices and reported zero collisions,
    // because each agent writes an absolute path inside its own worktree:
    // .../S13/internal/order/x.go never equals .../S10/internal/order/x.go.
    // The feature ran the whole time and could not do its job.
    it("sees two worktrees writing the same file as a collision", () => {
        const roots: Record<string, string> = {
            S13: "/tmp/wt/run-1/S13",
            S10: "/tmp/wt/run-1/S10",
        }
        const env = new AgenticEnvironment("relative")
        const integrator = new FakeIntegrator()
        integrator.join(env)
        const runner = new MergeAwarenessRunner({
            runId: "run-1",
            integrationAuthority: integrator,
            resolveRoot: (agentId) => roots[agentId] ?? null,
        })
        runner.join(env)

        const delivered: Array<{ recipientId: string; text: string; metadata: Record<string, unknown> }> = []
        const real = env.deliverSemanticEvent.bind(env)
        env.deliverSemanticEvent = (source, event) => {
            const data = (event as { data?: { recipientId?: string } }).data
            if (data?.recipientId) delivered.push(data as never)
            real(source, event)
        }

        for (const [agentId, root] of Object.entries(roots)) {
            const agent = new FakeAgent(agentId)
            agent.join(env)
            env.deliverFunctionCall(
                agent,
                FunctionCallItem.rehydrate({
                    callId: `c-${agentId}`,
                    name: "Write",
                    args: JSON.stringify({ file_path: `${root}/internal/order/x_test.go` }),
                }),
            )
        }
        env.deliverSemanticEvent(
            integrator,
            StoryMerged.create({ storyId: "S13", mode: "worktree", runId: "run-1" }),
        )

        assert.equal(delivered.length, 1)
        assert.equal(delivered[0]!.recipientId, "S10")
        assert.equal(delivered[0]!.metadata.collides, true, "same file, different worktree")
        assert.match(delivered[0]!.text, /internal\/order\/x_test\.go/u)
        assert.doesNotMatch(delivered[0]!.text, /\/tmp\/wt/u, "a worktree path means nothing to the reader")
        runner.stop?.()
    })
})
