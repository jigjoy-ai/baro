import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    BaseObserver,
    type AgenticEnvironment,
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

import { orchestrate } from "../src/orchestrate.js"
import type {
    StoryExecution,
    StoryExecOpts,
    StoryExecutor,
} from "../src/participants/story-executor.js"
import type { StoryRoute } from "../src/routing.js"
import {
    AgentResult,
    StoryResult,
    StorySpawnFailed,
    StorySpawned,
    WorkLeaseGranted,
    type StorySpawnRequestData,
    type WorkLeaseGrantedData,
} from "../src/semantic-events.js"
import type { PrdFile } from "../src/prd.js"
import { withTempDir } from "./participants/helpers.js"

class PassingExecutor implements StoryExecutor {
    readonly started: string[] = []

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push(request.storyId)
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)
        setImmediate(() => {
            environment.deliverSemanticEvent(
                resultSource,
                StoryResult.create({
                    storyId: request.storyId,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

class CritiquedPassingExecutor extends PassingExecutor {
    override start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push(request.storyId)
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)
        setImmediate(() => {
            environment.deliverSemanticEvent(
                resultSource,
                AgentResult.create({
                    agentId: request.storyId,
                    terminalId: `custom:${request.storyId}:1`,
                    subtype: "success",
                    sessionId: null,
                    isError: false,
                    resultText: `${request.storyId} implementation and tests completed`,
                    usage: null,
                    totalCostUsd: null,
                    numTurns: 1,
                    durationMs: 1,
                }),
            )
            environment.deliverSemanticEvent(
                resultSource,
                StoryResult.create({
                    storyId: request.storyId,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

class WritingExecutor extends PassingExecutor {
    override start(
        request: StorySpawnRequestData,
        route: StoryRoute,
        cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        writeFileSync(join(cwd, `${request.storyId}.txt`), `${request.storyId} integrated\n`)
        return super.start(request, route, cwd, environment, options)
    }
}

class RouteCapturingExecutor extends PassingExecutor {
    readonly routes: StoryRoute[] = []

    override start(
        request: StorySpawnRequestData,
        route: StoryRoute,
        cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.routes.push(route)
        return super.start(request, route, cwd, environment, options)
    }
}

class FailingExecutor extends PassingExecutor {
    override start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push(request.storyId)
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)
        setImmediate(() => {
            environment.deliverSemanticEvent(
                resultSource,
                StoryResult.create({
                    storyId: request.storyId,
                    success: false,
                    attempts: 1,
                    durationSecs: 1,
                    error: "intentional failure",
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

class SynchronousExecutor extends PassingExecutor {
    override start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push(request.storyId)
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)
        environment.deliverSemanticEvent(
            resultSource,
            StoryResult.create({
                storyId: request.storyId,
                success: true,
                attempts: 1,
                durationSecs: 0,
                error: null,
                runId: request.runId,
                leaseId: request.leaseId,
                generation: request.generation,
            }),
        )
        return { dispose: () => {} }
    }
}

class ConflictRecoveringExecutor implements StoryExecutor {
    readonly started: string[] = []

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push(
            `${request.storyId}:${request.recovery?.kind ?? "initial"}`,
        )
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)

        if (request.storyId === "S1") {
            writeFileSync(join(cwd, "contract.txt"), "S1\n")
        } else if (request.recovery?.kind === "integration") {
            assert.equal(readFileSync(join(cwd, "contract.txt"), "utf8"), "S1\n")
            assert.ok(request.recovery.branch)
            assert.equal(
                git(cwd, ["show", `${request.recovery.branch}:contract.txt`]),
                "S2",
            )
            writeFileSync(join(cwd, "contract.txt"), "S1\nS2\n")
        } else {
            writeFileSync(join(cwd, "contract.txt"), "S2\n")
        }

        const delay = request.storyId === "S2" && !request.recovery ? 40 : 0
        setTimeout(() => {
            environment.deliverSemanticEvent(
                resultSource,
                StoryResult.create({
                    storyId: request.storyId,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        }, delay)
        return { dispose: () => {} }
    }
}

class CapacityRecoveringExecutor implements StoryExecutor {
    readonly started: Array<{ model: string | undefined; recoveryBranch?: string }> = []

    constructor(private readonly alwaysFail = false) {}

    start(
        request: StorySpawnRequestData,
        route: StoryRoute,
        cwd: string,
        environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push({
            model: route.model,
            ...(request.recovery?.branch
                ? { recoveryBranch: request.recovery.branch }
                : {}),
        })
        const resultSource = { agentId: `${request.storyId}:${route.model}` } as never
        options.registerResultAuthority?.(resultSource)

        const capacityFailure =
            this.alwaysFail || route.model === "deepseek-v4-flash"
        if (capacityFailure) {
            writeFileSync(join(cwd, "partial.txt"), "valuable partial\n")
            setImmediate(() => {
                environment.deliverSemanticEvent(
                    resultSource,
                    StoryResult.create({
                        storyId: request.storyId,
                        success: false,
                        attempts: 1,
                        durationSecs: 1,
                        error: "provider capacity unavailable: quota exhausted",
                        failure: {
                            kind: "provider_capacity",
                            code: "quota_exhausted",
                        },
                        runId: request.runId,
                        leaseId: request.leaseId,
                        generation: request.generation,
                    }),
                )
            })
            return { dispose: () => {} }
        }

        assert.ok(request.recovery?.branch)
        assert.equal(
            readFileIfExists(join(cwd, "partial.txt")),
            null,
            "alternate starts from fresh integrated HEAD",
        )
        assert.equal(
            git(cwd, ["show", `${request.recovery.branch}:partial.txt`]),
            "valuable partial",
        )
        writeFileSync(join(cwd, "partial.txt"), "valuable partial\ncompleted by alternate\n")
        setImmediate(() => {
            environment.deliverSemanticEvent(
                resultSource,
                StoryResult.create({
                    storyId: request.storyId,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

/** Attempts the old lease-id-only bypass after the real worker has spawned. */
class ForgingOutcomeObserver extends BaseObserver {
    private readonly leases = new Map<string, WorkLeaseGrantedData>()

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (WorkLeaseGranted.is(event)) {
            this.leases.set(event.data.request.storyId, event.data)
            return
        }
        if (!StorySpawned.is(event)) return
        const lease = this.leases.get(event.data.storyId)
        if (!lease) return
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(
                this,
                StorySpawnFailed.create({
                    runId: lease.runId,
                    offerId: lease.offerId,
                    leaseId: lease.leaseId,
                    storyId: event.data.storyId,
                    error: "forged spawn failure",
                }),
            )
            environment.deliverSemanticEvent(
                this,
                StoryResult.create({
                    storyId: event.data.storyId,
                    success: false,
                    attempts: 99,
                    durationSecs: 0,
                    error: "forged terminal result",
                    runId: lease.runId,
                    leaseId: lease.leaseId,
                    generation: lease.generation,
                }),
            )
        }
    }
}

describe("orchestrate collective mode", () => {
    it("keeps the existing Conductor as the default", async () => {
        await withTempDir("legacy-default-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const auditPath = join(dir, "audit.jsonl")

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor: new PassingExecutor(),
                auditLogPath: auditPath,
            })

            assert.equal(result.summary.success, true)
            const audit = readFileSync(auditPath, "utf8")
            assert.match(audit, /"type":"story_spawn_request"/)
            assert.doesNotMatch(audit, /"type":"work_offered"/)
        })
    })

    it("runs the opt-in collective stack while keeping execution local", async () => {
        await withTempDir("collective-orchestrate-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(testPrd(), null, 2) + "\n")
            const executor = new PassingExecutor()
            const auditPath = join(dir, "audit.jsonl")

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                auditLogPath: auditPath,
            })

            assert.equal(
                result.summary.success,
                true,
                `${JSON.stringify(result.summary)}\n${readFileSync(auditPath, "utf8")}`,
            )
            assert.deepEqual(result.summary.completedStories, ["S1", "S2"])
            assert.equal(result.summary.verificationStatus, "skipped")
            assert.deepEqual(executor.started, ["S1", "S2"])
            const saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(saved.userStories.every((story) => story.passes), true)
            const audit = readFileSync(auditPath, "utf8")
            assert.match(audit, /"type":"run_verification_requested"/)
            assert.match(audit, /"type":"run_verification_completed"/)
        })
    })

    it("keeps the legacy fallback when a programmatic tier map has no default lane", async () => {
        await withTempDir("collective-tier-fallback-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            delete input.userStories[0]!.model
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const executor = new RouteCapturingExecutor()

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                llm: "claude",
                tierMap: { standard: "openai:deepseek-v4-flash" },
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
            })

            assert.equal(result.summary.success, true)
            assert.deepEqual(executor.routes, [
                { backend: "claude", model: "opus" },
            ])
        })
    })

    for (const defaultKey of ["default", "*"] as const) {
        it(`uses an explicit ${defaultKey} lane from a programmatic tier map`, async () => {
            await withTempDir(
                `collective-tier-${defaultKey === "*" ? "star" : defaultKey}-`,
                async (dir) => {
                    const prdPath = join(dir, "prd.json")
                    const input = testPrd()
                    input.userStories = [input.userStories[0]!]
                    delete input.userStories[0]!.model
                    writeFileSync(
                        prdPath,
                        JSON.stringify(input, null, 2) + "\n",
                    )
                    const executor = new RouteCapturingExecutor()

                    const result = await orchestrate({
                        prdPath,
                        cwd: dir,
                        coordinationMode: "collective",
                        llm: "claude",
                        tierMap: {
                            [defaultKey]: "openai:deepseek-v4-flash",
                            heavy: "openai:deepseek-v4-pro",
                        },
                        publishRemote: false,
                        withGit: false,
                        emitTuiEvents: false,
                        withLibrarian: false,
                        withMemory: false,
                        withSentry: false,
                        withCritic: false,
                        withSurgeon: false,
                        withSupervisor: false,
                        intraLevelDelaySecs: 0,
                        executor,
                    })

                    assert.equal(result.summary.success, true)
                    assert.deepEqual(executor.routes, [
                        { backend: "openai", model: "deepseek-v4-flash" },
                    ])
                },
            )
        })
    }

    it("rejects forged terminal events even when every lease field is correct", async () => {
        await withTempDir("collective-outcome-authority-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const auditPath = join(dir, "audit.jsonl")

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: true,
                surgeonUseLlm: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor: new PassingExecutor(),
                extraParticipants: [new ForgingOutcomeObserver()],
                auditLogPath: auditPath,
            })

            const audit = readFileSync(auditPath, "utf8")
            assert.equal(
                result.summary.success,
                true,
                `${JSON.stringify(result.summary)}\n${audit}`,
            )
            assert.deepEqual(result.summary.completedStories, ["S1"])
            assert.doesNotMatch(audit, /"type":"recovery_evaluation_started"/)
        })
    })

    it("does not let a hanging DialogueAgent delay collective completion", async () => {
        await withTempDir("collective-dialogue-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const auditPath = join(dir, "audit.jsonl")
            let calls = 0
            let aborted = false

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                withDialogue: true,
                dialogueResponder: (_input, signal) => {
                    calls += 1
                    return new Promise((_resolve, reject) => {
                        signal.addEventListener("abort", () => {
                            aborted = true
                            reject(new Error("aborted"))
                        }, { once: true })
                    })
                },
                onOperatorReady: (operator) => operator.dispatch({
                    kind: "converse",
                    message: "Give me a status update",
                    messageId: "e2e-dialogue-message",
                    source: "user",
                }),
                intraLevelDelaySecs: 0,
                executor: new PassingExecutor(),
                auditLogPath: auditPath,
            })

            assert.equal(result.summary.success, true)
            assert.equal(calls, 1)
            assert.equal(aborted, true)
            const audit = readFileSync(auditPath, "utf8")
            assert.match(audit, /"type":"conversation_requested"/)
            assert.doesNotMatch(audit, /"type":"conversation_responded"/)
        })
    })

    it("does not integrate a collective story until its correlated Critic verdict passes", async () => {
        await withTempDir("collective-quality-e2e-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const auditPath = join(dir, "audit.jsonl")
            const fakeBin = join(dir, "claude")
            writeFileSync(
                fakeBin,
                "#!/bin/sh\n" +
                    "printf '%s' '{\"result\":\"{\\\"verdict\\\":\\\"pass\\\",\\\"reasoning\\\":\\\"criteria satisfied\\\",\\\"violated_criteria\\\":[]}\"}'\n",
            )
            chmodSync(fakeBin, 0o755)
            const oldPath = process.env.PATH
            process.env.PATH = `${dir}:${oldPath ?? ""}`
            try {
                const result = await orchestrate({
                    prdPath,
                    cwd: dir,
                    coordinationMode: "collective",
                    publishRemote: false,
                    withGit: false,
                    emitTuiEvents: false,
                    withLibrarian: false,
                    withMemory: false,
                    withSentry: false,
                    withCritic: true,
                    criticLlm: "claude",
                    withSurgeon: false,
                    withSupervisor: false,
                    collectiveAcceptanceTimeoutMs: 15_000,
                    intraLevelDelaySecs: 0,
                    executor: new CritiquedPassingExecutor(),
                    auditLogPath: auditPath,
                })

                const audit = readFileSync(auditPath, "utf8")
                assert.equal(
                    result.summary.success,
                    true,
                    `${JSON.stringify(result.summary)}\n${audit}`,
                )
                const resultAt = audit.indexOf('"type":"story_result"')
                const qualityAt = audit.indexOf('"type":"story_quality_completed"')
                const integrationAt = audit.indexOf('"type":"story_integration_requested"')
                assert.ok(resultAt >= 0)
                assert.ok(qualityAt > resultAt)
                assert.ok(integrationAt > qualityAt)
            } finally {
                process.env.PATH = oldPath
            }
        })
    })

    it("cannot finish green when the integrated target fails its real test command", async () => {
        await withTempDir("collective-verify-e2e-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "failing-target",
                    scripts: { test: "node -e \"process.exit(1)\"" },
                }),
            )
            const auditPath = join(dir, "audit.jsonl")

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor: new PassingExecutor(),
                auditLogPath: auditPath,
            })

            assert.equal(result.summary.success, false)
            assert.equal(result.summary.verificationStatus, "failed")
            assert.equal(result.summary.verification?.commands[0]?.status, "failed")
            assert.match(result.summary.abortReason ?? "", /npm run test/)

            const audit = readFileSync(auditPath, "utf8")
            const requested = audit.indexOf('"type":"run_verification_requested"')
            const completed = audit.indexOf('"type":"run_verification_completed"')
            const pushed = audit.indexOf('"type":"run_push_requested"')
            const done = audit.indexOf('"type":"run_completed"')
            assert.ok(requested >= 0)
            assert.ok(completed > requested)
            assert.ok(pushed > completed)
            assert.ok(done > pushed)
        })
    })

    it("runs an opt-in worker auction and executes only the deterministic winner", async () => {
        await withTempDir("collective-market-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const auditPath = join(dir, "audit.jsonl")
            const executor = new RouteCapturingExecutor()

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                collectiveBidWindowMs: 5,
                collectiveWorkers: [
                    {
                        workerId: "expensive-first",
                        routeId: "frontier",
                        route: "openai:gpt-frontier",
                        estimate: {
                            expectedCostUsd: 1,
                            estimatedSuccessProbability: 0.9,
                            estimatedLatencyMs: 100,
                            estimateSource: "configured",
                        },
                    },
                    {
                        workerId: "cheap-second",
                        routeId: "deepseek",
                        route: "openai:deepseek-v4-flash",
                        estimate: {
                            expectedCostUsd: 0.1,
                            estimatedSuccessProbability: 0.8,
                            estimatedLatencyMs: 200,
                            estimateSource: "configured",
                        },
                    },
                ],
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                auditLogPath: auditPath,
            })

            assert.equal(result.summary.success, true)
            assert.equal(executor.routes.length, 1)
            assert.deepEqual(executor.routes[0], {
                backend: "openai",
                model: "deepseek-v4-flash",
            })
            const audit = readFileSync(auditPath, "utf8")
            assert.equal((audit.match(/"type":"work_bid"/g) ?? []).length, 2)
            assert.equal((audit.match(/"type":"work_claimed"/g) ?? []).length, 1)
            assert.match(audit, /"workerId":"cheap-second"/)
            assert.match(audit, /"routeId":"deepseek"/)
        })
    })

    it("routes an unset story model to the market default lane instead of heavy", async () => {
        await withTempDir("collective-market-default-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            delete input.userStories[0]!.model
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const auditPath = join(dir, "audit.jsonl")
            const executor = new RouteCapturingExecutor()

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                collectiveBidWindowMs: 5,
                collectiveWorkers: [
                    {
                        workerId: "flash-worker",
                        routeId: "flash",
                        route: "openai:deepseek-v4-flash",
                        tiers: ["default", "light", "standard"],
                        estimate: {
                            expectedCostUsd: 0.1,
                            estimatedSuccessProbability: 0.8,
                            estimatedLatencyMs: 20,
                            estimateSource: "configured",
                        },
                    },
                    {
                        workerId: "pro-worker",
                        routeId: "pro",
                        route: "openai:deepseek-v4-pro",
                        tiers: ["heavy"],
                        estimate: {
                            expectedCostUsd: 0.01,
                            estimatedSuccessProbability: 0.99,
                            estimatedLatencyMs: 10,
                            estimateSource: "configured",
                        },
                    },
                ],
                publishRemote: false,
                withGit: false,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                auditLogPath: auditPath,
            })

            assert.equal(result.summary.success, true)
            assert.deepEqual(executor.routes, [
                { backend: "openai", model: "deepseek-v4-flash" },
            ])
            const audit = readFileSync(auditPath, "utf8")
            const bids = audit
                .split("\n")
                .filter((line) => line.includes('"type":"work_bid"'))
            assert.equal(bids.length, 1)
            assert.match(bids[0]!, /"workerId":"flash-worker"/)
        })
    })

    it("checkpoints partial capacity work and reroutes it to the next eligible market worker", async () => {
        await withTempDir("collective-capacity-e2e-", async (dir) => {
            git(dir, ["init", "-b", "main"])
            git(dir, ["config", "user.name", "Capacity Test"])
            git(dir, ["config", "user.email", "capacity@test.invalid"])
            writeFileSync(join(dir, "README.md"), "base\n")
            git(dir, ["add", "README.md"])
            git(dir, ["commit", "-m", "base"])

            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            const prdPath = join(dir, "prd.json")
            const auditPath = join(dir, "audit.jsonl")
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const executor = new CapacityRecoveringExecutor()

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                collectiveBidWindowMs: 5,
                collectiveWorkers: [
                    {
                        workerId: "deepseek-worker",
                        routeId: "deepseek-route",
                        route: "openai:deepseek-v4-flash",
                        estimate: {
                            expectedCostUsd: 0.1,
                            estimatedSuccessProbability: 0.9,
                            estimatedLatencyMs: 10,
                            estimateSource: "configured",
                        },
                    },
                    {
                        workerId: "glm-worker",
                        routeId: "glm-route",
                        route: "openai:glm-5.2",
                        estimate: {
                            expectedCostUsd: 0.2,
                            estimatedSuccessProbability: 0.9,
                            estimatedLatencyMs: 20,
                            estimateSource: "configured",
                        },
                    },
                ],
                publishRemote: false,
                withGit: true,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: true,
                surgeonUseLlm: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                auditLogPath: auditPath,
            })

            const audit = readFileSync(auditPath, "utf8")
            assert.equal(
                result.summary.success,
                true,
                `${JSON.stringify(result.summary)}\n${audit}`,
            )
            assert.deepEqual(
                executor.started.map((item) => item.model),
                ["deepseek-v4-flash", "glm-5.2"],
            )
            assert.ok(executor.started[1]?.recoveryBranch)
            assert.equal(
                readFileSync(join(dir, "partial.txt"), "utf8"),
                "valuable partial\ncompleted by alternate\n",
            )
            assert.notEqual(git(dir, ["branch", "--list", "baro-recovery/*"]), "")
            assert.match(audit, /"excludedRouteIds":\["deepseek-route"\]/)
            assert.doesNotMatch(audit, /"type":"recovery_evaluation_started"/)
        })
    })

    it("checkpoints and stops after one capacity attempt when no market alternate exists", async () => {
        await withTempDir("collective-capacity-single-e2e-", async (dir) => {
            git(dir, ["init", "-b", "main"])
            git(dir, ["config", "user.name", "Capacity Test"])
            git(dir, ["config", "user.email", "capacity@test.invalid"])
            writeFileSync(join(dir, "README.md"), "base\n")
            git(dir, ["add", "README.md"])
            git(dir, ["commit", "-m", "base"])

            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            const prdPath = join(dir, "prd.json")
            const auditPath = join(dir, "audit.jsonl")
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const executor = new CapacityRecoveringExecutor(true)

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: true,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: true,
                surgeonUseLlm: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                auditLogPath: auditPath,
            })

            const audit = readFileSync(auditPath, "utf8")
            assert.equal(result.summary.success, false)
            assert.equal(executor.started.length, 1)
            assert.notEqual(git(dir, ["branch", "--list", "baro-recovery/*"]), "")
            assert.equal((audit.match(/"type":"work_offered"/g) ?? []).length, 1)
            assert.doesNotMatch(audit, /"type":"recovery_evaluation_started"/)
        })
    })

    it("orders a synchronous executor result after its lease grant", async () => {
        await withTempDir("collective-sync-result-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")

            const result = await Promise.race([
                orchestrate({
                    prdPath,
                    cwd: dir,
                    coordinationMode: "collective",
                    publishRemote: false,
                    withGit: false,
                    emitTuiEvents: false,
                    withLibrarian: false,
                    withMemory: false,
                    withSentry: false,
                    withCritic: false,
                    withSurgeon: false,
                    withSupervisor: false,
                    intraLevelDelaySecs: 0,
                    executor: new SynchronousExecutor(),
                }),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("synchronous result was lost")), 2_000),
                ),
            ])

            assert.equal(result.summary.success, true)
            assert.deepEqual(result.summary.completedStories, ["S1"])
        })
    })

    it("merges isolated story work through repository events without a remote", async () => {
        await withTempDir("collective-git-", async (dir) => {
            git(dir, ["init", "-b", "main"])
            git(dir, ["config", "user.name", "Collective Test"])
            git(dir, ["config", "user.email", "collective@test.invalid"])
            writeFileSync(join(dir, "README.md"), "base\n")
            git(dir, ["add", "README.md"])
            git(dir, ["commit", "-m", "base"])
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(testPrd(), null, 2) + "\n")

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: true,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor: new WritingExecutor(),
            })

            assert.equal(result.summary.success, true)
            assert.equal(readFileSync(join(dir, "S1.txt"), "utf8"), "S1 integrated\n")
            assert.equal(readFileSync(join(dir, "S2.txt"), "utf8"), "S2 integrated\n")
            assert.match(git(dir, ["log", "--oneline", "-5"]), /merge story S2/)
            assert.equal(git(dir, ["remote"]), "")
        })
    })

    it("recovers a same-wave merge conflict through a fresh collective lease", async () => {
        await withTempDir("collective-conflict-recovery-", async (dir) => {
            git(dir, ["init", "-b", "main"])
            git(dir, ["config", "user.name", "Collective Test"])
            git(dir, ["config", "user.email", "collective@test.invalid"])
            writeFileSync(join(dir, "contract.txt"), "base\n")
            git(dir, ["add", "contract.txt"])
            git(dir, ["commit", "-m", "base"])

            const input = testPrd()
            input.userStories = [story("S1", []), story("S2", [])]
            const prdPath = join(dir, "prd.json")
            const auditPath = join(dir, "audit.jsonl")
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const executor = new ConflictRecoveringExecutor()

            const result = await orchestrate({
                prdPath,
                cwd: dir,
                coordinationMode: "collective",
                publishRemote: false,
                withGit: true,
                emitTuiEvents: false,
                withLibrarian: false,
                withMemory: false,
                withSentry: false,
                withCritic: false,
                withSurgeon: false,
                withSupervisor: false,
                intraLevelDelaySecs: 0,
                executor,
                auditLogPath: auditPath,
            })

            assert.equal(
                result.summary.success,
                true,
                `${JSON.stringify(result.summary)}\n${readFileSync(auditPath, "utf8")}`,
            )
            assert.equal(result.summary.totalAttempts, 3)
            assert.equal(readFileSync(join(dir, "contract.txt"), "utf8"), "S1\nS2\n")
            assert.deepEqual(executor.started, [
                "S1:initial",
                "S2:initial",
                "S2:integration",
            ])
            const audit = readFileSync(auditPath, "utf8")
            assert.match(audit, /"type":"story_merge_failed"/)
            assert.match(audit, /"type":"recovery_started"/)
            assert.notEqual(
                git(dir, ["branch", "--list", "baro-recovery/*"]),
                "",
                "the rejected attempt remains auditable",
            )
        })
    })

    it("settles when the Surgeon decides before the Board receives a failed result", async () => {
        await withTempDir("collective-surgeon-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            const input = testPrd()
            input.userStories = [input.userStories[0]!]
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const executor = new FailingExecutor()

            const result = await Promise.race([
                orchestrate({
                    prdPath,
                    cwd: dir,
                    coordinationMode: "collective",
                    publishRemote: false,
                    withGit: false,
                    emitTuiEvents: false,
                    withLibrarian: false,
                    withMemory: false,
                    withSentry: false,
                    withCritic: false,
                    withSurgeon: true,
                    surgeonUseLlm: false,
                    withSupervisor: false,
                    intraLevelDelaySecs: 0,
                    executor,
                }),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("collective run deadlocked")), 2_000),
                ),
            ])

            assert.equal(result.summary.success, false)
            assert.deepEqual(result.summary.failedStories, ["S1"])
            assert.deepEqual(executor.started, ["S1", "S1"])
        })
    })

    it("does not publish the run branch in local-only mode", async () => {
        for (const coordinationMode of ["legacy", "collective"] as const) {
            await withTempDir(`local-only-${coordinationMode}-`, async (dir) => {
                const origin = mkdtempSync(join(tmpdir(), "baro-local-origin-"))
                try {
                    git(origin, ["init", "--bare"])
                    git(dir, ["init", "-b", "main"])
                    git(dir, ["config", "user.name", "Local Only Test"])
                    git(dir, ["config", "user.email", "local@test.invalid"])
                    writeFileSync(join(dir, "README.md"), "base\n")
                    git(dir, ["add", "README.md"])
                    git(dir, ["commit", "-m", "base"])
                    git(dir, ["remote", "add", "origin", origin])
                    const prdPath = join(dir, "prd.json")
                    const input = testPrd()
                    input.userStories = [input.userStories[0]!]
                    writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")

                    const result = await orchestrate({
                        prdPath,
                        cwd: dir,
                        coordinationMode,
                        publishRemote: false,
                        withGit: true,
                        emitTuiEvents: false,
                        withLibrarian: false,
                        withMemory: false,
                        withSentry: false,
                        withCritic: false,
                        withSurgeon: false,
                        withSupervisor: false,
                        intraLevelDelaySecs: 0,
                        executor: new WritingExecutor(),
                    })

                    assert.equal(result.summary.success, true)
                    assert.equal(git(dir, ["branch", "--show-current"]), input.branchName)
                    assert.equal(git(origin, ["for-each-ref", "--format=%(refname)"]), "")
                } finally {
                    rmSync(origin, { recursive: true, force: true })
                }
            })
        }
    })
})

function testPrd(): PrdFile {
    return {
        project: "Collective e2e",
        branchName: "baro/collective-e2e",
        description: "exercise the collective stack",
        userStories: [
            story("S1", []),
            story("S2", ["S1"]),
        ],
    }
}

function story(id: string, dependsOn: string[]): PrdFile["userStories"][number] {
    return {
        id,
        priority: Number(id.slice(1)),
        title: id,
        description: `Implement ${id}`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
    }
}

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function readFileIfExists(path: string): string | null {
    try {
        return readFileSync(path, "utf8")
    } catch {
        return null
    }
}
