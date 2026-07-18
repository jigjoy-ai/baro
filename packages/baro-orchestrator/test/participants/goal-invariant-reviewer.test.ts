import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { GoalInvariantReviewer } from "../../src/participants/goal-invariant-reviewer.js"
import { createGoalAggregateReviewBasis } from "../../src/runtime/goal-aggregate-review.js"
import {
    DialogueResponderInvocationError,
    type DialogueResponder,
    type DialogueResponderInvocation,
} from "../../src/participants/dialogue-agent.js"
import { createDialogueResponder } from "../../src/participants/dialogue-responder.js"
import { isProviderCallTimeout } from "../../src/planning/openai-runtime.js"
import {
    GoalAggregateReviewCompleted,
    GoalAggregateReviewRequested,
    ModelInvocationMeasured,
    RunPrepared,
    RunVerificationCompleted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("GoalInvariantReviewer", () => {
    it("batches an A8-shaped aggregate review once and caches an exact replay", async () => {
        const repo = createRepository()
        try {
            const runId = "run-aggregate-pass"
            const guardian = source("goal-guardian")
            const verifier = source("run-verifier")
            const repository = source("repository")
            const board = source("board")
            const prompts: string[] = []
            const reviewer = new GoalInvariantReviewer({
                runId,
                cwd: repo.path,
                modelUsed: "fake-reviewer",
                responder: async (input) => {
                    prompts.push(input.userPrompt)
                    return JSON.stringify({
                        verdict: "pass",
                        reasoning: "all provider shards compose",
                        violated_criteria: [],
                    })
                },
            })
            reviewer.setRequestAuthority(guardian)
            reviewer.setVerificationAuthority(verifier)
            reviewer.setRepositoryAuthority(repository)
            reviewer.setCompletionAuthority(board)
            const env = joinWithCapture(reviewer)
            deliverEvidence(env, repository, verifier, runId, repo.baseSha)
            const request = aggregateRequest(runId)

            env.deliverSemanticEvent(source("forged-guardian"), request)
            env.deliverSemanticEvent(guardian, request)
            await reviewer.idle()

            const completed = env.events.filter(
                GoalAggregateReviewCompleted.is,
            )
            assert.equal(completed.length, 1)
            assert.equal(completed[0]!.data.status, "passed")
            assert.match(
                completed[0]!.data.repositoryFingerprint ?? "",
                /^[0-9a-f]{64}$/,
            )
            assert.equal(completed[0]!.data.invariants[0]!.status, "passed")
            assert.equal(prompts.length, 1)
            assert.match(prompts[0]!, /jointly preserve cooperative cancellation/)
            for (const storyId of ["S5", "S6", "S7", "S8"]) {
                assert.match(prompts[0]!, new RegExp(storyId))
            }
            assert.match(prompts[0]!, /provider shard merged composition/)
            assert.match(prompts[0]!, /npm test/)

            env.deliverSemanticEvent(guardian, request)
            await reviewer.idle()
            assert.equal(prompts.length, 1, "exact replay spends no second call")
            assert.equal(
                env.events.filter(GoalAggregateReviewCompleted.is).length,
                2,
            )
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("returns exact negative evidence without retrying", async () => {
        const repo = createRepository()
        try {
            const runId = "run-aggregate-fail"
            const guardian = source("goal-guardian")
            const verifier = source("run-verifier")
            const repository = source("repository")
            let calls = 0
            const reviewer = new GoalInvariantReviewer({
                runId,
                cwd: repo.path,
                modelUsed: "fake-reviewer",
                responder: async () => {
                    calls += 1
                    return JSON.stringify({
                        verdict: "fail",
                        reasoning: "S8 drops the shared signal",
                        violated_criteria: [
                            "[G-A1] All four provider shards jointly preserve cooperative cancellation.",
                        ],
                    })
                },
            })
            reviewer.setRequestAuthority(guardian)
            reviewer.setVerificationAuthority(verifier)
            reviewer.setRepositoryAuthority(repository)
            const env = joinWithCapture(reviewer)
            deliverEvidence(env, repository, verifier, runId, repo.baseSha)
            env.deliverSemanticEvent(guardian, aggregateRequest(runId))
            await reviewer.idle()

            const completed = env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(calls, 1)
            assert.equal(completed?.data.status, "failed")
            assert.equal(completed?.data.invariants[0]?.status, "failed")
            assert.match(completed?.data.invariants[0]?.reason ?? "", /S8/)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("bounds operational retries and fails closed when evaluation stays malformed", async () => {
        const repo = createRepository()
        try {
            const runId = "run-aggregate-inconclusive"
            const guardian = source("goal-guardian")
            const verifier = source("run-verifier")
            const repository = source("repository")
            let calls = 0
            const billingAttempts: Array<number | undefined> = []
            const reviewer = new GoalInvariantReviewer({
                runId,
                cwd: repo.path,
                modelUsed: "fake-reviewer",
                maxAttempts: 2,
                responder: async (input) => {
                    calls += 1
                    billingAttempts.push(input.billingAttempt)
                    return "not-json"
                },
            })
            reviewer.setRequestAuthority(guardian)
            reviewer.setVerificationAuthority(verifier)
            reviewer.setRepositoryAuthority(repository)
            const env = joinWithCapture(reviewer)
            deliverEvidence(env, repository, verifier, runId, repo.baseSha)
            env.deliverSemanticEvent(guardian, aggregateRequest(runId))
            await reviewer.idle()

            const completed = env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(calls, 2)
            assert.deepEqual(billingAttempts, [1, 2])
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 2)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("awaits provider settlement after timeout, emits one measurement, and does not retry", async () => {
        const repo = createRepository()
        try {
            const runId = "run-aggregate-timeout"
            const guardian = source("goal-guardian")
            const verifier = source("run-verifier")
            const repository = source("repository")
            let calls = 0
            let providerSettled = false
            const invocation = timedOutInvocation()
            const reviewer = new GoalInvariantReviewer({
                runId,
                cwd: repo.path,
                modelUsed: "fake-reviewer",
                timeoutMs: 5,
                settlementTimeoutMs: 100,
                maxAttempts: 2,
                responder: async (_input, signal) => {
                    calls += 1
                    return await new Promise<string>((_resolve, reject) => {
                        signal.addEventListener("abort", () => {
                            assert.equal(isProviderCallTimeout(signal.reason), true)
                            setTimeout(() => {
                                providerSettled = true
                                reject(new DialogueResponderInvocationError(
                                    "provider aborted and settled",
                                    invocation,
                                ))
                            }, 20)
                        }, { once: true })
                    })
                },
            })
            reviewer.setRequestAuthority(guardian)
            reviewer.setVerificationAuthority(verifier)
            reviewer.setRepositoryAuthority(repository)
            const env = joinWithCapture(reviewer)
            deliverEvidence(env, repository, verifier, runId, repo.baseSha)
            env.deliverSemanticEvent(guardian, aggregateRequest(runId))
            await reviewer.idle()

            const completed = env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(providerSettled, true)
            assert.equal(calls, 1)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 1)
            assert.match(
                completed?.data.invariants[0]?.reason ?? "",
                /timed out/,
            )
            const measurements = env.events.filter(ModelInvocationMeasured.is)
            assert.equal(measurements.length, 1)
            assert.equal(measurements[0]!.data.status, "timed_out")
            assert.equal(measurements[0]!.data.attempt, 1)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("fails the reviewer lifecycle when an injected provider cannot certify settlement", async () => {
        const repo = createRepository()
        try {
            const runId = "run-aggregate-unsettled"
            const guardian = source("goal-guardian")
            const verifier = source("run-verifier")
            const repository = source("repository")
            let calls = 0
            const telemetry = {
                failureInvocation: () => timedOutInvocation(),
            }
            const responder = Object.assign(
                async () => {
                    calls += 1
                    return await new Promise<string>(() => {})
                },
                { telemetry },
            ) satisfies DialogueResponder
            const reviewer = new GoalInvariantReviewer({
                runId,
                cwd: repo.path,
                modelUsed: "fake-reviewer",
                timeoutMs: 5,
                settlementTimeoutMs: 10,
                maxAttempts: 2,
                responder,
            })
            reviewer.setRequestAuthority(guardian)
            reviewer.setVerificationAuthority(verifier)
            reviewer.setRepositoryAuthority(repository)
            const env = joinWithCapture(reviewer)
            deliverEvidence(env, repository, verifier, runId, repo.baseSha)
            env.deliverSemanticEvent(guardian, aggregateRequest(runId))
            await reviewer.idle()

            assert.equal(calls, 1)
            const completed = env.events.filter(GoalAggregateReviewCompleted.is)
            assert.equal(completed.length, 1)
            assert.equal(completed[0]!.data.status, "inconclusive")
            assert.equal(completed[0]!.data.attempts, 1)
            assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 1)
            assert.equal(await reviewer.shutdown(), false)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("returns bounded inconclusive without a model call when the tracked diff cannot fit losslessly", async () => {
        const repo = createRepository()
        try {
            writeFileSync(join(repo.path, "providers.ts"), "x".repeat(300_000))
            let calls = 0
            const fixture = reviewerFixture(
                "run-aggregate-oversized-diff",
                repo,
                async () => {
                    calls += 1
                    return passVerdict()
                },
            )
            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                aggregateRequest(fixture.runId),
            )
            await fixture.reviewer.idle()

            const completed = fixture.env.events.find(
                GoalAggregateReviewCompleted.is,
            )
            assert.equal(calls, 0)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 0)
            assert.match(
                completed?.data.invariants[0]?.reason ?? "",
                /evidence|budget|buffer/i,
            )
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("does not call the model when exact verification command evidence exceeds its budget", async () => {
        const repo = createRepository()
        try {
            const runId = "run-aggregate-command-budget"
            const guardian = source("goal-guardian")
            const verifier = source("run-verifier")
            const repository = source("repository")
            let calls = 0
            const reviewer = new GoalInvariantReviewer({
                runId,
                cwd: repo.path,
                modelUsed: "fake-reviewer",
                responder: async () => {
                    calls += 1
                    return passVerdict()
                },
            })
            reviewer.setRequestAuthority(guardian)
            reviewer.setVerificationAuthority(verifier)
            reviewer.setRepositoryAuthority(repository)
            const env = joinWithCapture(reviewer)
            env.deliverSemanticEvent(
                repository,
                RunPrepared.create({ runId, baseSha: repo.baseSha }),
            )
            env.deliverSemanticEvent(
                verifier,
                RunVerificationCompleted.create({
                    runId,
                    verificationId: "verification-a8",
                    status: "passed",
                    commands: [{
                        command: "npm test",
                        status: "passed",
                        durationMs: 1,
                        tail: "c".repeat(270_000),
                    }],
                    durationMs: 1,
                }),
            )
            env.deliverSemanticEvent(guardian, aggregateRequest(runId))
            await reviewer.idle()

            const completed = env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(calls, 0)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 0)
            assert.match(completed?.data.invariants[0]?.reason ?? "", /budget/)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("includes exact untracked regular-file bytes instead of passing on omitted content", async () => {
        const repo = createRepository()
        try {
            const content = "export const untrackedCancellationBug = false\n"
            writeFileSync(join(repo.path, "new-provider.ts"), content)
            let prompt = ""
            const fixture = reviewerFixture(
                "run-aggregate-untracked",
                repo,
                async (input) => {
                    prompt = input.userPrompt
                    return passVerdict()
                },
            )
            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                aggregateRequest(fixture.runId),
            )
            await fixture.reviewer.idle()

            assert.equal(
                fixture.env.events.find(GoalAggregateReviewCompleted.is)?.data.status,
                "passed",
            )
            assert.match(prompt, /new-provider\.ts/)
            assert.match(prompt, /"contentUtf8"/)
            assert.match(prompt, /untrackedCancellationBug/)
            assert.doesNotMatch(
                prompt,
                new RegExp(Buffer.from(content).toString("base64")),
            )
            assert.doesNotMatch(prompt, /content omitted/)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("fails closed when an untracked file exceeds the exact-content budget", async () => {
        const repo = createRepository()
        try {
            writeFileSync(join(repo.path, "large-untracked.bin"), "u".repeat(70_000))
            let calls = 0
            const fixture = reviewerFixture(
                "run-aggregate-large-untracked",
                repo,
                async () => {
                    calls += 1
                    return passVerdict()
                },
            )
            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                aggregateRequest(fixture.runId),
            )
            await fixture.reviewer.idle()
            const completed = fixture.env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(calls, 0)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 0)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("does not publish telemetry when a local reviewer harness never dispatches", async () => {
        const repo = createRepository()
        try {
            const runId = "run-aggregate-no-dispatch"
            const guardian = source("goal-guardian")
            const verifier = source("run-verifier")
            const repository = source("repository")
            const reviewer = new GoalInvariantReviewer({
                runId,
                cwd: repo.path,
                modelUsed: "missing-codex",
                maxAttempts: 1,
                responder: createDialogueResponder({
                    backend: "codex",
                    cwd: repo.path,
                    codexBin: join(repo.path, "definitely-missing-codex"),
                    safeReadOnlyEvaluator: true,
                    codexSkipGitRepoCheck: true,
                }),
            })
            reviewer.setRequestAuthority(guardian)
            reviewer.setVerificationAuthority(verifier)
            reviewer.setRepositoryAuthority(repository)
            const env = joinWithCapture(reviewer)
            deliverEvidence(env, repository, verifier, runId, repo.baseSha)

            env.deliverSemanticEvent(guardian, aggregateRequest(runId))
            await reviewer.idle()

            const completed = env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 1)
            assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("renders every challenge, remediation, revalidation, and protocol field losslessly", async () => {
        const repo = createRepository()
        try {
            let prompt = ""
            const fixture = reviewerFixture(
                "run-aggregate-complete-basis",
                repo,
                async (input) => {
                    prompt = input.userPrompt
                    return passVerdict()
                },
            )
            const original = aggregateRequest(fixture.runId).data
            const basis = createGoalAggregateReviewBasis({
                ...omitFingerprint(original.basis),
                challenges: [{
                    challengeId: "challenge-exact",
                    invariantId: "G-A1",
                    raisedBy: "worker-S8",
                    reason: "shared abort signal was replaced",
                    storyId: "S8",
                    resolution: {
                        resolution: "resolved",
                        reason: "remediation integrated",
                    },
                    remediation: {
                        proposalId: "proposal-exact",
                        storyId: "S9",
                        status: "admitted",
                        graphVersion: 11,
                        revalidates: [{
                            storyId: "S8",
                            leaseId: "lease-S8",
                        }],
                    },
                }],
                protocolIssues: [{
                    scope: "challenge",
                    key: "protocol-key-exact",
                    reason: "protocol-reason-exact",
                }],
            })
            const request = GoalAggregateReviewRequested.create({
                ...original,
                reviewId: `goal-review:${basis.fingerprint}`,
                basis,
            })
            fixture.env.deliverSemanticEvent(fixture.guardian, request)
            await fixture.reviewer.idle()

            for (const exact of [
                "challenge-exact",
                "worker-S8",
                "shared abort signal was replaced",
                "remediation integrated",
                "proposal-exact",
                "S9",
                '"graphVersion": 11',
                '"revalidates"',
                "lease-S8",
                "protocol-key-exact",
                "protocol-reason-exact",
                '"independentlyPassed": true',
                '"storyIds"',
            ]) assert.ok(prompt.includes(exact), `missing exact basis field ${exact}`)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("completes a maximal valid 64-invariant contract without a managed preparation failure", async () => {
        const repo = createRepository()
        try {
            let calls = 0
            const fixture = reviewerFixture(
                "run-aggregate-max-envelope",
                repo,
                async () => {
                    calls += 1
                    return passVerdict()
                },
            )
            const invariantText = "v".repeat(2_000)
            const invariants = Array.from({ length: 64 }, (_, index) => ({
                invariantId: index < 32
                    ? `G-A${index + 1}`
                    : `G-C${index - 31}`,
                text: invariantText,
                mappedStoryIds: ["S1"],
                contributions: [{
                    storyId: "S1",
                    leaseId: "lease-S1",
                    evaluationId: `quality-${index}`,
                    qualityStatus: "passed" as const,
                    independentlyPassed: true,
                }],
            }))
            const basis = createGoalAggregateReviewBasis({
                contractId: "goal:max-envelope",
                objective: "o".repeat(8_000),
                nonGoals: Array.from({ length: 32 }, () => "n".repeat(2_000)),
                assumptions: Array.from({ length: 32 }, () => "a".repeat(2_000)),
                verificationId: "verification-a8",
                storyIds: ["S1"],
                invariants,
                challenges: [],
                protocolIssues: [],
            })
            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                GoalAggregateReviewRequested.create({
                    runId: fixture.runId,
                    reviewId: `goal-review:${basis.fingerprint}`,
                    checkId: "check-max-envelope",
                    goalRevision: 9,
                    basis,
                }),
            )
            await fixture.reviewer.idle()

            const completed = fixture.env.events.find(GoalAggregateReviewCompleted.is)
            assert.ok(completed, "maximal contract must always terminate with Completed")
            assert.ok(
                completed.data.status === "passed" ||
                    completed.data.status === "inconclusive",
            )
            assert.equal(
                completed.data.attempts,
                completed.data.status === "passed" ? 1 : 0,
            )
            assert.equal(calls, completed.data.status === "passed" ? 1 : 0)
            assert.equal(completed.data.invariants.length, 64)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("retains first trusted base and verification evidence on conflicting same-id replay", async () => {
        const repo = createRepository()
        try {
            let calls = 0
            const fixture = reviewerFixture(
                "run-aggregate-conflict",
                repo,
                async () => {
                    calls += 1
                    return passVerdict()
                },
            )
            fixture.env.deliverSemanticEvent(
                fixture.repository,
                RunPrepared.create({
                    runId: fixture.runId,
                    baseSha: `${repo.baseSha}conflict`,
                }),
            )
            fixture.env.deliverSemanticEvent(
                fixture.verifier,
                RunVerificationCompleted.create({
                    runId: fixture.runId,
                    verificationId: "verification-a8",
                    status: "passed",
                    commands: [{
                        command: "forged replacement",
                        status: "passed",
                        durationMs: 1,
                    }],
                    durationMs: 1,
                }),
            )
            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                aggregateRequest(fixture.runId),
            )
            await fixture.reviewer.idle()
            const completed = fixture.env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(calls, 0)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 0)
            assert.match(completed?.data.invariants[0]?.reason ?? "", /conflicting/)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("fails closed when trusted evidence conflicts while the model is in flight", async () => {
        const repo = createRepository()
        try {
            let announceStarted!: () => void
            const started = new Promise<void>((resolve) => {
                announceStarted = resolve
            })
            let finish!: (value: string) => void
            const fixture = reviewerFixture(
                "run-aggregate-inflight-conflict",
                repo,
                async () => {
                    announceStarted()
                    return await new Promise<string>((resolve) => {
                        finish = resolve
                    })
                },
            )
            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                aggregateRequest(fixture.runId),
            )
            await started
            fixture.env.deliverSemanticEvent(
                fixture.repository,
                RunPrepared.create({
                    runId: fixture.runId,
                    baseSha: `${repo.baseSha}-conflict`,
                }),
            )
            finish(passVerdict())
            await fixture.reviewer.idle()

            const completed = fixture.env.events.find(GoalAggregateReviewCompleted.is)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 1)
            assert.match(completed?.data.invariants[0]?.reason ?? "", /conflicting/)
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("fails closed when the repository changes while the model is in flight", async () => {
        const repo = createRepository()
        try {
            let announceStarted!: () => void
            const started = new Promise<void>((resolve) => {
                announceStarted = resolve
            })
            let finish!: (value: string) => void
            let calls = 0
            const fixture = reviewerFixture(
                "run-aggregate-inflight-repository-change",
                repo,
                async () => {
                    calls += 1
                    announceStarted()
                    return await new Promise<string>((resolve) => {
                        finish = resolve
                    })
                },
            )
            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                aggregateRequest(fixture.runId),
            )
            await started
            writeFileSync(
                join(repo.path, "providers.ts"),
                "export const providers = ['changed while reviewer was in flight']\n",
            )
            finish(passVerdict())
            await fixture.reviewer.idle()

            const completed = fixture.env.events.find(
                GoalAggregateReviewCompleted.is,
            )
            assert.equal(calls, 1)
            assert.equal(completed?.data.status, "inconclusive")
            assert.equal(completed?.data.attempts, 1)
            assert.equal(completed?.data.repositoryFingerprint, null)
            assert.match(
                completed?.data.invariants[0]?.reason ?? "",
                /repository changed/,
            )
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("revalidates an exact cached PASS after repository mutation without a second model call", async () => {
        const repo = createRepository()
        try {
            let calls = 0
            const fixture = reviewerFixture(
                "run-aggregate-cached-repository-change",
                repo,
                async () => {
                    calls += 1
                    return passVerdict()
                },
            )
            const request = aggregateRequest(fixture.runId)
            fixture.env.deliverSemanticEvent(fixture.guardian, request)
            await fixture.reviewer.idle()

            const first = fixture.env.events.find(
                GoalAggregateReviewCompleted.is,
            )
            assert.equal(first?.data.status, "passed")
            assert.match(
                first?.data.repositoryFingerprint ?? "",
                /^[0-9a-f]{64}$/,
            )

            writeFileSync(
                join(repo.path, "providers.ts"),
                "export const providers = ['changed after cached pass']\n",
            )
            fixture.env.deliverSemanticEvent(fixture.guardian, request)
            await fixture.reviewer.idle()

            const completed = fixture.env.events.filter(
                GoalAggregateReviewCompleted.is,
            )
            assert.equal(calls, 1, "cached replay spends no second model call")
            assert.equal(completed.length, 2)
            assert.equal(completed[1]!.data.status, "inconclusive")
            assert.equal(completed[1]!.data.attempts, 1)
            assert.equal(completed[1]!.data.repositoryFingerprint, null)
            assert.match(
                completed[1]!.data.invariants[0]?.reason ?? "",
                /repository changed/,
            )
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })

    it("terminates a conflicting cached review correlation without a second model call", async () => {
        const repo = createRepository()
        try {
            let calls = 0
            const fixture = reviewerFixture(
                "run-aggregate-cached-correlation-conflict",
                repo,
                async () => {
                    calls += 1
                    return passVerdict()
                },
            )
            const request = aggregateRequest(fixture.runId)
            fixture.env.deliverSemanticEvent(fixture.guardian, request)
            await fixture.reviewer.idle()

            fixture.env.deliverSemanticEvent(
                fixture.guardian,
                GoalAggregateReviewRequested.create({
                    ...request.data,
                    checkId: "check-conflicting-replay",
                }),
            )
            await fixture.reviewer.idle()

            const completed = fixture.env.events.filter(
                GoalAggregateReviewCompleted.is,
            )
            assert.equal(calls, 1)
            assert.equal(completed.length, 2)
            assert.equal(completed[1]!.data.checkId, "check-conflicting-replay")
            assert.equal(completed[1]!.data.status, "inconclusive")
            assert.equal(completed[1]!.data.attempts, 0)
            assert.match(
                completed[1]!.data.invariants[0]?.reason ?? "",
                /conflicting request correlation/,
            )
        } finally {
            rmSync(repo.path, { recursive: true, force: true })
        }
    })
})

function aggregateRequest(runId: string) {
    const storyIds = ["S5", "S6", "S7", "S8"]
    const basis = createGoalAggregateReviewBasis({
        contractId: "goal:a8",
        objective: "Propagate cancellation through every provider.",
        nonGoals: [],
        assumptions: [],
        verificationId: "verification-a8",
        storyIds,
        invariants: [{
            invariantId: "G-A1",
            text: "All four provider shards jointly preserve cooperative cancellation.",
            mappedStoryIds: storyIds,
            contributions: storyIds.map((storyId) => ({
                storyId,
                leaseId: `lease-${storyId}`,
                evaluationId: `quality-${storyId}`,
                qualityStatus: "passed" as const,
                independentlyPassed: true,
            })),
        }],
        challenges: [],
        protocolIssues: [],
    })
    return GoalAggregateReviewRequested.create({
        runId,
        reviewId: `goal-review:${basis.fingerprint}`,
        checkId: "check-a8",
        goalRevision: 7,
        basis,
    })
}

function omitFingerprint<T extends { fingerprint: string }>(
    basis: T,
): Omit<T, "fingerprint"> {
    const { fingerprint: _fingerprint, ...input } = basis
    return input
}

function deliverEvidence(
    env: ReturnType<typeof joinWithCapture>,
    repository: ReturnType<typeof source>,
    verifier: ReturnType<typeof source>,
    runId: string,
    baseSha: string,
): void {
    env.deliverSemanticEvent(
        source("forged-repository"),
        RunPrepared.create({ runId, baseSha: "forged" }),
    )
    env.deliverSemanticEvent(
        repository,
        RunPrepared.create({ runId, baseSha }),
    )
    env.deliverSemanticEvent(
        source("forged-verifier"),
        RunVerificationCompleted.create({
            runId,
            verificationId: "verification-a8",
            status: "failed",
            commands: [],
            durationMs: 1,
        }),
    )
    env.deliverSemanticEvent(
        verifier,
        RunVerificationCompleted.create({
            runId,
            verificationId: "verification-a8",
            status: "passed",
            commands: [{
                command: "npm test",
                status: "passed",
                durationMs: 10,
                tail: "all provider cancellation tests passed",
            }],
            durationMs: 10,
        }),
    )
}

function reviewerFixture(
    runId: string,
    repo: { path: string; baseSha: string },
    responder: DialogueResponder,
) {
    const guardian = source("goal-guardian")
    const verifier = source("run-verifier")
    const repository = source("repository")
    const reviewer = new GoalInvariantReviewer({
        runId,
        cwd: repo.path,
        modelUsed: "fake-reviewer",
        responder,
    })
    reviewer.setRequestAuthority(guardian)
    reviewer.setVerificationAuthority(verifier)
    reviewer.setRepositoryAuthority(repository)
    const env = joinWithCapture(reviewer)
    deliverEvidence(env, repository, verifier, runId, repo.baseSha)
    return { runId, guardian, verifier, repository, reviewer, env }
}

function passVerdict(): string {
    return JSON.stringify({
        verdict: "pass",
        reasoning: "the exact merged evidence composes",
        violated_criteria: [],
    })
}

function createRepository(): { path: string; baseSha: string } {
    const path = mkdtempSync(join(tmpdir(), "baro-goal-reviewer-"))
    execFileSync("git", ["init"], { cwd: path })
    execFileSync("git", ["config", "user.email", "baro@example.com"], {
        cwd: path,
    })
    execFileSync("git", ["config", "user.name", "Baro Test"], { cwd: path })
    writeFileSync(join(path, "providers.ts"), "export const providers = []\n")
    execFileSync("git", ["add", "providers.ts"], { cwd: path })
    execFileSync("git", ["commit", "-m", "base"], { cwd: path })
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: path,
        encoding: "utf8",
    }).trim()
    writeFileSync(
        join(path, "providers.ts"),
        "export const providers = ['provider shard merged composition']\n",
    )
    return { path, baseSha }
}

function timedOutInvocation(): DialogueResponderInvocation {
    const missing = { state: "unknown", reason: "timed_out" } as const
    const na = { state: "not_applicable" } as const
    return {
        backend: "fake",
        requestedModel: "fake-reviewer",
        observation: {
            sequence: 1,
            granularity: "process",
            status: "timed_out",
            durationMs: missing,
            tokens: {
                inputTotal: missing,
                cachedInput: missing,
                cacheWriteInput: na,
                outputTotal: missing,
                reasoningOutput: missing,
                total: missing,
            },
            cost: {
                providerUsd: na,
                customerUsd: na,
                equivalentUsd: missing,
            },
            provider: "fake",
            resolvedModel: "fake-reviewer",
            providerRequestId: null,
        },
    }
}
