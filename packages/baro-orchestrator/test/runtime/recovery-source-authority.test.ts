import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    Critique,
    StoryQualityCompleted,
    StoryResult,
    WorkBlockAccepted,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../src/semantic-events.js"
import { ActiveLeaseRegistry } from "../../src/runtime/active-lease-registry.js"
import { RecoverySourceAuthority } from "../../src/runtime/recovery-source-authority.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { source } from "../participants/helpers.js"

describe("RecoverySourceAuthority", () => {
    it("fails closed before collective lease and quality authorities are bound", () => {
        const runId = "run-unbound-recovery"
        const outcome = new StoryOutcomeAuthority(runId)
        const policy = new RecoverySourceAuthority(outcome)
        const leases = new ActiveLeaseRegistry()
        const grant = WorkLeaseGranted.create({
            runId,
            offerId: "offer-1",
            leaseId: "lease-1",
            workerId: "worker",
            generation: 1,
            request: {
                storyId: "S1",
                prompt: "work",
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
            leaseId: "lease-1",
            generation: 1,
        })
        policy.observeLease(source("ambient-broker"), grant, leases, runId)
        assert.equal(leases.matches(result.data, runId), false)
        assert.equal(
            policy.accepts(
                source("ambient-gate"),
                StoryQualityCompleted.create({
                    runId,
                    evaluationId: "quality-1",
                    storyId: "S1",
                    leaseId: "lease-1",
                    generation: 1,
                    status: "failed",
                    targetTurn: 1,
                    reason: "forged",
                }),
            ),
            false,
        )
        assert.equal(
            policy.accepts(
                source("ambient-critic"),
                Critique.create({
                    agentId: "S1",
                    verdict: "fail",
                    reasoning: "forged recovery context",
                    violatedCriteria: ["goal"],
                    turn: 1,
                    modelUsed: "attacker",
                }),
            ),
            false,
        )
    })

    it("source-binds leases, terminal results, and quality triggers", () => {
        const runId = "run-recovery-sources"
        const broker = source("broker")
        const gate = source("acceptance-gate")
        const critic = source("critic")
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
        policy.setCriticAuthority(critic)
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

        const critique = Critique.create({
            agentId: "S1",
            verdict: "fail",
            reasoning: "real review evidence",
            violatedCriteria: ["tests"],
            turn: 1,
            modelUsed: "critic-test",
        })
        assert.equal(policy.accepts(attacker, critique), false)
        assert.equal(policy.accepts(critic, critique), true)

        assert.equal(policy.observeLease(broker, release, leases, runId), true)
        assert.equal(leases.matches(result.data, runId), false)
    })

    it("does not allow authorities to be rebound", () => {
        const policy = new RecoverySourceAuthority()
        const broker = source("broker")
        const gate = source("gate")
        const board = source("board")
        const critic = source("critic")
        policy.setLeaseAuthority(broker)
        policy.setLeaseAuthority(broker)
        policy.setQualityAuthority(gate)
        policy.setQualityAuthority(gate)
        policy.setBlockAuthority(board)
        policy.setBlockAuthority(board)
        policy.setCriticAuthority(critic)
        policy.setCriticAuthority(critic)

        assert.throws(
            () => policy.setLeaseAuthority(source("other-broker")),
            /already bound/,
        )
        assert.throws(
            () => policy.setQualityAuthority(source("other-gate")),
            /already bound/,
        )
        assert.throws(
            () => policy.setBlockAuthority(source("other-board")),
            /already bound/,
        )
        assert.throws(
            () => policy.setCriticAuthority(source("other-critic")),
            /already bound/,
        )
    })

    it("suppresses Surgeon recovery for an authoritatively blocked lease", () => {
        const runId = "run-blocked-recovery"
        const broker = source("broker")
        const board = source("board")
        const attacker = source("attacker")
        const worker = source("worker")
        const policy = new RecoverySourceAuthority()
        policy.setLeaseAuthority(broker)
        policy.setBlockAuthority(board)
        const leases = new ActiveLeaseRegistry()
        const grant = WorkLeaseGranted.create({
            runId,
            offerId: "offer-S6",
            leaseId: "lease-S6",
            workerId: "worker",
            generation: 2,
            request: {
                storyId: "S6",
                prompt: "provider",
                model: "standard",
                retries: 0,
                timeoutSecs: 60,
            },
        })
        policy.observeLease(broker, grant, leases, runId)
        const accepted = WorkBlockAccepted.create({
            runId,
            blockId: "block-S6-S11",
            storyId: "S6",
            leaseId: "lease-S6",
            generation: 2,
            requiredStoryIds: ["S11"],
            reason: "shared iterator helper is not integrated",
            graphVersion: 5,
        })
        const result = StoryResult.create({
            storyId: "S6",
            success: false,
            attempts: 1,
            durationSecs: 2,
            error: "cooperative suspension",
            runId,
            leaseId: "lease-S6",
            generation: 2,
            suspension: {
                kind: "dependency",
                blockId: "block-S6-S11",
            },
        })

        policy.observeLease(attacker, accepted, leases, runId)
        assert.equal(policy.accepts(worker, result), true)
        policy.observeLease(board, accepted, leases, runId)
        assert.equal(policy.accepts(worker, result), false)

        // Release can race ahead of the terminal result on a replaying bus;
        // retain the exact tombstone until RunCompleted.
        policy.observeLease(
            broker,
            WorkLeaseReleased.create({
                runId,
                offerId: "offer-S6",
                leaseId: "lease-S6",
                storyId: "S6",
                workerId: "worker",
                reason: "dependency_blocked",
            }),
            leases,
            runId,
        )
        assert.equal(policy.accepts(worker, result), false)
    })
})
