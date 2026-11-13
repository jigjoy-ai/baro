import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import { CoordinationBus, BusMember } from "../../src/runtime/coordination.js"
import { StoryMerged, StoryMergeFailed } from "../../src/events/integration.js"
import { WorkBlocked } from "../../src/events/execution.js"
import { RunVerificationCompleted } from "../../src/events/verification.js"
import { StoryResult } from "../../src/semantic-events.js"
import { PlannerAwarenessRunner } from "../../src/execution/planner-awareness-runner.js"

class FakeIntegrator extends BusMember {}
class FakeWorker extends BusMember {}

function harness() {
    const env = new CoordinationBus("planner-awareness")
    const integrator = new FakeIntegrator()
    integrator.join(env)
    const worker = new FakeWorker()
    worker.join(env)
    const runner = new PlannerAwarenessRunner({
        runId: "run-1",
        plannerAgentId: "planner:run-1",
        integrationAuthority: integrator,
    })
    runner.join(env)

    const delivered: Array<{ recipientId: string; text: string }> = []
    const real = env.publish.bind(env)
    env.publish = (source, event) => {
        const data = (event as { payload?: unknown }).payload as {
            recipientId?: string
            text?: string
        }
        if (data?.recipientId) delivered.push(data as never)
        real(source, event)
    }
    return { env, integrator, worker, delivered }
}

describe("PlannerAwarenessRunner", () => {
    it("narrates failures, merges, blocks and verification to the planner", () => {
        const { env, integrator, worker, delivered } = harness()

        env.publish(
            worker,
            StoryResult.create({
                storyId: "S2",
                success: false,
                attempts: 2,
                durationSecs: 10,
                error: "tests failed",
                runId: "run-1",
            }),
        )
        env.publish(
            integrator,
            StoryMerged.create({ storyId: "S1", mode: "worktree", runId: "run-1" }),
        )
        env.publish(
            worker,
            StoryMergeFailed.create({
                storyId: "S3",
                error: "conflicts with already-merged work",
                runId: "run-1",
            }),
        )
        env.publish(
            worker,
            WorkBlocked.create({
                runId: "run-1",
                blockId: "b1",
                storyId: "S4",
                leaseId: "l1",
                generation: 0,
                requiredStoryIds: ["S1"],
                reason: "needs the validation foundation",
            }),
        )
        env.publish(
            worker,
            RunVerificationCompleted.create({
                runId: "run-1",
                verificationId: "v1",
                status: "failed",
                commands: [
                    {
                        command: "npm test",
                        status: "failed",
                        durationMs: 1000,
                        tail: "3 tests failed",
                    },
                ],
                durationMs: 1000,
            }),
        )

        assert.equal(delivered.length, 5)
        for (const message of delivered) {
            assert.equal(message.recipientId, "planner:run-1")
        }
        assert.match(delivered[0]!.text, /S2 FAILED after 2 attempt/)
        assert.match(delivered[1]!.text, /S1 completed and merged/)
        assert.match(delivered[2]!.text, /S3 finished but its merge FAILED/)
        assert.match(delivered[3]!.text, /S4 is blocked on S1/)
        assert.match(delivered[4]!.text, /verification FAILED: npm test: 3 tests failed/)
    })

    it("stays silent on successes, suspensions, foreign runs and unfenced merges", () => {
        const { env, integrator, worker, delivered } = harness()

        env.publish(
            worker,
            StoryResult.create({
                storyId: "S1",
                success: true,
                attempts: 1,
                durationSecs: 5,
                error: null,
                runId: "run-1",
            }),
        )
        env.publish(
            worker,
            StoryResult.create({
                storyId: "S9",
                success: false,
                attempts: 1,
                durationSecs: 5,
                error: "other run",
                runId: "run-OTHER",
            }),
        )
        // An unfenced merge claim must not be believed.
        env.publish(
            worker,
            StoryMerged.create({ storyId: "S1", mode: "worktree", runId: "run-1" }),
        )
        void integrator

        assert.equal(delivered.length, 0)
    })
})
