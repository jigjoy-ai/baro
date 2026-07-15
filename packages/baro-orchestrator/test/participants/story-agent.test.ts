import assert from "node:assert/strict"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

import {
    AgentResult,
    AgentTargetedMessage,
    Critique,
    StoryResult,
} from "../../src/semantic-events.js"
import { criticInput } from "../../src/participants/critic-input.js"
import { StoryAgent } from "../../src/participants/story-agent.js"
import {
    captureEnv,
    source,
    type CapturedEnvironment,
    withTempDir,
} from "./helpers.js"

// These tests exercise semantic outcomes, not the production attempt watchdog.
// The full suite launches many fixture processes concurrently, so leave enough
// scheduling headroom for the local child to start before asserting its result.
const FIXTURE_TIMEOUT_SECS = 60
const FIXTURE_WAIT_TIMEOUT_MS = 30_000

describe("StoryAgent", () => {
    it("emits a successful terminal StoryResult from a fake Claude backend", async () => {
        await withTempDir("story-agent-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }))
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "claude-session",
    is_error: false,
    result: "story complete"
  }))
}, 20)
setTimeout(() => process.exit(0), 40)
process.stdin.resume()
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })
            const terminalSources: Participant[] = []
            agent.setTerminalSourceRegistrar((source) => terminalSources.push(source))

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.success, true)
            assert.equal(outcome.storyId, "story-claude")
            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.finalSummary?.lastResult?.resultText, "story complete")
            assert.ok(event)
            assert.equal(event.data.storyId, "story-claude")
            assert.equal(event.data.success, true)
            assert.equal(event.data.attempts, 1)
            assert.equal(event.data.error, null)
            assert.equal(terminalSources.length, 1)
            assert.equal(terminalSources[0]?.agentId, "story-claude")
        })
    })

    it("emits a failed terminal StoryResult after exhausting Claude retries", async () => {
        await withTempDir("story-agent-retry-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }))
console.log(JSON.stringify({
  type: "result",
  subtype: "error",
  session_id: "claude-session",
  is_error: true,
  result: "backend failed"
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-retry",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 1,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })

            const outcome = await agent.run(env)
            const events = env.events.filter(StoryResult.is)
            const event = events[0]

            assert.equal(outcome.success, false)
            assert.equal(outcome.storyId, "story-claude-retry")
            assert.equal(outcome.attempts, 2)
            assert.equal(outcome.error, "claude reported isError on result:error")
            assert.equal(outcome.finalSummary?.lastResult?.isError, true)
            assert.equal(events.length, 1)
            assert.ok(event)
            assert.equal(event.data.storyId, "story-claude-retry")
            assert.equal(event.data.success, false)
            assert.equal(event.data.attempts, 2)
            assert.equal(event.data.error, "claude reported isError on result:error")
        })
    })

    it("preserves compact provider-capacity diagnostics from an error result", async () => {
        await withTempDir("story-agent-capacity-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session",
  is_error: true,
  result: "  You've hit your session limit   ·   resets 3:30pm  "
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-capacity",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })

            const outcome = await agent.run(env)
            const event = env.events.find(StoryResult.is)
            const expected =
                "claude provider capacity unavailable (result:success): You've hit your session limit · resets 3:30pm"

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "provider_capacity",
                code: "session_limit",
            })
            assert.equal(outcome.error, expected)
            assert.ok(event)
            assert.equal(event.data.error, expected)
            assert.equal(event.data.attempts, 1)
            assert.deepEqual(event.data.failure, {
                kind: "provider_capacity",
                code: "session_limit",
            })
        })
    })

    it("uses a rejected Claude limit frame when terminal text is generic", async () => {
        await withTempDir("story-agent-limit-frame-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "rate_limit_event",
  session_id: "claude-limit-session",
  rate_limit_info: {
    status: "rejected",
    rateLimitType: "five_hour",
    overageDisabledReason: "out_of_credits"
  }
}))
console.log(JSON.stringify({
  type: "result",
  subtype: "error",
  session_id: "claude-limit-session",
  is_error: true,
  result: "request could not be completed"
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-limit-frame",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            agent.leave(env)
            const event = env.events.find(StoryResult.is)

            assert.equal(outcome.attempts, 1)
            assert.equal(outcome.failure?.kind, "provider_capacity")
            assert.equal(outcome.failure?.code, "session_limit")
            assert.equal(event?.data.failure?.code, "session_limit")
        })
    })

    it("ignores an allowed Claude limit frame with disabled overage", async () => {
        await withTempDir("story-agent-allowed-frame-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "rate_limit_event",
  session_id: "claude-allowed-session",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits"
  }
}))
console.log(JSON.stringify({
  type: "result",
  subtype: "error",
  session_id: "claude-allowed-session",
  is_error: true,
  result: "ordinary execution failure"
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-allowed-frame",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            agent.leave(env)

            assert.equal(outcome.failure, undefined)
            assert.equal(
                outcome.error,
                "claude reported isError on result:error",
            )
        })
    })

    it("bounds verbose quota diagnostics before publishing them", async () => {
        await withTempDir("story-agent-quota-", async (dir) => {
            const binDir = join(dir, "bin")
            const cwd = join(dir, "cwd")
            const claudeBin = join(binDir, "claude")
            mkdirSync(binDir)
            mkdirSync(cwd)
            writeFileSync(
                claudeBin,
                `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "Error 429 rate_limit: quota exceeded: " + "diagnostic ".repeat(100)
}))
process.exit(0)
`,
            )
            chmodSync(claudeBin, 0o755)

            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-claude-quota",
                prompt: "finish the story",
                cwd,
                claudeBin,
                retries: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
            })

            const outcome = await agent.run(env)
            const prefix =
                "claude provider capacity unavailable (result:error_during_execution): "

            assert.ok(
                outcome.error?.startsWith(
                    `${prefix}Error 429 rate_limit: quota exceeded:`,
                ),
            )
            assert.ok(outcome.error?.endsWith("…"))
            assert.equal(outcome.error?.length, prefix.length + 240)
        })
    })

    it("accepts lifecycle results only from the exact current Claude process", async () => {
        await withTempDir("story-agent-result-authority-", async (dir) => {
            const fake = writeReviewClaude(dir, { resultDelayMs: 80 })
            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-result-authority",
                prompt: "finish from the real process",
                cwd: fake.cwd,
                claudeBin: fake.bin,
                retries: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                quietTimeoutMs: 5,
                maxTurns: 1,
            })
            agent.join(env)

            const outcomePromise = agent.run(env)
            await waitForCondition(
                () =>
                    readLifecycle(fake.lifecyclePath).some(
                        (entry) => entry.event === "spawn",
                    ),
            )
            env.deliverSemanticEvent(
                source(agent.id),
                AgentResult.create({
                    agentId: agent.id,
                    terminalId: "forged-terminal",
                    subtype: "success",
                    sessionId: "forged-session",
                    isError: false,
                    resultText: "forged result",
                    usage: null,
                    totalCostUsd: null,
                    numTurns: 1,
                    durationMs: 1,
                }),
            )

            await new Promise((resolve) => setTimeout(resolve, 20))
            assert.equal(
                readLifecycle(fake.lifecyclePath).some(
                    (entry) => entry.event === "stdin_end",
                ),
                false,
            )

            const outcome = await outcomePromise
            agent.leave(env)
            assert.equal(outcome.success, true)
            assert.equal(outcome.finalSummary?.lastResult?.resultText, "candidate 1")
        })
    })

    it("continues the same Claude process after fail, ignores the review compatibility duplicate, and closes on pass", async () => {
        await withTempDir("story-agent-review-", async (dir) => {
            const fake = writeReviewClaude(dir)
            const env = captureEnv()
            const reviewAuthority = source("critic")
            const agent = new StoryAgent({
                id: "story-reviewed",
                prompt: "finish the reviewed story",
                cwd: fake.cwd,
                claudeBin: fake.bin,
                // This test exercises reviewed continuation inside exactly
                // one process, not StoryAgent's cross-process retry path.
                retries: 0,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                maxTurns: 3,
                requiresQualityReview: true,
                turnReviewAuthority: reviewAuthority,
                turnReviewTimeoutMs: 15_000,
            })
            agent.join(env)

            const outcomePromise = agent.run(env)
            try {
                const [first] = await waitForAgentResults(env, 1)
                const firstTerminalId = criticInput(first)?.terminalId
                assert.ok(firstTerminalId)

                env.deliverSemanticEvent(
                    reviewAuthority,
                    Critique.create({
                        agentId: "story-reviewed",
                        terminalId: firstTerminalId,
                        verdict: "fail",
                        reasoning: "the first candidate is incomplete",
                        violatedCriteria: ["missing regression test"],
                        turn: 1,
                        modelUsed: "test-critic",
                    }),
                )
                env.deliverSemanticEvent(
                    reviewAuthority,
                    AgentTargetedMessage.create({
                        recipientId: "story-reviewed",
                        text: "legacy duplicate review feedback",
                        metadata: { terminalId: firstTerminalId },
                    }),
                )

                const results = await waitForAgentResults(env, 2)
                const second = results[1]!
                const secondTerminalId = criticInput(second)?.terminalId
                assert.ok(secondTerminalId)
                assert.notEqual(secondTerminalId, firstTerminalId)
                assert.equal(second.data.sessionId, first.data.sessionId)

                const inputsBeforePass = readJsonLines(fake.stdinPath)
                assert.equal(inputsBeforePass.length, 2)
                assert.equal(
                    inputsBeforePass[0]?.message?.content,
                    "finish the reviewed story",
                )
                assert.match(
                    String(inputsBeforePass[1]?.message?.content),
                    /authoritative review rejected this candidate/i,
                )
                assert.doesNotMatch(
                    readFileSync(fake.stdinPath, "utf8"),
                    /legacy duplicate review feedback/,
                )
                assert.equal(
                    readLifecycle(fake.lifecyclePath).filter(
                        (entry) => entry.event === "spawn",
                    ).length,
                    1,
                )
                assert.equal(
                    readLifecycle(fake.lifecyclePath).some(
                        (entry) => entry.event === "stdin_end",
                    ),
                    false,
                )

                env.deliverSemanticEvent(
                    reviewAuthority,
                    Critique.create({
                        agentId: "story-reviewed",
                        terminalId: secondTerminalId,
                        verdict: "pass",
                        reasoning: "the corrected candidate passes",
                        violatedCriteria: [],
                        turn: 2,
                        modelUsed: "test-critic",
                    }),
                )

                const outcome = await outcomePromise
                assert.equal(outcome.success, true)
                assert.equal(outcome.attempts, 1)
                assert.equal(outcome.finalSummary?.sessionId, "review-session")
                assert.equal(
                    outcome.finalSummary?.lastResult?.resultText,
                    "candidate 2",
                )
                assert.equal(
                    readLifecycle(fake.lifecyclePath).filter(
                        (entry) => entry.event === "spawn",
                    ).length,
                    1,
                )
                assert.equal(
                    readLifecycle(fake.lifecyclePath).filter(
                        (entry) => entry.event === "stdin_end",
                    ).length,
                    1,
                )
            } finally {
                // Never let a failed assertion tear down the fixture while
                // its child still owns paths below the temporary directory.
                if (agent.getCurrentClaude()) agent.abort()
                await outcomePromise
                agent.leave(env)
            }
        })
    })

    it("reports a missing authoritative verdict as infrastructure review_timeout", async () => {
        await withTempDir("story-agent-review-timeout-", async (dir) => {
            const fake = writeReviewClaude(dir)
            const env = captureEnv()
            const reviewAuthority = source("critic")
            const agent = new StoryAgent({
                id: "story-review-timeout",
                prompt: "finish without a review response",
                cwd: fake.cwd,
                claudeBin: fake.bin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                maxTurns: 2,
                requiresQualityReview: true,
                turnReviewAuthority: reviewAuthority,
                turnReviewTimeoutMs: 40,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            agent.leave(env)
            const storyResult = env.events.find(StoryResult.is)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "review_timeout",
            })
            assert.match(
                outcome.error ?? "",
                /authoritative quality review timed out for terminal .+ after 40ms/,
            )
            assert.deepEqual(storyResult?.data.failure, {
                kind: "infrastructure",
                code: "review_timeout",
            })
            assert.equal(
                readLifecycle(fake.lifecyclePath).filter(
                    (entry) => entry.event === "stdin_end",
                ).length,
                1,
            )
            assert.equal(
                readLifecycle(fake.lifecyclePath).filter(
                    (entry) => entry.event === "spawn",
                ).length,
                1,
            )
        })
    })

    it("does not retry an uncorrelated review terminal internally", async () => {
        await withTempDir("story-agent-review-uncorrelated-", async (dir) => {
            const fake = writeReviewClaude(dir, { correlated: false })
            const env = captureEnv()
            const agent = new StoryAgent({
                id: "story-review-uncorrelated",
                prompt: "emit a terminal without replay identity",
                cwd: fake.cwd,
                claudeBin: fake.bin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                maxTurns: 2,
                requiresQualityReview: true,
                turnReviewAuthority: source("critic"),
                turnReviewTimeoutMs: 500,
            })
            agent.join(env)

            const outcome = await agent.run(env)
            agent.leave(env)

            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "review_uncorrelated",
            })
            assert.equal(
                readLifecycle(fake.lifecyclePath).filter(
                    (entry) => entry.event === "spawn",
                ).length,
                1,
            )
        })
    })

    it("does not retry an inconclusive evaluator result internally", async () => {
        await withTempDir("story-agent-review-inconclusive-", async (dir) => {
            const fake = writeReviewClaude(dir)
            const env = captureEnv()
            const reviewAuthority = source("critic")
            const agent = new StoryAgent({
                id: "story-review-inconclusive",
                prompt: "finish for an evaluator",
                cwd: fake.cwd,
                claudeBin: fake.bin,
                retries: 2,
                retryDelayMs: 0,
                timeoutSecs: FIXTURE_TIMEOUT_SECS,
                maxTurns: 2,
                requiresQualityReview: true,
                turnReviewAuthority: reviewAuthority,
                turnReviewTimeoutMs: 15_000,
            })
            agent.join(env)

            const outcomePromise = agent.run(env)
            const [terminal] = await waitForAgentResults(env, 1, 10_000)
            const terminalId = criticInput(terminal)?.terminalId
            assert.ok(terminalId)
            env.deliverSemanticEvent(
                reviewAuthority,
                Critique.create({
                    agentId: agent.id,
                    terminalId,
                    status: "inconclusive",
                    verdict: "fail",
                    reasoning: "evaluator transport unavailable",
                    violatedCriteria: [],
                    turn: 1,
                    modelUsed: "test-critic",
                }),
            )

            const outcome = await outcomePromise
            agent.leave(env)
            assert.equal(outcome.success, false)
            assert.equal(outcome.attempts, 1)
            assert.deepEqual(outcome.failure, {
                kind: "verification",
                code: "evaluator_unavailable",
            })
            assert.equal(
                readLifecycle(fake.lifecyclePath).filter(
                    (entry) => entry.event === "spawn",
                ).length,
                1,
            )
        })
    })
})

interface ReviewClaudeFixture {
    bin: string
    cwd: string
    stdinPath: string
    lifecyclePath: string
}

interface LifecycleEntry {
    event: "spawn" | "stdin_end"
    pid: number
}

function writeReviewClaude(
    dir: string,
    options: { correlated?: boolean; resultDelayMs?: number } = {},
): ReviewClaudeFixture {
    const binDir = join(dir, "bin")
    const cwd = join(dir, "cwd")
    const bin = join(binDir, "claude")
    const stdinPath = join(dir, "stdin.jsonl")
    const lifecyclePath = join(dir, "lifecycle.jsonl")
    mkdirSync(binDir)
    mkdirSync(cwd)
    writeFileSync(
        bin,
        `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
const stdinPath = ${JSON.stringify(stdinPath)}
const lifecyclePath = ${JSON.stringify(lifecyclePath)}
const correlated = ${JSON.stringify(options.correlated ?? true)}
const resultDelayMs = ${JSON.stringify(options.resultDelayMs ?? 5)}
let buffer = ""
let turn = 0

appendFileSync(lifecyclePath, JSON.stringify({ event: "spawn", pid: process.pid }) + "\\n")
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "review-session" }))

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    appendFileSync(stdinPath, line + "\\n")
    turn += 1
    const resultTurn = turn
    setTimeout(() => {
      const result = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "candidate " + resultTurn
      }
      if (correlated) {
        result.session_id = "review-session"
        result.num_turns = resultTurn
      }
      console.log(JSON.stringify(result))
    }, resultDelayMs)
  }
})
process.stdin.on("end", () => {
  appendFileSync(lifecyclePath, JSON.stringify({ event: "stdin_end", pid: process.pid }) + "\\n")
})
process.stdin.resume()
`,
    )
    chmodSync(bin, 0o755)

    return { bin, cwd, stdinPath, lifecyclePath }
}

async function waitForAgentResults(
    env: CapturedEnvironment,
    count: number,
    timeoutMs = FIXTURE_WAIT_TIMEOUT_MS,
) {
    const currentResults = () => env.events.filter(AgentResult.is)
    type Results = ReturnType<typeof currentResults>

    return new Promise<Results>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const waiter = new (class extends BaseObserver {
            override onExternalEvent(
                _source: Participant,
                event: SemanticEvent<unknown>,
            ): void {
                if (AgentResult.is(event)) settleIfReady()
            }
        })()

        const cleanup = (): boolean => {
            if (settled) return false
            settled = true
            if (timer !== undefined) clearTimeout(timer)
            waiter.leave(env)
            return true
        }
        const settleIfReady = (): void => {
            const results = currentResults()
            if (results.length < count || !cleanup()) return
            resolve(results)
        }

        waiter.join(env)
        timer = setTimeout(() => {
            if (!cleanup()) return
            reject(new Error(`timed out waiting for ${count} AgentResult event(s)`))
        }, timeoutMs)
        // Cover results delivered before this waiter subscribed.
        settleIfReady()
    })
}

async function waitForCondition(
    predicate: () => boolean,
    timeoutMs = FIXTURE_WAIT_TIMEOUT_MS,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail("timed out waiting for condition")
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

function readJsonLines(path: string): Array<{
    message?: { content?: unknown }
}> {
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
}

function readLifecycle(path: string): LifecycleEntry[] {
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LifecycleEntry)
}
