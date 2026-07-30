import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
} from "../../src/runtime/mozaik.js"
import { ContinuousGateRunner } from "../../src/verification/continuous-gate-runner.js"

class FakeStoryAgent extends BaseObserver {
    constructor(readonly agentId: string) {
        super()
    }
}

describe("ContinuousGateRunner on a real bus", () => {
    // The unit tests drive onExternalFunctionCall directly, which proves the
    // policy but not that mozaik ever calls it. A live run wired this in and
    // delivered nothing, so the wiring itself needs a test.
    it("receives a write from another participant and answers on the bus", async () => {
        const env = new AgenticEnvironment("gate-probe")
        const agent = new FakeStoryAgent("S1")
        agent.join(env)

        const runner = new ContinuousGateRunner({
            runId: "r1",
            resolveTarget: () => ({ cwd: "/tmp" }),
            settleMs: 5,
            runGates: async () => [{ label: "probe", passed: true, detail: "" }],
        })
        runner.join(env)

        const delivered: unknown[] = []
        const real = env.deliverSemanticEvent.bind(env)
        env.deliverSemanticEvent = (source, event) => {
            delivered.push(event)
            real(source, event)
        }

        env.deliverFunctionCall(
            agent,
            FunctionCallItem.rehydrate({ callId: "c1", name: "Write", args: "{}" }),
        )
        await new Promise((resolve) => setTimeout(resolve, 120))
        runner.stop()

        assert.equal(delivered.length, 1, "the runner must answer a write it observed")
    })
})
