import assert from "node:assert/strict"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Participant } from "@mozaik-ai/core"

import { PiStoryAgent } from "../../src/participants/pi-story-agent.js"
import { PROCESS_TREE_CAPABILITIES } from "../../src/process-tree.js"
import {
    AgentTurnCompleted,
    Critique,
    StoryResult,
} from "../../src/semantic-events.js"
import { captureEnv, source, withTempDir } from "./helpers.js"

// A freshly-created executable can be held by corporate endpoint scanning for
// several seconds when the complete suite launches many child processes in
// parallel. This is scheduling headroom for semantic fixtures, not timeout
// coverage; the timer is cleared as soon as each local fixture exits.
const FIXTURE_TIMEOUT_SECS = 60

describe("PiStoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Pi backend", async () => {
        await withTempDir("pi-story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const piBin = join(binDir, "pi")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                piBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "session", id: "pi-session" }))
console.log(JSON.stringify({ type: "agent_start" }))
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "write" }))
console.log(JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "write",
  isError: false,
  result: { content: [{ type: "text", text: "ok" }] }
}))
console.log(JSON.stringify({ type: "agent_end", willRetry: false }))
process.exit(0)
`,
            )
            chmodSync(piBin, 0o755)

            const env = captureEnv()
            const agent = new PiStoryAgent({
                id: "story-pi",
                prompt: "finish the story",
                cwd,
                piBin,
                retries: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
            })
            const terminalSources: Participant[] = []
            agent.setTerminalSourceRegistrar((source) => terminalSources.push(source))

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, true)
            assert.equal(outcome.storyId, "story-pi")
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.finalSummary?.sessionId, "pi-session")
            assert.equal(outcome.finalSummary?.sawAgentEnd, true)
            assert.equal(outcome.finalSummary?.toolCallCount, 1)
            assert.equal(outcome.finalSummary?.toolSuccessCount, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-pi")
            assert.equal(event.data.success, true)
            assert.equal(event.data.attempts, 1)
            assert.equal(event.data.error, null)
            assert.equal(terminalSources.length, 1)
            assert.equal(terminalSources[0]?.agentId, "story-pi")
        })
    })

    it(
        "repairs a rejected candidate with a fresh Pi process in the same worktree",
        {
            skip: !PROCESS_TREE_CAPABILITIES
                .cooperativeQuiescenceObservation,
        },
        async () => {
            await withTempDir("pi-story-agent-surgical-", async (dir) => {
                const binDir = join(dir, "bin")
                const cwd = join(dir, "cwd")
                const piBin = join(binDir, "pi")
                const promptLog = join(dir, "prompts.jsonl")
                mkdirSync(binDir)
                mkdirSync(cwd)
                writeFileSync(
                    piBin,
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
console.log(JSON.stringify({ type: "session", id: "pi-session" }))
console.log(JSON.stringify({ type: "agent_start" }))
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "write" }))
console.log(JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "write",
  isError: false,
  result: { content: [{ type: "text", text: "ok" }] }
}))
console.log(JSON.stringify({ type: "agent_end", willRetry: false }))
process.exit(0)
`,
                )
                chmodSync(piBin, 0o755)

                const env = captureEnv()
                const projector = source("projector")
                const critic = source("critic")
                const terminalSources: Array<
                    Participant & { getPhase?(): string }
                > = []
                const originalPrompt =
                    "Implement request cancellation and its race test."
                const agent = new PiStoryAgent({
                    id: "story-pi-surgical",
                    prompt: originalPrompt,
                    cwd,
                    piBin,
                    retries: 0,
                    timeoutSecs: FIXTURE_TIMEOUT_SECS,
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
                        backend: "pi",
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
                        reasoning:
                            "AbortSignal is not forwarded to the request.",
                        violatedCriteria: [
                            "forward the exact request signal",
                        ],
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
                        backend: "pi",
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
                assert.match(
                    prompts[1]?.prompt ?? "",
                    /Original story contract/,
                )
                assert.match(
                    prompts[1]?.prompt ?? "",
                    /AbortSignal is not forwarded/,
                )
                assert.match(
                    prompts[1]?.prompt ?? "",
                    new RegExp(originalPrompt),
                )
            })
        },
    )

    it("emits a failed terminal StoryResult after exhausting Pi retries", async () => {
        await withTempDir("pi-story-agent-retry-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const piBin = join(binDir, "pi")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                piBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "session", id: "pi-session" }))
console.log(JSON.stringify({ type: "agent_start" }))
console.log(JSON.stringify({ type: "agent_end", willRetry: false }))
process.exit(0)
`,
            )
            chmodSync(piBin, 0o755)

            const env = captureEnv()
            const agent = new PiStoryAgent({
                id: "story-pi-retry",
                prompt: "finish the story",
                cwd,
                piBin,
                retries: 1,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
            })

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-pi-retry")
            assert.equal(outcome.attempts, 2)
            assert.match(outcome.error ?? "", /pi exited 0 but invoked no tools/)
            assert.deepEqual(outcome.failure, {
                kind: "execution",
                code: "no_work_product",
            })
            assert.equal(outcome.finalSummary?.sawAgentEnd, true)
            assert.equal(outcome.finalSummary?.toolCallCount, 0)
            assert.equal(outcome.finalSummary?.toolSuccessCount, 0)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-pi-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, outcome.error)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("classifies a bounded stderr authentication diagnostic as infrastructure", async () => {
        await withTempDir("pi-story-agent-auth-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const piBin = join(binDir, "pi")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                piBin,
                `#!/usr/bin/env node
console.error("authentication failed: invalid API key")
process.exit(1)
`,
            )
            chmodSync(piBin, 0o755)

            const env = captureEnv()
            const agent = new PiStoryAgent({
                id: "story-pi-auth",
                prompt: "finish the story",
                cwd,
                piBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.match(outcome.finalSummary?.stderrTail ?? "", /invalid API key/)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "authentication_failed",
            })
            assert.ok(event)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("classifies an explicit missing required tool without treating it as model failure", async () => {
        await withTempDir("pi-story-agent-tool-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const piBin = join(binDir, "pi")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                piBin,
                `#!/usr/bin/env node
console.error("missing required local tool: rg")
process.exit(1)
`,
            )
            chmodSync(piBin, 0o755)

            const env = captureEnv()
            const agent = new PiStoryAgent({
                id: "story-pi-tool",
                prompt: "finish the story",
                cwd,
                piBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "tool_unavailable",
            })
            assert.ok(event)
            assert.deepEqual(event.data.failure, outcome.failure)
        })
    })

    it("settles a missing Pi binary as infrastructure after one attempt", async () => {
        await withTempDir("pi-story-agent-spawn-", async (dir) => {
            const cwd = join(dir, "cwd")
            mkdirSync(cwd)
            const env = captureEnv()
            const agent = new PiStoryAgent({
                id: "story-pi-spawn",
                prompt: "finish the story",
                cwd,
                piBin: join(dir, "missing-pi"),
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: 2,
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
