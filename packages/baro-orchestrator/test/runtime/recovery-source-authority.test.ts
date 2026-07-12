import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    StoryQualityCompleted,
    StoryResult,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../src/semantic-events.js"
import { ActiveLeaseRegistry } from "../../src/runtime/active-lease-registry.js"
import { RecoverySourceAuthority } from "../../src/runtime/recovery-source-authority.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { source } from "../participants/helpers.js"

describe("RecoverySourceAuthority", () => {
    it("source-binds leases, terminal results, and quality triggers", () => {
        const runId = "run-recovery-sources"
        const broker = source("broker")
        const gate = source("acceptance-gate")
        const factory = source("factory")
        const worker = source("S1")
        const attacker = source("observer")
        const outcome = new StoryOutcomeAuthority(runId)
        outcome.registerSpawnAuthority(
            { runId, storyId: "S1", leaseId: "lease-S1" },
            factory,
        )
        outcome.registerResultAuthority(
            {
                runId,
                storyId: "S1",
                leaseId: "lease-S1",
                generation: 1,
            },
            worker,
        )

        const policy = new RecoverySourceAuthority(outcome)
        policy.setLeaseAuthority(broker)
        policy.setQualityAuthority(gate)
        const leases = new ActiveLeaseRegistry()
        const grant = WorkLeaseGranted.create({
            runId,
            offerId: "offer-S1",
            leaseId: "lease-S1",
            workerId: "worker",
            generation: 1,
            request: {
                storyId: "S1",
                prompt: "implement",
                model: "standard",
                retries: 0,
                timeoutSecs: 60,
            },
        })
        const result = StoryResult.create({
            storyId: "S1",
            success: false,
            attempts: 1,
            durationSecs: 1,
            error: "failed",
            runId,
            leaseId: "lease-S1",
            generation: 1,
        })

        assert.equal(policy.observeLease(attacker, grant, leases, runId), true)
        assert.equal(leases.matches(result.data, runId), false)
        assert.equal(policy.observeLease(broker, grant, leases, runId), true)
        assert.equal(leases.matches(result.data, runId), true)

        const release = WorkLeaseReleased.create({
            runId,
            storyId: "S1",
            leaseId: "lease-S1",
            workerId: "worker",
            reason: "integrated",
        })
        assert.equal(policy.observeLease(attacker, release, leases, runId), true)
        assert.equal(leases.matches(result.data, runId), true)

        assert.equal(policy.accepts(attacker, result), false)
        assert.equal(policy.accepts(worker, result), true)

        const quality = StoryQualityCompleted.create({
            runId,
            evaluationId: "quality-S1",
            storyId: "S1",
            leaseId: "lease-S1",
            generation: 1,
            status: "failed",
            targetTurn: 1,
            reason: "acceptance failed",
        })
        assert.equal(policy.accepts(attacker, quality), false)
        assert.equal(policy.accepts(gate, quality), true)

        assert.equal(policy.observeLease(broker, release, leases, runId), true)
        assert.equal(leases.matches(result.data, runId), false)
    })

    it("does not allow authorities to be rebound", () => {
        const policy = new RecoverySourceAuthority()
        const broker = source("broker")
        const gate = source("gate")
        policy.setLeaseAuthority(broker)
        policy.setLeaseAuthority(broker)
        policy.setQualityAuthority(gate)
        policy.setQualityAuthority(gate)

        assert.throws(
            () => policy.setLeaseAuthority(source("other-broker")),
            /already bound/,
        )
        assert.throws(
            () => policy.setQualityAuthority(source("other-gate")),
            /already bound/,
        )
    })
})
