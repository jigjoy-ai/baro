import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { knownMetric, unknownMetric } from "../../src/model-telemetry.js"
import { Surgeon, type PrdSnapshot } from "../../src/participants/surgeon.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import {
    Critique,
    ModelInvocationMeasured,
    RecoveryDecision,
    RecoveryEvaluationStarted,
    Replan,
    StoryQualityCompleted,
    StoryResult,
    WorkLeaseGranted,
} from "../../src/semantic-events.js"
import {
    assertHarnessEnvironmentWasSanitized,
    harnessEnvironmentCaptureProgram,
    joinWithCapture,
    source,
    withInjectedJigJoyEnvironment,
    withTempDir,
} from "./helpers.js"

const snapshot: PrdSnapshot = {
    project: "Surgeon test",
    description: "Exercise deterministic recovery",
    stories: [
        {
            id: "S1",
            title: "Foundation",
            description: "Done first",
            dependsOn: [],
            passes: true,
            model: "haiku",
        },
        {
            id: "S2",
            title: "Recoverable failure",
            description: "This story failed",
            dependsOn: ["S1"],
            passes: false,
            model: "sonnet",
        },
    ],
}

describe("Surgeon", () => {
    it("keeps forged Critiques out of collective recovery context", async () => {
        const outcomeAuthority = new StoryOutcomeAuthority("run-critique-source")
        const critic = source("critic")
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
            runId: "run-critique-source",
            emitRecoveryDecisions: true,
            outcomeAuthority,
        })
        surgeon.setCriticAuthority(critic)

        const critique = (reasoning: string) =>
            Critique.create({
                agentId: "S2",
                verdict: "fail" as const,
                reasoning,
                violatedCriteria: ["tests"],
                turn: 1,
                modelUsed: "critic-test",
            })
        await surgeon.onExternalEvent(source("ambient"), critique("forged"))
        await surgeon.onExternalEvent(critic, critique("authoritative"))

        const stored = (
            surgeon as unknown as {
                critiques: {
                    forStory(storyId: string): readonly { reasoning: string }[]
                }
            }
        ).critiques.forStory("S2")
        assert.deepEqual(stored.map((item) => item.reasoning), ["authoritative"])
    })

    it("keeps Baro's injected Gateway credential out of the Claude recovery process", async () => {
        await withTempDir("baro-surgeon-env-", async (dir) => {
            const capture = join(dir, "environment.json")
            const bin = join(dir, "fake-claude-env.mjs")
            const wrapper = {
                type: "result",
                subtype: "success",
                is_error: false,
                result: JSON.stringify({
                    action: "skip",
                    reason: "test recovery",
                    added: [],
                    removed: ["S2"],
                    modifiedDeps: [],
                }),
            }
            writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
console.log(${JSON.stringify(JSON.stringify(wrapper))});
`)
            chmodSync(bin, 0o755)

            await withInjectedJigJoyEnvironment(async () => {
                const surgeon = new Surgeon({
                    snapshot: () => snapshot,
                    useLlm: true,
                    claudeBin: bin,
                    runId: "run-surgeon-env",
                })
                joinWithCapture(surgeon)
                await surgeon.onExternalEvent(
                    source("S2"),
                    StoryResult.create({
                        storyId: "S2",
                        success: false,
                        attempts: 3,
                        durationSecs: 1,
                        error: "test failure",
                    }),
                )
                await surgeon.idle()
            })
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

    it("emits a deterministic replan for a failed story", async () => {
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
            maxReplans: 1,
            runId: "run-surgeon",
            emitRecoveryDecisions: true,
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(
            source("broker"),
            WorkLeaseGranted.create({
                runId: "run-surgeon",
                offerId: "offer-S2",
                leaseId: "lease-S2",
                workerId: "worker",
                generation: 1,
                request: {
                    storyId: "S2",
                    prompt: "recover",
                    model: "standard",
                    retries: 2,
                    timeoutSecs: 60,
                },
            }),
        )

        const failure = StoryResult.create({
            storyId: "S2",
            success: false,
            attempts: 3,
            durationSecs: 45,
            error: "tests failed",
            runId: "run-surgeon",
            leaseId: "lease-S2",
            generation: 1,
        })
        await surgeon.onExternalEvent(source("S2"), failure)
        await surgeon.onExternalEvent(source("duplicate-S2"), failure)
        await surgeon.idle()

        const replan = env.events.find((event) => Replan.is(event))
        assert.ok(replan, "Replan emitted")
        assert.deepEqual(replan.data, {
            source: "surgeon",
            reason: "deterministic skip: S2 exhausted 3 attempts (tests failed)",
            addedStories: [],
            removedStoryIds: ["S2"],
            modifiedDeps: {},
            recovery: {
                runId: "run-surgeon",
                storyId: "S2",
                leaseId: "lease-S2",
                generation: 1,
            },
        })
        assert.deepEqual(
            env.events
                .filter((event) =>
                    RecoveryEvaluationStarted.is(event) ||
                    Replan.is(event) ||
                    RecoveryDecision.is(event),
                )
                .map((event) => event.type),
            ["recovery_evaluation_started", "replan", "recovery_decision"],
        )
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)
    })

    it("publishes one Claude measurement before the correlated recovery outcome", async () => {
        await withTempDir("baro-surgeon-telemetry-", async (dir) => {
            const surgeon = new Surgeon({
                snapshot: () => snapshot,
                useLlm: true,
                claudeBin: writeFakeClaude(dir, {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    session_id: "conversation-not-provider-request",
                    duration_ms: 456,
                    total_cost_usd: 0.025,
                    usage: {
                        input_tokens: 10,
                        cache_read_input_tokens: 5,
                        cache_creation_input_tokens: 3,
                        output_tokens: 7,
                    },
                    result: JSON.stringify({
                        action: "skip",
                        reason: "infeasible dependency",
                        added: [],
                        removed: ["S2"],
                        modifiedDeps: [],
                    }),
                }),
                model: "claude-surgeon-test",
                runId: "run-surgeon-telemetry",
                emitRecoveryDecisions: true,
            })
            const env = joinWithCapture(surgeon)
            await grantLease(
                surgeon,
                "run-surgeon-telemetry",
                "lease-telemetry",
                4,
            )

            await surgeon.onExternalEvent(
                source("S2"),
                StoryResult.create({
                    storyId: "S2",
                    success: false,
                    attempts: 3,
                    durationSecs: 45,
                    error: "tests failed",
                    runId: "run-surgeon-telemetry",
                    leaseId: "lease-telemetry",
                    generation: 4,
                }),
            )
            await surgeon.idle()

            const measured = env.events.filter(ModelInvocationMeasured.is)
            const replans = env.events.filter(Replan.is)
            const decisions = env.events.filter(RecoveryDecision.is)
            assert.equal(measured.length, 1)
            assert.equal(replans.length, 1)
            assert.equal(decisions.length, 1)
            assert.ok(env.events.indexOf(measured[0]!) < env.events.indexOf(replans[0]!))
            assert.ok(env.events.indexOf(measured[0]!) < env.events.indexOf(decisions[0]!))

            const item = measured[0]!.data
            assert.equal(
                item.invocationId,
                "run-surgeon-telemetry:surgeon:S2:generation-4",
            )
            assert.equal(
                item.measurementId,
                "run-surgeon-telemetry:surgeon:S2:generation-4:runner",
            )
            assert.equal(item.runId, "run-surgeon-telemetry")
            assert.equal(item.phase, "surgeon")
            assert.equal(item.storyId, "S2")
            assert.equal(item.turn, 1)
            assert.equal(item.backend, "claude")
            assert.equal(item.provider, null)
            assert.equal(item.evidence.providerRequestId, null)
            assert.equal(item.status, "succeeded")
            assert.deepEqual(item.durationMs, knownMetric(456, "cli_result"))
            assert.deepEqual(item.tokens.inputTotal, knownMetric(18, "derived"))
            assert.deepEqual(
                item.tokens.cachedInput,
                knownMetric(5, "provider_response"),
            )
            assert.deepEqual(
                item.tokens.cacheWriteInput,
                knownMetric(3, "provider_response"),
            )
            assert.deepEqual(
                item.tokens.outputTotal,
                knownMetric(7, "provider_response"),
            )
            assert.deepEqual(item.tokens.total, knownMetric(25, "derived"))
            assert.deepEqual(
                item.cost.equivalentUsd,
                knownMetric(0.025, "cli_result"),
            )
        })
    })

    it("keeps successful Claude telemetry when the replan text is malformed", async () => {
        await withTempDir("baro-surgeon-malformed-", async (dir) => {
            const surgeon = new Surgeon({
                snapshot: () => snapshot,
                useLlm: true,
                claudeBin: writeFakeClaude(dir, {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    duration_ms: 8,
                    total_cost_usd: 0.001,
                    usage: {
                        input_tokens: 2,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        output_tokens: 1,
                    },
                    result: "not a replan object",
                }),
            })
            const env = joinWithCapture(surgeon)

            await surgeon.onExternalEvent(
                source("S2"),
                StoryResult.create({
                    storyId: "S2",
                    success: false,
                    attempts: 3,
                    durationSecs: 45,
                    error: "tests failed",
                }),
            )
            await surgeon.idle()

            const measured = env.events.filter(ModelInvocationMeasured.is)
            const replans = env.events.filter(Replan.is)
            assert.equal(measured.length, 1)
            assert.equal(measured[0]!.data.status, "succeeded")
            assert.deepEqual(
                measured[0]!.data.tokens.total,
                knownMetric(3, "derived"),
            )
            assert.equal(replans.length, 1)
            assert.match(replans[0]!.data.reason, /llm fallback after error:/)
        })
    })

    it("reports Claude spawn failures and timeouts once without invented zeros", async () => {
        await withTempDir("baro-surgeon-failures-", async (dir) => {
            const cases = [
                {
                    name: "spawn failure",
                    bin: join(dir, "does-not-exist"),
                    timeoutMs: 1_000,
                    status: "failed" as const,
                    reason: "not_reported" as const,
                },
                {
                    name: "timeout",
                    bin: writeShell(dir, "slow-claude", "sleep 1"),
                    timeoutMs: 10,
                    status: "timed_out" as const,
                    reason: "timed_out" as const,
                },
            ]

            for (const item of cases) {
                const surgeon = new Surgeon({
                    snapshot: () => snapshot,
                    useLlm: true,
                    claudeBin: item.bin,
                    timeoutMs: item.timeoutMs,
                })
                const env = joinWithCapture(surgeon)
                await surgeon.onExternalEvent(
                    source("S2"),
                    StoryResult.create({
                        storyId: "S2",
                        success: false,
                        attempts: 3,
                        durationSecs: 45,
                        error: "tests failed",
                    }),
                )
                await surgeon.idle()

                const measured = env.events.filter(ModelInvocationMeasured.is)
                assert.equal(measured.length, 1, item.name)
                assert.equal(measured[0]!.data.status, item.status, item.name)
                assert.deepEqual(
                    measured[0]!.data.tokens.inputTotal,
                    unknownMetric(item.reason),
                    item.name,
                )
                assert.deepEqual(
                    measured[0]!.data.cost.equivalentUsd,
                    unknownMetric(item.reason),
                    item.name,
                )
                assert.ok(
                    env.events.indexOf(measured[0]!) <
                        env.events.findIndex(Replan.is),
                    item.name,
                )
            }
        })
    })

    it("ignores successful StoryResult events", async () => {
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
        })
        const env = joinWithCapture(surgeon)

        await surgeon.onExternalEvent(
            source("S1"),
            StoryResult.create({
                storyId: "S1",
                success: true,
                attempts: 1,
                durationSecs: 8,
            }),
        )
        await surgeon.idle()

        assert.equal(env.events.filter(Replan.is).length, 0)
    })

    it("ignores a failed result from a superseded collective lease", async () => {
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
            runId: "run-stale",
            emitRecoveryDecisions: true,
        })
        const env = joinWithCapture(surgeon)
        await surgeon.onExternalEvent(
            source("broker"),
            WorkLeaseGranted.create({
                runId: "run-stale",
                offerId: "offer-new",
                leaseId: "lease-new",
                workerId: "worker",
                generation: 2,
                request: {
                    storyId: "S2",
                    prompt: "recover",
                    model: "standard",
                    retries: 1,
                    timeoutSecs: 60,
                },
            }),
        )

        await surgeon.onExternalEvent(
            source("old-S2"),
            StoryResult.create({
                storyId: "S2",
                success: false,
                attempts: 1,
                durationSecs: 1,
                error: "late old failure",
                runId: "run-stale",
                leaseId: "lease-old",
                generation: 1,
            }),
        )
        await surgeon.idle()

        assert.equal(env.events.filter(Replan.is).length, 0)
        assert.equal(env.events.filter(RecoveryDecision.is).length, 0)
    })

    it("recovers when a successful leased story later fails acceptance quality", async () => {
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
            runId: "run-quality",
            emitRecoveryDecisions: true,
        })
        const env = joinWithCapture(surgeon)
        await grantLease(surgeon, "run-quality", "lease-quality", 1)

        await surgeon.onExternalEvent(
            source("S2"),
            StoryResult.create({
                storyId: "S2",
                success: true,
                attempts: 1,
                durationSecs: 5,
                error: null,
                runId: "run-quality",
                leaseId: "lease-quality",
                generation: 1,
            }),
        )
        assert.equal(env.events.filter(Replan.is).length, 0)

        await surgeon.onExternalEvent(
            source("quality-gate"),
            qualityFailure("run-quality", "lease-quality", 1),
        )
        await surgeon.idle()

        const replan = env.events.find(Replan.is)
        assert.ok(replan)
        assert.match(replan.data.reason, /acceptance quality gate failed: tests missing/)
        assert.deepEqual(
            env.events
                .filter((event) =>
                    RecoveryEvaluationStarted.is(event) ||
                    Replan.is(event) ||
                    RecoveryDecision.is(event),
                )
                .map((event) => event.type),
            ["recovery_evaluation_started", "replan", "recovery_decision"],
        )
    })

    it("ignores stale quality correlation without consuming the active lease", async () => {
        const surgeon = new Surgeon({
            snapshot: () => snapshot,
            useLlm: false,
            runId: "run-quality-stale",
            emitRecoveryDecisions: true,
        })
        const env = joinWithCapture(surgeon)
        await grantLease(surgeon, "run-quality-stale", "lease-current", 2)

        await surgeon.onExternalEvent(
            source("quality-gate"),
            qualityFailure("run-quality-stale", "lease-old", 1),
        )
        assert.equal(env.events.filter(Replan.is).length, 0)

        await surgeon.onExternalEvent(
            source("quality-gate"),
            qualityFailure("run-quality-stale", "lease-current", 2),
        )
        await surgeon.idle()

        assert.equal(env.events.filter(Replan.is).length, 1)
        assert.equal(env.events.filter(RecoveryEvaluationStarted.is).length, 1)
        assert.equal(env.events.filter(RecoveryDecision.is).length, 1)
    })
})

async function grantLease(
    surgeon: Surgeon,
    runId: string,
    leaseId: string,
    generation: number,
): Promise<void> {
    await surgeon.onExternalEvent(
        source("broker"),
        WorkLeaseGranted.create({
            runId,
            offerId: "offer-S2",
            leaseId,
            workerId: "worker",
            generation,
            request: {
                storyId: "S2",
                prompt: "recover",
                model: "standard",
                retries: 1,
                timeoutSecs: 60,
            },
        }),
    )
}

function qualityFailure(
    runId: string,
    leaseId: string,
    generation: number,
): ReturnType<typeof StoryQualityCompleted.create> {
    return StoryQualityCompleted.create({
        runId,
        evaluationId: `${runId}:quality:S2:${generation}`,
        storyId: "S2",
        leaseId,
        generation,
        status: "failed",
        targetTurn: 1,
        reason: "tests missing",
        critique: {
            verdict: "fail",
            reasoning: "tests missing",
            violatedCriteria: ["tests"],
            turn: 1,
            modelUsed: "critic-test",
        },
    })
}

function writeFakeClaude(
    dir: string,
    wrapper: Record<string, unknown>,
): string {
    const json = JSON.stringify(wrapper).replaceAll("'", "'\"'\"'")
    return writeShell(dir, "fake-claude", `printf '%s\\n' '${json}'`)
}

function writeShell(dir: string, name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
}
