import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ContinuousGateRunner } from "../../src/verification/continuous-gate-runner.js"
import type { GateCommandOutcome } from "../../src/verification/continuous-gate.js"

const GREEN: GateCommandOutcome[] = [{ label: "go build ./...", passed: true, detail: "" }]
const RED: GateCommandOutcome[] = [
    { label: "go build ./...", passed: false, detail: "undefined: Foo" },
]

/** Minimal stand-ins for the mozaik surfaces the runner actually touches. */
function harness(gates: () => Promise<readonly GateCommandOutcome[]>) {
    const delivered: Array<{ recipientId: string; text: string }> = []
    const environment = {
        deliverSemanticEvent(_source: unknown, event: { data: unknown }) {
            delivered.push(event.data as { recipientId: string; text: string })
        },
    }
    let runs = 0
    const runner = new ContinuousGateRunner({
        runId: "run-1",
        resolveTarget: () => ({ cwd: "/tmp/worktree" }),
        settleMs: 5,
        runGates: async () => {
            runs += 1
            return await gates()
        },
    })
    ;(runner as unknown as { getEnvironments(): unknown[] }).getEnvironments = () => [environment]
    const write = (agentId: string) =>
        runner.onExternalFunctionCall(
            { agentId } as never,
            { name: "Write", callId: "c", arguments: "{}" } as never,
        )
    return { runner, delivered, write, runCount: () => runs }
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

describe("ContinuousGateRunner", () => {
    it("checks the worktree after a write and reports the result once", async () => {
        const h = harness(async () => RED)
        h.write("S1")
        await settle()
        assert.equal(h.runCount(), 1)
        assert.equal(h.delivered.length, 1)
        assert.equal(h.delivered[0]!.recipientId, "S1")
        assert.match(h.delivered[0]!.text, /FAIL {2}go build/u)
        h.runner.stop()
    })

    it("stays silent when nothing changed, however many writes land", async () => {
        const h = harness(async () => RED)
        h.write("S1")
        await settle()
        h.write("S1")
        await settle()
        assert.equal(h.runCount(), 2, "it re-checks")
        assert.equal(h.delivered.length, 1, "but only news reaches the agent")
        h.runner.stop()
    })

    it("speaks again when the picture changes", async () => {
        let outcome: GateCommandOutcome[] = RED
        const h = harness(async () => outcome)
        h.write("S1")
        await settle()
        outcome = GREEN
        h.write("S1")
        await settle()
        assert.equal(h.delivered.length, 2)
        assert.match(h.delivered[1]!.text, /PASS {2}go build/u)
        h.runner.stop()
    })

    it("collapses a burst of writes into one check", async () => {
        const h = harness(async () => GREEN)
        for (let i = 0; i < 5; i += 1) h.write("S1")
        await settle()
        assert.equal(h.runCount(), 1, "a story writing five files must not run five checks")
        h.runner.stop()
    })

    it("queues exactly one more pass for a write that lands mid-check", async () => {
        let release: (() => void) | null = null
        const gate = new Promise<void>((resolve) => { release = resolve })
        let calls = 0
        const h = harness(async () => {
            calls += 1
            if (calls === 1) await gate
            return GREEN
        })
        h.write("S1")
        await settle(20)
        h.write("S1")
        h.write("S1")
        h.write("S1")
        release!()
        await settle(60)
        assert.equal(h.runCount(), 2, "three writes during one check buy one re-check, not three")
        h.runner.stop()
    })

    it("keeps stories apart", async () => {
        const h = harness(async () => RED)
        h.write("S1")
        h.write("S2")
        await settle()
        assert.deepEqual(h.delivered.map((d) => d.recipientId).sort(), ["S1", "S2"])
        h.runner.stop()
    })

    it("says nothing at all when the gates cannot run", async () => {
        const h = harness(async () => { throw new Error("no toolchain") })
        h.write("S1")
        await settle()
        assert.equal(h.delivered.length, 0, "our failure is not the agent's problem")
        h.runner.stop()
    })

    it("goes quiet once stopped", async () => {
        const h = harness(async () => GREEN)
        h.runner.stop()
        h.write("S1")
        await settle()
        assert.equal(h.runCount(), 0)
        assert.equal(h.delivered.length, 0)
    })

    it("ignores tool calls that are not writes", async () => {
        const h = harness(async () => GREEN)
        h.runner.onExternalFunctionCall(
            { agentId: "S1" } as never,
            { name: "Bash", callId: "c", arguments: "{}" } as never,
        )
        await settle()
        assert.equal(h.runCount(), 0, "reading and running commands is not a reason to re-check")
        h.runner.stop()
    })
})

describe("the gate runs when it is worth running, not constantly", () => {
    // Ten concurrent `go build ./...` in ten worktrees starved the machine
    // until the Go compiler was killed, and the runner reported that to an
    // agent as a broken build. The agent then ran the same commands itself to
    // check — so the feature meant to remove that work doubled it.
    it("never runs two gates at once, however many stories write", async () => {
        let inFlight = 0
        let peak = 0
        const h = harness(async () => {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            await new Promise((r) => setTimeout(r, 30))
            inFlight -= 1
            return GREEN
        })
        for (const story of ["S1", "S2", "S3", "S4"]) h.write(story)
        await settle(300)
        assert.equal(peak, 1, "the machine runs one build at a time")
        assert.equal(h.runCount(), 4, "each story still gets checked")
        h.runner.stop()
    })

    it("treats a signal death as our failure, not the agent's", async () => {
        const h = harness(async () => {
            throw new Error("a gate command was killed before it reported")
        })
        h.write("S1")
        await settle()
        assert.equal(
            h.delivered.length,
            0,
            "a compiler we starved says nothing about the patch",
        )
        h.runner.stop()
    })
})
