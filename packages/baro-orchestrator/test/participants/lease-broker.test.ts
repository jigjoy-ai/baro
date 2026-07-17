import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { LeaseBroker } from "../../src/participants/lease-broker.js"
import {
    RunCompleted,
    StoryResult,
    StoryMergeFailed,
    StoryQualityCompleted,
    StoryMerged,
    WorkBlockAccepted,
    WorkBid,
    WorkBidWindowClosed,
    WorkClaimed,
    WorkLeaseExpired,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkOfferExpired,
    WorkOffered,
    WorkSuspended,
    WorkerCapabilityAdvertised,
    type StoryFailureData,
    type WorkRouteDescriptor,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("LeaseBroker", () => {
    it("holds the parallel cap until the integrated event releases a lease", async () => {
        const broker = new LeaseBroker({
            runId: "run-broker",
            parallel: 1,
            intraLevelDelaySecs: 0,
            claimTimeoutMs: 1_000,
        })
        const env = joinWithCapture(broker)

        for (const storyId of ["S1", "S2"]) {
            const offerId = `offer-${storyId}`
            env.deliverSemanticEvent(
                source("board"),
                WorkOffered.create({
                    runId: "run-broker",
                    offerId,
                    generation: 1,
                    priority: 1,
                    request: {
                        storyId,
                        prompt: storyId,
                        model: "standard",
                        retries: 1,
                        timeoutSecs: 60,
                    },
                }),
            )
            env.deliverSemanticEvent(
                source("worker"),
                WorkClaimed.create({
                    runId: "run-broker",
                    offerId,
                    storyId,
                    workerId: "worker",
                    backend: "claude",
                    model: "sonnet",
                }),
            )
        }

        await flush()
        let leases = env.events.filter(WorkLeaseGranted.is)
        assert.equal(leases.length, 1)
        assert.equal(leases[0]?.data.request.storyId, "S1")

        env.deliverSemanticEvent(
            source("repo"),
            StoryMerged.create({
                storyId: "S1",
                mode: "worktree",
                runId: "run-broker",
                leaseId: leases[0]!.data.leaseId,
            }),
        )
        for (let attempt = 0; attempt < 20; attempt += 1) {
            leases = env.events.filter(WorkLeaseGranted.is)
            if (leases.length === 2) break
            await flush()
        }
        assert.equal(leases.length, 2)
        assert.equal(leases[1]?.data.request.storyId, "S2")
    })

    it("expires a worker lease that never produces a terminal event", async () => {
        const broker = new LeaseBroker({
            runId: "run-expiry",
            parallel: 1,
            intraLevelDelaySecs: 0,
            claimTimeoutMs: 1_000,
            leaseTimeoutMs: 5,
        })
        const env = joinWithCapture(broker)
        env.deliverSemanticEvent(
            source("board"),
            WorkOffered.create({
                runId: "run-expiry",
                offerId: "offer-S1",
                generation: 1,
                priority: 1,
                request: {
                    storyId: "S1",
                    prompt: "S1",
                    model: "standard",
                    retries: 0,
                    timeoutSecs: 60,
                },
            }),
        )
        env.deliverSemanticEvent(
            source("worker"),
            WorkClaimed.create({
                runId: "run-expiry",
                offerId: "offer-S1",
                storyId: "S1",
                workerId: "worker",
                backend: "claude",
                model: "sonnet",
            }),
        )

        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (env.events.some(WorkLeaseReleased.is)) break
            await new Promise((resolve) => setTimeout(resolve, 2))
        }

        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 1)
        const released = env.events.find(WorkLeaseReleased.is)
        assert.equal(released?.data.reason, "expired")
    })

    it("keeps the legacy integration timeout after a successful result", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] })
        const runId = "run-legacy-integration-timeout"
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
            leaseTimeoutMs: 50,
            integrationTimeoutMs: 10,
        })
        const env = joinWithCapture(broker)

        offerAndClaim(env, source("board"), runId, "S1")
        await flush()
        const lease = env.events.find(WorkLeaseGranted.is)!
        env.deliverSemanticEvent(
            source("S1-agent"),
            successfulResult(runId, lease.data),
        )
        await flush()

        t.mock.timers.tick(9)
        await flush()
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)
        t.mock.timers.tick(1)
        await flush()
        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 1)
        assert.equal(
            env.events.find(WorkLeaseReleased.is)?.data.reason,
            "expired",
        )
    })

    it("does not make an unreviewed story wait merely because a quality authority is globally bound", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] })
        const runId = "run-unreviewed-with-gate"
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
            leaseTimeoutMs: 50,
            integrationTimeoutMs: 10,
        })
        broker.setQualityAuthority(source("quality-gate"))
        const env = joinWithCapture(broker)

        offerAndClaim(env, source("board"), runId, "S1")
        await flush()
        const lease = env.events.find(WorkLeaseGranted.is)!
        env.deliverSemanticEvent(
            source("S1-agent"),
            successfulResult(runId, lease.data),
        )
        await flush()

        t.mock.timers.tick(10)
        await flush()
        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 1)
        assert.equal(
            env.events.find(WorkLeaseReleased.is)?.data.reason,
            "expired",
        )
    })

    it("releases a failed quality lease only from its bound gate", async () => {
        const broker = new LeaseBroker({
            runId: "run-quality",
            parallel: 1,
            intraLevelDelaySecs: 0,
        })
        const qualityGate = source("quality-gate")
        broker.setQualityAuthority(qualityGate)
        const env = joinWithCapture(broker)
        env.deliverSemanticEvent(
            source("board"),
            WorkOffered.create(
                qualityOffer("run-quality", "offer-S1", "S1", 1),
            ),
        )
        env.deliverSemanticEvent(
            source("worker"),
            WorkClaimed.create({
                runId: "run-quality",
                offerId: "offer-S1",
                storyId: "S1",
                workerId: "worker",
                backend: "claude",
                model: "sonnet",
            }),
        )
        await waitFor(() => env.events.some(WorkLeaseGranted.is))
        const lease = env.events.find(WorkLeaseGranted.is)!
        const failed = StoryQualityCompleted.create({
            runId: "run-quality",
            evaluationId: "quality-S1",
            storyId: "S1",
            leaseId: lease.data.leaseId,
            generation: lease.data.generation,
            status: "failed",
            targetTurn: 1,
            reason: "acceptance failed",
        })

        env.deliverSemanticEvent(source("forged-gate"), failed)
        await flush()
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)

        env.deliverSemanticEvent(qualityGate, failed)
        await waitFor(() => env.events.some(WorkLeaseReleased.is))
        assert.equal(
            env.events.find(WorkLeaseReleased.is)?.data.reason,
            "quality_failed",
        )
    })

    it("releases an inconclusive quality lease as quality_inconclusive", async () => {
        const runId = "run-quality-inconclusive"
        const qualityGate = source("quality-gate")
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
        })
        broker.setQualityAuthority(qualityGate)
        const env = joinWithCapture(broker)

        offerAndClaim(env, source("board"), runId, "S1", true)
        await waitFor(() => env.events.some(WorkLeaseGranted.is))
        const lease = env.events.find(WorkLeaseGranted.is)!

        env.deliverSemanticEvent(
            qualityGate,
            StoryQualityCompleted.create({
                runId,
                evaluationId: "quality-S1",
                storyId: "S1",
                leaseId: lease.data.leaseId,
                generation: lease.data.generation,
                status: "inconclusive",
                targetTurn: 1,
                reason: "evaluator transport failed",
            }),
        )

        await waitFor(() => env.events.some(WorkLeaseReleased.is))
        assert.equal(
            env.events.find(WorkLeaseReleased.is)?.data.reason,
            "quality_inconclusive",
        )
    })

    it("keeps a successful lease alive through Gate rechecks and starts integration timeout only after exact pass", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] })
        const runId = "run-quality-wait-timeout"
        const qualityGate = source("quality-gate")
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
            leaseTimeoutMs: 10,
            integrationTimeoutMs: 10,
        })
        broker.setQualityAuthority(qualityGate)
        const env = joinWithCapture(broker)

        offerAndClaim(env, source("board"), runId, "S1", true)
        await flush()
        const lease = env.events.find(WorkLeaseGranted.is)!
        assert.ok(lease)
        const result = successfulResult(runId, lease.data)
        env.deliverSemanticEvent(source("S1-agent"), result)
        await flush()

        // Both the old execution deadline and the configured integration
        // deadline may pass while the Gate performs bounded same-candidate
        // rechecks. Neither owns the Gate's quality wait.
        t.mock.timers.tick(30)
        await flush()
        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 0)
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)

        const pass = passedQuality(runId, lease.data)
        env.deliverSemanticEvent(source("forged-gate"), pass)
        env.deliverSemanticEvent(
            qualityGate,
            StoryQualityCompleted.create({
                ...pass.data,
                generation: pass.data.generation + 1,
            }),
        )
        await flush()
        t.mock.timers.tick(30)
        await flush()
        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 0)
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)

        env.deliverSemanticEvent(qualityGate, pass)
        await flush()
        t.mock.timers.tick(9)
        await flush()
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)
        t.mock.timers.tick(1)
        await flush()
        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 1)
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 1)
        assert.equal(
            env.events.find(WorkLeaseReleased.is)?.data.reason,
            "expired",
        )

        // A late/replayed Gate pass cannot resurrect an expired correlation.
        env.deliverSemanticEvent(qualityGate, pass)
        t.mock.timers.tick(30)
        await flush()
        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 1)
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 1)
    })

    it("preserves the integration timer when an early quality pass precedes StoryResult", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] })
        const runId = "run-quality-pass-first"
        const qualityGate = source("quality-gate")
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
            leaseTimeoutMs: 10,
            integrationTimeoutMs: 10,
        })
        broker.setQualityAuthority(qualityGate)
        const env = joinWithCapture(broker)

        offerAndClaim(env, source("board"), runId, "S1", true)
        await flush()
        const lease = env.events.find(WorkLeaseGranted.is)!
        assert.ok(lease)
        const pass = passedQuality(runId, lease.data)
        const result = successfulResult(runId, lease.data)

        env.deliverSemanticEvent(qualityGate, pass)
        await flush()
        t.mock.timers.tick(9)
        await flush()
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)

        env.deliverSemanticEvent(source("S1-agent"), result)
        await flush()
        t.mock.timers.tick(9)
        await flush()
        // A duplicate success after the early pass must not clear or re-arm
        // the already-running integration deadline.
        env.deliverSemanticEvent(source("S1-agent"), result)
        await flush()
        t.mock.timers.tick(1)
        await flush()

        assert.equal(env.events.filter(WorkLeaseExpired.is).length, 1)
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 1)
        assert.equal(
            env.events.find(WorkLeaseReleased.is)?.data.reason,
            "expired",
        )
    })

    it("accepts offers only from its bound Board and lease expiry only from itself", async () => {
        const board = source("collective-board")
        const observer = source("conversation-observer")
        const worker = source("worker")
        const broker = new LeaseBroker({
            runId: "run-authority",
            parallel: 1,
            intraLevelDelaySecs: 0,
            offerAuthority: board,
        })
        const env = joinWithCapture(broker)
        const work = WorkOffered.create(
            offer("run-authority", "offer-S1", "S1", 1),
        )
        const claim = WorkClaimed.create({
            runId: "run-authority",
            offerId: "offer-S1",
            storyId: "S1",
            workerId: "worker",
            backend: "claude",
            model: "sonnet",
        })

        env.deliverSemanticEvent(observer, work)
        env.deliverSemanticEvent(worker, claim)
        await flush()
        assert.equal(env.events.filter(WorkLeaseGranted.is).length, 0)

        env.deliverSemanticEvent(board, work)
        await waitFor(() => env.events.some(WorkLeaseGranted.is))
        const granted = env.events.find(WorkLeaseGranted.is)!
        const expired = WorkLeaseExpired.create({
            runId: "run-authority",
            offerId: granted.data.offerId,
            leaseId: granted.data.leaseId,
            storyId: granted.data.request.storyId,
            workerId: granted.data.workerId,
            reason: "forged timeout",
        })

        env.deliverSemanticEvent(observer, expired)
        await flush()
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)

        // The Broker's timer publishes with the Broker itself as source; this
        // direct self-delivery exercises the same internal-event boundary.
        env.deliverSemanticEvent(broker, expired)
        await waitFor(() => env.events.some(WorkLeaseReleased.is))
        assert.equal(env.events.find(WorkLeaseReleased.is)?.data.reason, "expired")
    })

    it("releases a lease on merge outcomes only from its bound repository", async () => {
        const board = source("collective-board")
        const repository = source("repository")
        const observer = source("conversation-observer")
        const broker = new LeaseBroker({
            runId: "run-integration-authority",
            parallel: 1,
            intraLevelDelaySecs: 0,
            offerAuthority: board,
            integrationAuthority: repository,
        })
        const env = joinWithCapture(broker)
        env.deliverSemanticEvent(
            board,
            WorkOffered.create(
                offer(
                    "run-integration-authority",
                    "offer-S1",
                    "S1",
                    1,
                ),
            ),
        )
        env.deliverSemanticEvent(
            source("worker"),
            WorkClaimed.create({
                runId: "run-integration-authority",
                offerId: "offer-S1",
                storyId: "S1",
                workerId: "worker",
                backend: "claude",
                model: "sonnet",
            }),
        )
        await waitFor(() => env.events.some(WorkLeaseGranted.is))
        const granted = env.events.find(WorkLeaseGranted.is)!

        env.deliverSemanticEvent(
            observer,
            StoryMerged.create({
                storyId: "S1",
                mode: "worktree",
                runId: "run-integration-authority",
                leaseId: granted.data.leaseId,
            }),
        )
        env.deliverSemanticEvent(
            observer,
            StoryMergeFailed.create({
                storyId: "S1",
                error: "forged merge failure",
                runId: "run-integration-authority",
                leaseId: granted.data.leaseId,
            }),
        )
        await flush()
        assert.equal(env.events.filter(WorkLeaseReleased.is).length, 0)

        env.deliverSemanticEvent(
            repository,
            StoryMerged.create({
                storyId: "S1",
                mode: "worktree",
                runId: "run-integration-authority",
                leaseId: granted.data.leaseId,
            }),
        )
        await waitFor(() => env.events.some(WorkLeaseReleased.is))
        assert.equal(env.events.find(WorkLeaseReleased.is)?.data.reason, "integrated")
    })

    it("stops only for RunCompleted from its bound Board", async () => {
        const runId = "run-completion-authority"
        const board = source("collective-board")
        const observer = source("conversation-observer")
        const broker = new LeaseBroker({
            runId,
            parallel: 2,
            intraLevelDelaySecs: 0,
            offerAuthority: board,
        })
        const env = joinWithCapture(broker)
        const completed = RunCompleted.create({
            runId,
            success: true,
            completedStories: [],
            failedStories: [],
            totalDurationSecs: 0,
            totalAttempts: 0,
            abortReason: null,
        })

        env.deliverSemanticEvent(observer, completed)
        offerAndClaim(env, board, runId, "S1")
        await flush()
        assert.equal(env.events.filter(WorkLeaseGranted.is).length, 1)

        env.deliverSemanticEvent(board, completed)
        offerAndClaim(env, board, runId, "S2")
        await flush()
        assert.equal(env.events.filter(WorkLeaseGranted.is).length, 1)
    })

    it("waits for the bounded market window and selects the best verified cost", async () => {
        const broker = new LeaseBroker({
            runId: "run-market",
            parallel: 1,
            intraLevelDelaySecs: 0,
            market: { bidWindowMs: 10 },
        })
        const env = joinWithCapture(broker)
        const expensiveWorker = source("expensive-worker")
        const cheapWorker = source("cheap-worker")
        const expensiveRoute = route("expensive", "claude", "opus")
        const cheapRoute = route("cheap", "openai", "deepseek-chat")

        advertise(env, expensiveWorker, "run-market", "expensive-worker", expensiveRoute)
        advertise(env, cheapWorker, "run-market", "cheap-worker", cheapRoute)
        env.deliverSemanticEvent(
            source("board"),
            WorkOffered.create(offer("run-market", "offer-S1", "S1", 1)),
        )
        submitBid(env, expensiveWorker, {
            runId: "run-market",
            offerId: "offer-S1",
            storyId: "S1",
            generation: 1,
            bidId: "bid-expensive",
            workerId: "expensive-worker",
            route: expensiveRoute,
            cost: 2,
            success: 0.95,
            latencyMs: 20,
        })
        submitBid(env, cheapWorker, {
            runId: "run-market",
            offerId: "offer-S1",
            storyId: "S1",
            generation: 1,
            bidId: "bid-cheap",
            workerId: "cheap-worker",
            route: cheapRoute,
            cost: 0.2,
            success: 0.8,
            latencyMs: 40,
        })

        await waitFor(() => env.events.some(WorkLeaseGranted.is))

        assert.equal(env.events.filter(WorkBidWindowClosed.is).length, 1)
        const selected = env.events.filter(WorkClaimed.is).at(-1)
        assert.equal(selected?.data.bidId, "bid-cheap")
        const lease = env.events.find(WorkLeaseGranted.is)
        assert.equal(lease?.data.workerId, "cheap-worker")
        assert.equal(lease?.data.bidId, "bid-cheap")
        assert.deepEqual(lease?.data.route, cheapRoute)
    })

    it("ignores direct claim bypasses and bids that mismatch advertised routes", async () => {
        const broker = new LeaseBroker({
            runId: "run-guarded",
            parallel: 1,
            intraLevelDelaySecs: 0,
            market: { bidWindowMs: 10 },
        })
        const env = joinWithCapture(broker)
        const worker = source("registered-source")
        const advertisedRoute = route("safe", "openai", "glm-5")
        advertise(env, worker, "run-guarded", "registered-worker", advertisedRoute)
        env.deliverSemanticEvent(
            source("board"),
            WorkOffered.create(offer("run-guarded", "offer-S2", "S2", 2)),
        )

        env.deliverSemanticEvent(
            source("bypass"),
            WorkClaimed.create({
                runId: "run-guarded",
                offerId: "offer-S2",
                storyId: "S2",
                workerId: "bypass",
                backend: "claude",
                model: "opus",
            }),
        )
        submitBid(env, worker, {
            runId: "run-guarded",
            offerId: "offer-S2",
            storyId: "S2",
            generation: 2,
            bidId: "bid-mismatched",
            workerId: "registered-worker",
            route: route("unadvertised", "openai", "deepseek-chat"),
            cost: 0.001,
            success: 1,
            latencyMs: 1,
        })
        submitBid(env, worker, {
            runId: "run-guarded",
            offerId: "offer-S2",
            storyId: "S2",
            generation: 2,
            bidId: "bid-valid",
            workerId: "registered-worker",
            route: advertisedRoute,
            cost: 0.5,
            success: 0.9,
            latencyMs: 50,
        })

        await waitFor(() => env.events.some(WorkLeaseGranted.is))

        const leases = env.events.filter(WorkLeaseGranted.is)
        assert.equal(leases.length, 1)
        assert.equal(leases[0]?.data.workerId, "registered-worker")
        assert.equal(leases[0]?.data.bidId, "bid-valid")
        assert.deepEqual(leases[0]?.data.route, advertisedRoute)
    })

    it("deduplicates early bids and ignores stale or late correlation", async () => {
        const broker = new LeaseBroker({
            runId: "run-replay",
            parallel: 1,
            intraLevelDelaySecs: 0,
            market: { bidWindowMs: 10 },
        })
        const env = joinWithCapture(broker)
        const earlyWorker = source("early-source")
        const otherWorker = source("other-source")
        const earlyRoute = route("early", "openai", "deepseek-chat")
        const otherRoute = route("other", "openai", "glm-5")
        advertise(env, earlyWorker, "run-replay", "early-worker", earlyRoute)
        advertise(env, otherWorker, "run-replay", "other-worker", otherRoute)

        const early = {
            runId: "run-replay",
            offerId: "offer-S3",
            storyId: "S3",
            generation: 3,
            bidId: "bid-replayed",
            workerId: "early-worker",
            route: earlyRoute,
            cost: 1,
            success: 1,
            latencyMs: 20,
        }
        submitBid(env, earlyWorker, early)
        // Same identity cannot overwrite its first immutable snapshot.
        submitBid(env, earlyWorker, { ...early, cost: 0.001 })

        env.deliverSemanticEvent(
            source("board"),
            WorkOffered.create(offer("run-replay", "offer-S3", "S3", 3)),
        )
        submitBid(env, otherWorker, {
            runId: "run-replay",
            offerId: "offer-S3",
            storyId: "S3",
            generation: 3,
            bidId: "bid-other",
            workerId: "other-worker",
            route: otherRoute,
            cost: 0.5,
            success: 1,
            latencyMs: 30,
        })
        submitBid(env, earlyWorker, {
            ...early,
            generation: 2,
            bidId: "bid-stale-generation",
            cost: 0,
        })

        await waitFor(() => env.events.some(WorkLeaseGranted.is))
        assert.equal(env.events.find(WorkLeaseGranted.is)?.data.bidId, "bid-other")

        submitBid(env, earlyWorker, {
            ...early,
            bidId: "bid-after-close",
            cost: 0,
        })
        await flush()
        await flush()
        assert.equal(env.events.filter(WorkLeaseGranted.is).length, 1)
    })

    it("never grants a pending route after an authoritative capacity failure", async () => {
        const runId = "run-capacity-pending"
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
            market: { bidWindowMs: 5 },
        })
        const env = joinWithCapture(broker)
        const cheapWorker = source("cheap-source")
        const alternateWorker = source("alternate-source")
        const cheapRoute = route("route-cheap", "openai", "deepseek")
        const alternateRoute = route("route-alternate", "openai", "glm")
        advertise(env, cheapWorker, runId, "cheap-worker", cheapRoute)
        advertise(env, alternateWorker, runId, "alternate-worker", alternateRoute)

        const bidBoth = (storyId: string, generation: number): void => {
            const offerId = `offer-${storyId}`
            env.deliverSemanticEvent(
                source("board"),
                WorkOffered.create(offer(runId, offerId, storyId, generation)),
            )
            submitBid(env, cheapWorker, {
                runId,
                offerId,
                storyId,
                generation,
                bidId: `bid-cheap-${storyId}`,
                workerId: "cheap-worker",
                route: cheapRoute,
                cost: 0.1,
                success: 0.9,
                latencyMs: 10,
            })
            submitBid(env, alternateWorker, {
                runId,
                offerId,
                storyId,
                generation,
                bidId: `bid-alternate-${storyId}`,
                workerId: "alternate-worker",
                route: alternateRoute,
                cost: 0.3,
                success: 0.9,
                latencyMs: 20,
            })
        }

        bidBoth("S1", 1)
        await waitFor(() => env.events.filter(WorkLeaseGranted.is).length === 1)
        const first = env.events.find(WorkLeaseGranted.is)!
        assert.equal(first.data.workerId, "cheap-worker")

        bidBoth("S2", 1)
        await waitFor(() =>
            env.events.some(
                (event) =>
                    WorkClaimed.is(event) &&
                    event.data.storyId === "S2" &&
                    event.data.workerId === "cheap-worker",
            ),
        )
        assert.equal(env.events.filter(WorkLeaseGranted.is).length, 1)

        env.deliverSemanticEvent(
            source("S1-agent"),
            StoryResult.create({
                storyId: "S1",
                success: false,
                attempts: 1,
                durationSecs: 1,
                error: "provider quota exhausted",
                failure: {
                    kind: "provider_capacity",
                    code: "quota_exhausted",
                },
                runId,
                leaseId: first.data.leaseId,
                generation: first.data.generation,
            }),
        )

        await waitFor(() => env.events.filter(WorkLeaseGranted.is).length === 2)
        const second = env.events.filter(WorkLeaseGranted.is)[1]!
        assert.equal(second.data.request.storyId, "S2")
        assert.equal(second.data.workerId, "alternate-worker")
        assert.equal(second.data.route?.routeId, "route-alternate")
        assert.equal(
            env.events
                .filter(WorkClaimed.is)
                .filter((event) => event.data.storyId === "S2")
                .at(-1)?.data.workerId,
            "alternate-worker",
        )
    })

    it("releases transport and infrastructure failures operationally without suppressing their route", async () => {
        const failures: StoryFailureData[] = [
            { kind: "transport", code: "connection_reset" },
            { kind: "infrastructure", code: "review_timeout" },
        ]

        for (const failure of failures) {
            await assertOperationalFailureKeepsRouteAvailable(failure)
        }
    })

    it("keeps a transient rate-limited route available for a later story", async () => {
        await assertOperationalFailureKeepsRouteAvailable({
            kind: "provider_capacity",
            code: "rate_limited",
            retryAfterMs: 25,
        })
    })

    it("suppresses a capacity-exhausted non-market worker for later stories", async () => {
        const runId = "run-capacity-non-market"
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
            claimTimeoutMs: 50,
        })
        const env = joinWithCapture(broker)

        offerAndClaim(env, source("board"), runId, "S1")
        await waitFor(() => env.events.some(WorkLeaseGranted.is))
        const first = env.events.find(WorkLeaseGranted.is)!

        env.deliverSemanticEvent(
            source("S1-agent"),
            StoryResult.create({
                storyId: "S1",
                success: false,
                attempts: 1,
                durationSecs: 1,
                error: "provider session limit reached",
                failure: {
                    kind: "provider_capacity",
                    code: "session_limit",
                },
                runId,
                leaseId: first.data.leaseId,
                generation: first.data.generation,
            }),
        )
        await waitFor(() => env.events.some(WorkLeaseReleased.is))

        offerAndClaim(env, source("board"), runId, "S2")
        await waitFor(() =>
            env.events.some(
                (event) =>
                    WorkOfferExpired.is(event) && event.data.storyId === "S2",
            ),
        )

        assert.equal(env.events.filter(WorkLeaseGranted.is).length, 1)
        assert.match(
            env.events
                .filter(WorkOfferExpired.is)
                .find((event) => event.data.storyId === "S2")!.data.reason,
            /unavailable for this run/,
        )
    })

    it("honours offer exclusions and market policy instead of forcing a fallback", async () => {
        const runId = "run-capacity-policy"
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
            market: {
                bidWindowMs: 5,
                policy: { maxCostUsd: 0.2 },
            },
        })
        const env = joinWithCapture(broker)
        const cheapWorker = source("excluded-source")
        const expensiveWorker = source("policy-source")
        const cheapRoute = route("excluded", "openai", "deepseek")
        const expensiveRoute = route("too-expensive", "openai", "glm")
        advertise(env, cheapWorker, runId, "excluded-worker", cheapRoute)
        advertise(env, expensiveWorker, runId, "policy-worker", expensiveRoute)

        const offered = offer(runId, "offer-S1", "S1", 1)
        env.deliverSemanticEvent(
            source("board"),
            WorkOffered.create({ ...offered, excludedRouteIds: [cheapRoute.routeId] }),
        )
        submitBid(env, cheapWorker, {
            runId,
            offerId: "offer-S1",
            storyId: "S1",
            generation: 1,
            bidId: "bid-excluded",
            workerId: "excluded-worker",
            route: cheapRoute,
            cost: 0.1,
            success: 0.9,
            latencyMs: 10,
        })
        submitBid(env, expensiveWorker, {
            runId,
            offerId: "offer-S1",
            storyId: "S1",
            generation: 1,
            bidId: "bid-policy-rejected",
            workerId: "policy-worker",
            route: expensiveRoute,
            cost: 0.3,
            success: 0.9,
            latencyMs: 20,
        })

        await waitFor(() => env.events.some(WorkOfferExpired.is))
        assert.equal(env.events.filter(WorkLeaseGranted.is).length, 0)
    })

    it("waits for terminal process quiescence before releasing a blocked lease", async () => {
        const runId = "run-dependency-block"
        const board = source("board")
        const worker = source("worker")
        const broker = new LeaseBroker({
            runId,
            parallel: 1,
            intraLevelDelaySecs: 0,
        })
        broker.setOfferAuthority(board)
        broker.setBlockAuthority(board)
        const env = joinWithCapture(broker)
        env.deliverSemanticEvent(
            worker,
            WorkerCapabilityAdvertised.create({
                runId,
                workerId: "worker",
                capabilities: {
                    backends: ["codex"],
                    supportsAbort: true,
                    supportsLiveFeedback: true,
                    supportsPeerMessages: true,
                },
            }),
        )
        env.deliverSemanticEvent(
            board,
            WorkOffered.create(offer(runId, "offer-S6", "S6", 1)),
        )
        env.deliverSemanticEvent(
            worker,
            WorkClaimed.create({
                runId,
                offerId: "offer-S6",
                storyId: "S6",
                workerId: "worker",
                backend: "codex",
                model: "gpt-5.6",
                supportsCooperativeSuspend: true,
            }),
        )
        await waitFor(() => env.events.some(WorkLeaseGranted.is))
        const lease = env.events.find(WorkLeaseGranted.is)!
        const accepted = WorkBlockAccepted.create({
            runId,
            blockId: "block-S6-S11",
            storyId: "S6",
            leaseId: lease.data.leaseId,
            generation: lease.data.generation,
            requiredStoryIds: ["S11"],
            reason: "iterateWithAbort must integrate first",
            graphVersion: 2,
        })
        env.deliverSemanticEvent(source("attacker"), accepted)
        env.deliverSemanticEvent(board, accepted)
        await flush()
        assert.equal(env.events.some(WorkLeaseReleased.is), false)

        env.deliverSemanticEvent(
            source("S6-agent"),
            StoryResult.create({
                storyId: "S6",
                success: false,
                attempts: 1,
                durationSecs: 4,
                error: "cooperative dependency suspension",
                runId,
                leaseId: lease.data.leaseId,
                generation: lease.data.generation,
            }),
        )
        await flush()
        assert.equal(env.events.some(WorkLeaseReleased.is), false)

        const suspended = WorkSuspended.create({
            runId,
            blockId: "block-S6-S11",
            storyId: "S6",
            leaseId: lease.data.leaseId,
            generation: lease.data.generation,
            attempts: 1,
            durationSecs: 4,
        })
        env.deliverSemanticEvent(source("attacker"), suspended)
        await flush()
        assert.equal(env.events.some(WorkLeaseReleased.is), false)
        env.deliverSemanticEvent(worker, suspended)
        await waitFor(() => env.events.some(WorkLeaseReleased.is))
        const release = env.events.find(WorkLeaseReleased.is)!
        assert.equal(release.data.reason, "dependency_blocked")
        assert.equal(release.data.attempts, 1)
        assert.equal(release.data.durationSecs, 4)
    })
})

function route(
    routeId: string,
    backend: string,
    model: string,
): WorkRouteDescriptor {
    return { routeId, backend, model }
}

function offer(runId: string, offerId: string, storyId: string, generation: number) {
    return {
        runId,
        offerId,
        generation,
        priority: 1,
        request: {
            storyId,
            prompt: storyId,
            model: "standard",
            retries: 1,
            timeoutSecs: 60,
        },
    }
}

function qualityOffer(
    runId: string,
    offerId: string,
    storyId: string,
    generation: number,
) {
    const item = offer(runId, offerId, storyId, generation)
    return {
        ...item,
        request: {
            ...item.request,
            requiresQualityReview: true,
        },
    }
}

function advertise(
    env: ReturnType<typeof joinWithCapture>,
    worker: ReturnType<typeof source>,
    runId: string,
    workerId: string,
    advertisedRoute: WorkRouteDescriptor,
): void {
    env.deliverSemanticEvent(
        worker,
        WorkerCapabilityAdvertised.create({
            runId,
            workerId,
            capabilities: {
                backends: [advertisedRoute.backend],
                supportsAbort: true,
                supportsLiveFeedback: true,
                supportsPeerMessages: true,
                routes: [advertisedRoute],
            },
        }),
    )
}

function submitBid(
    env: ReturnType<typeof joinWithCapture>,
    worker: ReturnType<typeof source>,
    item: {
        runId: string
        offerId: string
        storyId: string
        generation: number
        bidId: string
        workerId: string
        route: WorkRouteDescriptor
        cost: number
        success: number
        latencyMs: number
    },
): void {
    env.deliverSemanticEvent(
        worker,
        WorkBid.create({
            runId: item.runId,
            offerId: item.offerId,
            storyId: item.storyId,
            generation: item.generation,
            bidId: item.bidId,
            workerId: item.workerId,
            route: item.route,
            estimate: {
                expectedCostUsd: item.cost,
                estimatedSuccessProbability: item.success,
                estimatedLatencyMs: item.latencyMs,
                estimateSource: "configured",
            },
        }),
    )
}

function offerAndClaim(
    env: ReturnType<typeof joinWithCapture>,
    board: ReturnType<typeof source>,
    runId: string,
    storyId: string,
    requiresQualityReview = false,
): void {
    const offerId = `offer-${storyId}`
    env.deliverSemanticEvent(
        board,
        WorkOffered.create(
            requiresQualityReview
                ? qualityOffer(runId, offerId, storyId, 1)
                : offer(runId, offerId, storyId, 1),
        ),
    )
    env.deliverSemanticEvent(
        source("worker"),
        WorkClaimed.create({
            runId,
            offerId,
            storyId,
            workerId: "worker",
            backend: "claude",
            model: "sonnet",
        }),
    )
}

function successfulResult(
    runId: string,
    lease: ReturnType<typeof WorkLeaseGranted.create>["data"],
): ReturnType<typeof StoryResult.create> {
    return StoryResult.create({
        storyId: lease.request.storyId,
        success: true,
        attempts: 1,
        durationSecs: 1,
        error: null,
        runId,
        leaseId: lease.leaseId,
        generation: lease.generation,
    })
}

function passedQuality(
    runId: string,
    lease: ReturnType<typeof WorkLeaseGranted.create>["data"],
): ReturnType<typeof StoryQualityCompleted.create> {
    return StoryQualityCompleted.create({
        runId,
        evaluationId: `quality-${lease.request.storyId}`,
        storyId: lease.request.storyId,
        leaseId: lease.leaseId,
        generation: lease.generation,
        status: "passed",
        targetTurn: 1,
        reason: "candidate passed",
    })
}

async function assertOperationalFailureKeepsRouteAvailable(
    failure: StoryFailureData,
): Promise<void> {
    const suffix = `${failure.kind}-${failure.code ?? "unknown"}`
    const runId = `run-${suffix}`
    const routeDescriptor = route(`route-${suffix}`, "openai", "test-model")
    const worker = source(`worker-source-${suffix}`)
    const broker = new LeaseBroker({
        runId,
        parallel: 1,
        intraLevelDelaySecs: 0,
        claimTimeoutMs: 50,
    })
    const env = joinWithCapture(broker)

    const claim = (storyId: string): void => {
        const offerId = `offer-${storyId}`
        env.deliverSemanticEvent(
            source("board"),
            WorkOffered.create(offer(runId, offerId, storyId, 1)),
        )
        env.deliverSemanticEvent(
            worker,
            WorkClaimed.create({
                runId,
                offerId,
                storyId,
                workerId: `worker-${suffix}`,
                backend: routeDescriptor.backend,
                model: routeDescriptor.model,
                route: routeDescriptor,
            }),
        )
    }

    claim("S1")
    await waitFor(() => env.events.filter(WorkLeaseGranted.is).length === 1)
    const first = env.events.find(WorkLeaseGranted.is)!

    env.deliverSemanticEvent(
        source("S1-agent"),
        StoryResult.create({
            storyId: "S1",
            success: false,
            attempts: 1,
            durationSecs: 1,
            error: `${failure.kind} failure`,
            failure,
            runId,
            leaseId: first.data.leaseId,
            generation: first.data.generation,
        }),
    )
    await waitFor(() => env.events.some(WorkLeaseReleased.is))
    assert.equal(
        env.events.find(WorkLeaseReleased.is)?.data.reason,
        "operational_failed",
    )

    claim("S2")
    await waitFor(() => env.events.filter(WorkLeaseGranted.is).length === 2)
    const second = env.events.filter(WorkLeaseGranted.is)[1]!
    assert.equal(second.data.workerId, `worker-${suffix}`)
    assert.equal(second.data.route?.routeId, routeDescriptor.routeId)
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for market event")
        await new Promise((resolve) => setTimeout(resolve, 2))
    }
}

async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
}
