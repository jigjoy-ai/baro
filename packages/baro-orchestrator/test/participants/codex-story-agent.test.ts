import assert from "node:assert/strict"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "../../src/runtime/mozaik.js"

import { AgentTurnProjector } from "../../src/participants/agent-turn-projector.js"
import { CodexStoryAgent } from "../../src/participants/codex-story-agent.js"
import { PROCESS_TREE_CAPABILITIES } from "../../src/process-tree.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import {
    AgentTurnCompleted,
    CodexTurnEvent,
    Critique,
    StoryResult,
    WorkLeaseGranted,
} from "../../src/semantic-events.js"
import { captureEnv, source, withTempDir } from "./helpers.js"

describe("CodexStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Codex backend", async () => {
        await withTempDir("codex-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "codex-thread" }))
process.exit(0)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 0,
                timeoutSecs: 5,
                skipGitRepoCheck: true,
            })
            const terminalSources: Array<Participant & {
                getPhase?(): string
            }> = []
            agent.setTerminalSourceRegistrar((source) => terminalSources.push(source))

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, true)
            assert.equal(outcome.storyId, "story-codex")
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.finalSummary?.threadId, "codex-thread")
            assert.ok(event)
            assert.equal(event.data.storyId, "story-codex")
            assert.equal(event.data.success, true)
            assert.equal(event.data.attempts, 1)
            assert.equal(event.data.error, null)
            assert.equal(terminalSources.length, 1)
            assert.equal(terminalSources[0]?.agentId, "story-codex")
        })
    })

    it(
        "starts collective review only after the candidate process is quiescent",
        {
            skip: !PROCESS_TREE_CAPABILITIES
                .cooperativeQuiescenceObservation,
        },
        async () => {
            await withTempDir("codex-story-agent-review-barrier-", async (dir) => {
                const binDir = join(dir, "bin")
                const cwd = join(dir, "cwd")
                const codexBin = join(binDir, "codex")
                const candidatePath = join(cwd, "candidate.txt")
                mkdirSync(binDir)
                mkdirSync(cwd)
                writeFileSync(
                    codexBin,
                    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs")
writeFileSync(${JSON.stringify(candidatePath)}, "before terminal\\n")
console.log(JSON.stringify({ type: "thread.started", thread_id: "barrier-thread" }))
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "candidate ready" }
}))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "barrier-thread" }))
setTimeout(() => {
  writeFileSync(${JSON.stringify(candidatePath)}, "final stable bytes\\n")
  process.exit(0)
}, 200)
`,
                )
                chmodSync(codexBin, 0o755)

                const runId = "run-review-barrier"
                const correlation = {
                    runId,
                    storyId: "story-codex-review-barrier",
                    leaseId: "lease-review-barrier",
                    generation: 1,
                }
                const authority = new StoryOutcomeAuthority(runId)
                const projector = new AgentTurnProjector({
                    outcomeAuthority: authority,
                    requireQuiescenceBarrier: true,
                })
                const broker = source("broker")
                projector.setLeaseAuthority(broker)
                const env = captureEnv()
                projector.join(env)

                const evidenceSnapshots: string[] = []
                const critic = new (class extends BaseObserver {
                    override onExternalEvent(
                        sourceParticipant: Participant,
                        event: SemanticEvent<unknown>,
                    ): void {
                        if (
                            sourceParticipant !== projector ||
                            !AgentTurnCompleted.is(event)
                        ) return
                        evidenceSnapshots.push(
                            readFileSync(candidatePath, "utf8"),
                        )
                        env.deliverSemanticEvent(
                            this,
                            Critique.create({
                                agentId: correlation.storyId,
                                terminalId: event.data.terminalId,
                                status: "evaluated",
                                verdict: "pass",
                                reasoning: "stable bytes observed",
                                violatedCriteria: [],
                                turn: 1,
                                modelUsed: "test-critic",
                            }),
                        )
                    }
                })()
                critic.join(env)

                const agent = new CodexStoryAgent({
                    id: correlation.storyId,
                    prompt: "finish the candidate",
                    cwd,
                    codexBin,
                    retries: 0,
                    timeoutSecs: 10,
                    skipGitRepoCheck: true,
                    requiresQualityReview: true,
                    terminalTurnAuthority: projector,
                    turnReviewAuthority: critic,
                    turnReviewTimeoutMs: 5_000,
                    ...correlation,
                })
                authority.registerResultAuthority(correlation, agent)
                agent.setTerminalSourceRegistrar((participant) => {
                    authority.registerTerminalAuthority(
                        correlation,
                        participant,
                    )
                })
                agent.join(env)
                env.deliverSemanticEvent(
                    broker,
                    WorkLeaseGranted.create({
                        runId,
                        offerId: "offer-review-barrier",
                        leaseId: correlation.leaseId,
                        workerId: "worker-review-barrier",
                        generation: correlation.generation,
                        request: {
                            storyId: correlation.storyId,
                            prompt: "finish the candidate",
                            retries: 0,
                            timeoutSecs: 10,
                        },
                    }),
                )

                const outcomePromise = agent.run(env)
                await waitUntil(() =>
                    env.events.some(
                        (event) =>
                            CodexTurnEvent.is(event) &&
                            event.data.phase === "completed",
                    ),
                )
                assert.equal(
                    env.events.filter(AgentTurnCompleted.is).length,
                    0,
                )
                assert.equal(
                    readFileSync(candidatePath, "utf8"),
                    "before terminal\n",
                )

                const outcome = await outcomePromise
                assert.equal(outcome.success, true)
                assert.deepEqual(evidenceSnapshots, ["final stable bytes\n"])
                const terminal = env.events.find(AgentTurnCompleted.is)
                assert.match(terminal?.data.terminalId ?? "", /^quiesced:/)

                agent.leave(env)
                critic.leave(env)
                projector.leave(env)
            })
        },
    )

    it(
        "discards a staged collective terminal when abort wins before attempt finalization",
        {
            skip: !PROCESS_TREE_CAPABILITIES
                .cooperativeQuiescenceObservation,
        },
        async () => {
            await withTempDir("codex-story-agent-abort-barrier-", async (dir) => {
                const binDir = join(dir, "bin")
                const cwd = join(dir, "cwd")
                const codexBin = join(binDir, "codex")
                mkdirSync(binDir)
                mkdirSync(cwd)
                writeFileSync(
                    codexBin,
                    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "abort-thread" }))
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "staged but aborted" }
}))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "abort-thread" }))
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 20))
setInterval(() => {}, 1000)
`,
                )
                chmodSync(codexBin, 0o755)

                const runId = "run-abort-barrier"
                const correlation = {
                    runId,
                    storyId: "story-codex-abort-barrier",
                    leaseId: "lease-abort-barrier",
                    generation: 1,
                }
                const authority = new StoryOutcomeAuthority(runId)
                const projector = new AgentTurnProjector({
                    outcomeAuthority: authority,
                    requireQuiescenceBarrier: true,
                })
                const broker = source("broker")
                projector.setLeaseAuthority(broker)
                const env = captureEnv()
                projector.join(env)
                const critic = source("critic")
                const agent = new CodexStoryAgent({
                    id: correlation.storyId,
                    prompt: "stage then wait",
                    cwd,
                    codexBin,
                    retries: 0,
                    timeoutSecs: 10,
                    skipGitRepoCheck: true,
                    requiresQualityReview: true,
                    terminalTurnAuthority: projector,
                    turnReviewAuthority: critic,
                    turnReviewTimeoutMs: 2_000,
                    ...correlation,
                })
                authority.registerResultAuthority(correlation, agent)
                agent.setTerminalSourceRegistrar((participant) => {
                    authority.registerTerminalAuthority(
                        correlation,
                        participant,
                    )
                })
                agent.join(env)
                env.deliverSemanticEvent(
                    broker,
                    WorkLeaseGranted.create({
                        runId,
                        offerId: "offer-abort-barrier",
                        leaseId: correlation.leaseId,
                        workerId: "worker-abort-barrier",
                        generation: correlation.generation,
                        request: {
                            storyId: correlation.storyId,
                            prompt: "stage then wait",
                            retries: 0,
                            timeoutSecs: 10,
                        },
                    }),
                )

                void agent.run(env)
                await waitUntil(() =>
                    env.events.some(
                        (event) =>
                            CodexTurnEvent.is(event) &&
                            event.data.phase === "completed",
                    ),
                )
                assert.equal(
                    env.events.filter(AgentTurnCompleted.is).length,
                    0,
                )
                agent.abort()
                const outcome = await agent.done

                assert.equal(outcome.success, false)
                assert.match(outcome.error ?? "", /aborted externally/)
                assert.equal(
                    env.events.filter(AgentTurnCompleted.is).length,
                    0,
                )
                agent.leave(env)
                projector.leave(env)
            })
        },
    )

    it(
        "drains an observed detached writer before publishing the one-shot candidate",
        {
            skip: !PROCESS_TREE_CAPABILITIES
                .cooperativeQuiescenceObservation,
        },
        async () => {
            await withTempDir("codex-story-agent-detached-barrier-", async (dir) => {
                const binDir = join(dir, "bin")
                const cwd = join(dir, "cwd")
                const codexBin = join(binDir, "codex")
                const candidatePath = join(cwd, "candidate.txt")
                mkdirSync(binDir)
                mkdirSync(cwd)
                const writerProgram = `
const { writeFileSync } = require("node:fs")
setTimeout(() => writeFileSync(${JSON.stringify(candidatePath)}, "late detached bytes\\n"), 1200)
setInterval(() => {}, 1000)
`
                writeFileSync(
                    codexBin,
                    `#!/usr/bin/env node
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
writeFileSync(${JSON.stringify(candidatePath)}, "stable foreground bytes\\n")
spawn(process.execPath, ["-e", ${JSON.stringify(writerProgram)}], {
  detached: true,
  stdio: "ignore"
})
console.log(JSON.stringify({ type: "thread.started", thread_id: "detached-thread" }))
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "foreground candidate ready" }
}))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "detached-thread" }))
setTimeout(() => process.exit(0), 500)
`,
                )
                chmodSync(codexBin, 0o755)

                const runId = "run-detached-review-barrier"
                const correlation = {
                    runId,
                    storyId: "story-codex-detached-barrier",
                    leaseId: "lease-detached-barrier",
                    generation: 1,
                }
                const authority = new StoryOutcomeAuthority(runId)
                const projector = new AgentTurnProjector({
                    outcomeAuthority: authority,
                    requireQuiescenceBarrier: true,
                })
                const broker = source("broker")
                projector.setLeaseAuthority(broker)
                const env = captureEnv()
                projector.join(env)
                const evidenceSnapshots: string[] = []
                const critic = new (class extends BaseObserver {
                    override onExternalEvent(
                        sourceParticipant: Participant,
                        event: SemanticEvent<unknown>,
                    ): void {
                        if (
                            sourceParticipant !== projector ||
                            !AgentTurnCompleted.is(event)
                        ) return
                        evidenceSnapshots.push(
                            readFileSync(candidatePath, "utf8"),
                        )
                        env.deliverSemanticEvent(
                            this,
                            Critique.create({
                                agentId: correlation.storyId,
                                terminalId: event.data.terminalId,
                                status: "evaluated",
                                verdict: "pass",
                                reasoning: "detached writer was drained",
                                violatedCriteria: [],
                                turn: 1,
                                modelUsed: "test-critic",
                            }),
                        )
                    }
                })()
                critic.join(env)

                const agent = new CodexStoryAgent({
                    id: correlation.storyId,
                    prompt: "finish without background work",
                    cwd,
                    codexBin,
                    retries: 0,
                    timeoutSecs: 10,
                    skipGitRepoCheck: true,
                    requiresQualityReview: true,
                    terminalTurnAuthority: projector,
                    turnReviewAuthority: critic,
                    turnReviewTimeoutMs: 5_000,
                    ...correlation,
                })
                authority.registerResultAuthority(correlation, agent)
                agent.setTerminalSourceRegistrar((participant) => {
                    authority.registerTerminalAuthority(
                        correlation,
                        participant,
                    )
                })
                agent.join(env)
                env.deliverSemanticEvent(
                    broker,
                    WorkLeaseGranted.create({
                        runId,
                        offerId: "offer-detached-barrier",
                        leaseId: correlation.leaseId,
                        workerId: "worker-detached-barrier",
                        generation: correlation.generation,
                        request: {
                            storyId: correlation.storyId,
                            prompt: "finish without background work",
                            retries: 0,
                            timeoutSecs: 10,
                        },
                    }),
                )

                const outcome = await agent.run(env)
                assert.equal(outcome.success, true)
                assert.deepEqual(evidenceSnapshots, [
                    "stable foreground bytes\n",
                ])
                await new Promise((resolve) => setTimeout(resolve, 800))
                assert.equal(
                    readFileSync(candidatePath, "utf8"),
                    "stable foreground bytes\n",
                )

                agent.leave(env)
                critic.leave(env)
                projector.leave(env)
            })
        },
    )

    it("repairs a rejected candidate with a fresh Codex process in the same worktree", {
        skip: !PROCESS_TREE_CAPABILITIES
            .cooperativeQuiescenceObservation,
    }, async () => {
        await withTempDir("codex-story-agent-surgical-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            const promptLog = join(dir, "prompts.jsonl")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const marker = join(process.cwd(), "candidate.txt")
const inheritedCandidate = existsSync(marker)
if (!inheritedCandidate) writeFileSync(marker, "candidate from first process")
appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({
  prompt: process.argv[process.argv.length - 1],
  inheritedCandidate
}) + "\\n")
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "codex-thread" }))
process.exit(0)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const projector = source("projector")
            const critic = source("critic")
            const terminalSources: Participant[] = []
            const originalPrompt = "Implement request cancellation and its race test."
            const agent = new CodexStoryAgent({
                id: "story-codex-surgical",
                prompt: originalPrompt,
                cwd,
                codexBin,
                retries: 0,
                timeoutSecs: 5,
                skipGitRepoCheck: true,
                requiresQualityReview: true,
                terminalTurnAuthority: projector,
                turnReviewAuthority: critic,
                turnReviewTimeoutMs: 2_000,
                maxSurgicalRevisions: 1,
                handoffInconclusiveToAcceptanceGate: true,
            })
            agent.setTerminalSourceRegistrar((participant) => {
                terminalSources.push(
                    participant as Participant & { getPhase?(): string },
                )
            })
            agent.join(env)

            const outcomePromise = agent.run(env)
            await waitUntil(
                () => terminalSources[0]?.getPhase?.() === "done",
            )
            env.deliverSemanticEvent(
                projector,
                AgentTurnCompleted.create({
                    agentId: agent.agentId,
                    terminalId: "terminal-1",
                    backend: "codex",
                    isError: false,
                    resultText: "initial candidate",
                    canContinue: false,
                }),
            )
            env.deliverSemanticEvent(
                critic,
                Critique.create({
                    agentId: agent.agentId,
                    terminalId: "terminal-1",
                    status: "evaluated",
                    verdict: "fail",
                    reasoning: "AbortSignal is not forwarded to the request.",
                    violatedCriteria: ["forward the exact request signal"],
                    turn: 1,
                    modelUsed: "test-critic",
                }),
            )

            await waitUntil(() => terminalSources.length === 2)
            assert.equal(env.events.filter(StoryResult.is).length, 0)
            assert.equal(terminalSources[0]?.getPhase?.(), "done")
            await waitUntil(
                () => terminalSources[1]?.getPhase?.() === "done",
            )
            env.deliverSemanticEvent(
                projector,
                AgentTurnCompleted.create({
                    agentId: agent.agentId,
                    terminalId: "terminal-2",
                    backend: "codex",
                    isError: false,
                    resultText: "repaired candidate",
                    canContinue: false,
                }),
            )
            env.deliverSemanticEvent(
                critic,
                Critique.create({
                    agentId: agent.agentId,
                    terminalId: "terminal-2",
                    status: "evaluated",
                    verdict: "pass",
                    reasoning: "Cancellation is correctly forwarded.",
                    violatedCriteria: [],
                    turn: 2,
                    modelUsed: "test-critic",
                }),
            )

            const outcome = await outcomePromise
            const prompts = readFileSync(promptLog, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as {
                    prompt: string
                    inheritedCandidate: boolean
                })
            assert.equal(outcome.success, true)
            assert.equal(outcome.attempts, 2)
            assert.equal(env.events.filter(StoryResult.is).length, 1)
            assert.deepEqual(
                prompts.map((entry) => entry.inheritedCandidate),
                [false, true],
            )
            assert.equal(prompts[0]?.prompt, originalPrompt)
            assert.match(prompts[1]?.prompt ?? "", /Original story contract/)
            assert.match(prompts[1]?.prompt ?? "", /AbortSignal is not forwarded/)
            assert.match(prompts[1]?.prompt ?? "", new RegExp(originalPrompt))
        })
    })

    it("emits a failed terminal StoryResult after exhausting Codex retries", async () => {
        await withTempDir("codex-story-agent-retry-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
process.exit(1)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-retry",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 1,
                retryDelayMs: 0,
                timeoutSecs: 5,
                skipGitRepoCheck: true,
            })

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-codex-retry")
            assert.equal(outcome.attempts, 2)
            assert.equal(outcome.error, "non-zero exit 1")
            assert.deepEqual(outcome.failure, {
                kind: "execution",
                code: "model_error",
            })
            assert.equal(outcome.finalSummary?.exitCode, 1)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-codex-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, "non-zero exit 1")
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("returns structured provider capacity to Board without spending local retries", async () => {
        await withTempDir("codex-story-agent-capacity-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "capacity-thread" }))
console.log(JSON.stringify({
  type: "error",
  error: { status: 429, code: "rate_limit_exceeded", message: "rate limited" }
}))
process.exit(1)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-capacity",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 5,
                skipGitRepoCheck: true,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "provider_capacity",
                code: "rate_limited",
            })
            assert.ok(event)
            assert.equal(event.data.attempts, 1)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("settles a missing Codex binary as infrastructure after one attempt", async () => {
        await withTempDir("codex-story-agent-spawn-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-spawn",
                prompt: "finish the story",
                cwd,
                codexBin: join(dir, "missing-codex"),
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 2,
                skipGitRepoCheck: true,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.match(outcome.error ?? "", /ENOENT/)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "process_spawn_failed",
            })
            assert.ok(event)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("returns an attempt timeout to Board without retrying locally", async () => {
        await withTempDir("codex-story-agent-timeout-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const codexBin = join(binDir, "codex")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                codexBin,
                `#!/usr/bin/env node
setInterval(() => {}, 1_000)
`,
            )
            chmodSync(codexBin, 0o755)

            const env = captureEnv()
            const agent = new CodexStoryAgent({
                id: "story-codex-timeout",
                prompt: "finish the story",
                cwd,
                codexBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 0.05,
                skipGitRepoCheck: true,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.match(outcome.error ?? "", /attempt 1 timeout/)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "command_timeout",
            })
            assert.ok(event)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it(
        "settles a hard timeout that wins after provider exit but before tree quiescence",
        {
            skip: !PROCESS_TREE_CAPABILITIES
                .cooperativeQuiescenceObservation,
            timeout: 5_000,
        },
        async () => {
            await withTempDir("codex-story-agent-hard-timeout-race-", async (dir) => {
                const cwd = join(dir, "cwd")
                const codexEntry = join(cwd, "exec")
                mkdirSync(cwd)
                writeFileSync(
                    codexEntry,
                    `
const { spawn } = require("node:child_process")
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => process.exit(0), 2500)"
], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
descendant.once("message", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "race-thread" }))
  console.log(JSON.stringify({ type: "turn.completed", thread_id: "race-thread" }))
  process.exit(0)
})
`,
                )

                const env = captureEnv()
                const terminalSources: Array<
                    Participant & { getPhase?(): string }
                > = []
                const agent = new CodexStoryAgent({
                    id: "story-codex-hard-timeout-race",
                    prompt: "finish before the hard deadline",
                    cwd,
                    // Use the already-installed Node executable so endpoint
                    // scanning of a newly chmodded temp binary cannot race the
                    // story timer. Node resolves Codex's first `exec` argument
                    // to the fixture above from cwd.
                    codexBin: process.execPath,
                    retries: 0,
                    timeoutSecs: 4,
                    hardTimeoutSecs: 1,
                    skipGitRepoCheck: true,
                    requiresQualityReview: true,
                    terminalTurnAuthority: source("projector"),
                    turnReviewAuthority: source("critic"),
                    turnReviewTimeoutMs: 4_000,
                    maxSurgicalRevisions: 1,
                    handoffInconclusiveToAcceptanceGate: true,
                })
                agent.setTerminalSourceRegistrar((participant) => {
                    terminalSources.push(
                        participant as Participant & { getPhase?(): string },
                    )
                })
                agent.join(env)

                const outcome = await agent.run(env)
                const events = env.events.filter(StoryResult.is)

                // The direct provider exited successfully; only its owned
                // descendant kept process-tree quiescence pending until after
                // the story-wide hard deadline. The cancelled review candidate
                // must therefore settle as timeout instead of entering
                // reviewNext() and rejecting from a closed candidate mailbox.
                assert.equal(outcome.finalSummary?.exitCode, 0)
                assert.equal(outcome.success, false)
                assert.equal(outcome.attempts, 1)
                assert.equal(outcome.error, "hard timeout after 1s")
                assert.deepEqual(outcome.failure, {
                    kind: "infrastructure",
                    code: "command_timeout",
                })
                assert.equal(terminalSources.length, 1)
                assert.equal(terminalSources[0]?.getPhase?.(), "done")
                assert.equal(events.length, 1)
                assert.deepEqual(events[0]?.data.failure, outcome.failure)
            })
        },
    )

    it(
        "fails closed instead of retrying when owned process quiescence is uncertified",
        {
            skip: !PROCESS_TREE_CAPABILITIES
                .cooperativeQuiescenceObservation,
        },
        async () => {
            await withTempDir("codex-story-agent-quiescence-", async (dir) => {
                const binDir = join(dir, "bin")
                const cwd = join(dir, "cwd")
                const codexBin = join(binDir, "codex")
                mkdirSync(binDir)
                mkdirSync(cwd)
                writeFileSync(
                    codexBin,
                    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "quiescence-thread" }))
console.log(JSON.stringify({ type: "turn.completed", thread_id: "quiescence-thread" }))
process.exit(0)
`,
                )
                chmodSync(codexBin, 0o755)

                const env = captureEnv()
                const agent = new CodexStoryAgent({
                    id: "story-codex-quiescence",
                    prompt: "finish the story",
                    cwd,
                    codexBin,
                    retries: 2,
                    retryDelayMs: 0,
                    timeoutSecs: 5,
                    skipGitRepoCheck: true,
                })
                const internals = agent as unknown as {
                    quiesceCurrentCodex(): Promise<boolean>
                }
                internals.quiesceCurrentCodex = async () => false

                const outcome = await agent.run(env)
                const result = env.events.find(StoryResult.is)

                assert.equal(outcome.success, false)
                assert.equal(outcome.attempts, 1)
                assert.deepEqual(outcome.failure, {
                    kind: "infrastructure",
                    code: "process_quiescence_uncertified",
                })
                assert.match(outcome.error ?? "", /without workspace cleanup/)
                assert.ok(result)
                assert.deepEqual(result.data.failure, outcome.failure)
            })
        },
    )
})

async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("timed out waiting for test condition")
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}
