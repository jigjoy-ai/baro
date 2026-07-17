import assert from "node:assert/strict"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

import { AgentState, StoryResult } from "../../src/semantic-events.js"
import { CodexStoryAgent } from "../../src/participants/codex-story-agent.js"
import { OpenCodeStoryAgent } from "../../src/participants/opencode-story-agent.js"
import { PiStoryAgent } from "../../src/participants/pi-story-agent.js"
import { StoryAgent } from "../../src/participants/story-agent.js"
import {
    captureEnv,
    type CapturedEnvironment,
    withTempDir,
} from "./helpers.js"

type Backend = "claude" | "codex" | "opencode" | "pi"
type SuspendableAgent =
    | StoryAgent
    | CodexStoryAgent
    | OpenCodeStoryAgent
    | PiStoryAgent

const backends: readonly Backend[] = ["claude", "codex", "opencode", "pi"]

describe("CLI StoryAgent cooperative suspension", () => {
    for (const backend of backends) {
        it(`${backend} quiesces its child, emits one neutral result, and never retries`, async () => {
            await withTempDir(`baro-${backend}-suspend-`, async (dir) => {
                const fixture = writeBlockingHarness(dir, backend)
                const storyId = `${backend}-suspend-story`
                const blockId = `${storyId}:block:S11`
                const agent = createAgent(
                    backend,
                    storyId,
                    dir,
                    fixture.bin,
                    3,
                )
                const env = captureEnv()
                agent.join(env)
                agent.run(env)

                await waitUntil(() => fixturePid(fixture) !== null, 10_000)
                const pid = fixturePid(fixture)!
                assert.equal(isAlive(pid), true)

                const first = agent.suspend(blockId)
                const replay = agent.suspend(blockId)
                const [outcome, replayed] = await Promise.all([first, replay])

                assert.strictEqual(outcome, replayed)
                assert.equal(outcome.success, false)
                assert.equal(outcome.attempts, 1)
                assert.equal(outcome.error, null)
                assert.deepEqual(outcome.suspension, {
                    kind: "dependency",
                    blockId,
                })
                assert.equal(isAlive(pid), false)

                await delay(50)
                assert.equal(invocationCount(fixture), 1)
                const results = terminalResults(env, storyId)
                assert.equal(results.length, 1)
                assert.equal(results[0]?.data.success, false)
                assert.equal(results[0]?.data.error, null)
                assert.deepEqual(results[0]?.data.suspension, {
                    kind: "dependency",
                    blockId,
                })
                agent.leave(env)
            })
        })

        it(`${backend} external abort cannot launch a retry`, async () => {
            await withTempDir(`baro-${backend}-abort-`, async (dir) => {
                const fixture = writeBlockingHarness(dir, backend)
                const storyId = `${backend}-abort-story`
                const agent = createAgent(
                    backend,
                    storyId,
                    dir,
                    fixture.bin,
                    3,
                )
                const env = captureEnv()
                agent.join(env)
                agent.run(env)

                await waitUntil(() => fixturePid(fixture) !== null, 10_000)
                const pid = fixturePid(fixture)!
                agent.abort()
                const outcome = await agent.done

                assert.equal(outcome.success, false)
                assert.equal(outcome.attempts, 1)
                assert.equal(outcome.suspension, undefined)
                assert.match(outcome.error ?? "", /aborted externally/)
                assert.equal(isAlive(pid), false)

                await delay(50)
                assert.equal(invocationCount(fixture), 1)
                const results = terminalResults(env, storyId)
                assert.equal(results.length, 1)
                assert.equal(results[0]?.data.suspension, undefined)
                agent.leave(env)
            })
        })

        it(`${backend} wakes retry backoff for abort, suspension, and hard timeout`, async () => {
            await withTempDir(`baro-${backend}-retry-wake-`, async (dir) => {
                await assertRetryBackoffWake(backend, dir, "abort")
                await assertRetryBackoffWake(backend, dir, "suspend")
                await assertRetryBackoffWake(backend, dir, "hard-timeout")
            })
        })

        it(`${backend} rejects a suspension without a positive OS quiescence certificate`, async () => {
            await withTempDir(`baro-${backend}-uncertified-`, async (dir) => {
                const storyId = `${backend}-uncertified-suspension`
                const agent = createAgent(backend, storyId, dir, "unused", 0)
                ;(agent as unknown as {
                    processQuiescence: Promise<boolean>
                }).processQuiescence = Promise.resolve(false)

                await assert.rejects(
                    agent.suspend(`block-${storyId}`),
                    /quiescence could not be certified/,
                )
            })
        })
    }
})

interface BlockingHarness {
    bin: string
    pidPath: string
    invocationPath: string
}

function createAgent(
    backend: Backend,
    storyId: string,
    cwd: string,
    bin: string,
    retries: number,
    timing: { retryDelayMs?: number; hardTimeoutSecs?: number } = {},
): SuspendableAgent {
    const common = {
        id: storyId,
        prompt: "wait until Baro suspends this attempt",
        cwd,
        retries,
        retryDelayMs: timing.retryDelayMs ?? 0,
        ...(timing.hardTimeoutSecs === undefined
            ? {}
            : { hardTimeoutSecs: timing.hardTimeoutSecs }),
        timeoutSecs: 30,
    }
    switch (backend) {
        case "claude":
            return new StoryAgent({ ...common, claudeBin: bin })
        case "codex":
            return new CodexStoryAgent({
                ...common,
                codexBin: bin,
                skipGitRepoCheck: true,
            })
        case "opencode":
            return new OpenCodeStoryAgent({ ...common, opencodeBin: bin })
        case "pi":
            return new PiStoryAgent({ ...common, piBin: bin })
    }
}

type RetryWake = "abort" | "suspend" | "hard-timeout"

async function assertRetryBackoffWake(
    backend: Backend,
    cwd: string,
    wake: RetryWake,
): Promise<void> {
    const storyId = `${backend}-${wake}-during-backoff`
    const blockId = `${storyId}:block:S11`
    const agent = createAgent(backend, storyId, cwd, "unused", 3, {
        // A successful wake must settle far below this bound.
        retryDelayMs: 5_000,
        hardTimeoutSecs: wake === "hard-timeout" ? 0.05 : 0,
    })
    let attempts = 0
    ;(agent as unknown as RetryableAttemptAgent).runOneAttempt = async () => {
        attempts += 1
        return {
            success: false,
            summary: null,
            error: "retryable fixture failure",
            failure: { kind: "execution", code: "model_error" },
        }
    }

    const env = captureEnv()
    let waitingSeen = false
    let suspension: Promise<unknown> | null = null
    const hook = new (class extends BaseObserver {
        private fired = false

        override onExternalEvent(
            source: Participant,
            event: SemanticEvent<unknown>,
        ): void {
            if (
                this.fired ||
                source !== agent ||
                !AgentState.is(event) ||
                event.data.agentId !== storyId ||
                event.data.phase !== "waiting"
            ) return
            this.fired = true
            waitingSeen = true
            // Run synchronously inside transition("waiting") to cover the
            // transition→timer lost-wake edge, not merely an ordinary timer.
            if (wake === "abort") agent.abort()
            if (wake === "suspend") suspension = agent.suspend(blockId)
        }
    })()
    hook.join(env)
    agent.join(env)

    try {
        const startedAt = Date.now()
        const outcome = await withDeadline(
            agent.run(env),
            1_000,
            `${backend} ${wake} did not wake retry backoff`,
        )
        assert.equal(waitingSeen, true)
        assert.equal(attempts, 1)
        assert.ok(
            Date.now() - startedAt < 1_000,
            `${backend} ${wake} waited for the configured retry delay`,
        )
        assert.equal(outcome.success, false)
        assert.equal(outcome.attempts, 1)

        if (wake === "abort") {
            assert.match(outcome.error ?? "", /aborted externally/)
            assert.equal(outcome.suspension, undefined)
        } else if (wake === "suspend") {
            assert.equal(outcome.error, null)
            assert.deepEqual(outcome.suspension, {
                kind: "dependency",
                blockId,
            })
            assert.strictEqual(await suspension, outcome)
        } else {
            assert.match(outcome.error ?? "", /hard timeout after 0\.05s/)
            assert.equal(outcome.suspension, undefined)
        }

        await delay(25)
        assert.equal(attempts, 1)
        const results = terminalResults(env, storyId)
        assert.equal(results.length, 1)
        if (wake === "hard-timeout") {
            assert.deepEqual(results[0]?.data.failure, {
                kind: "infrastructure",
                code: "command_timeout",
            })
        }
    } finally {
        agent.leave(env)
        hook.leave(env)
    }
}

interface RetryableAttemptAgent {
    runOneAttempt(attempt: number): Promise<{
        success: false
        summary: null
        error: string
        failure: { kind: "execution"; code: "model_error" }
    }>
}

function writeBlockingHarness(dir: string, backend: Backend): BlockingHarness {
    const bin = join(dir, `${backend}-blocking-harness.mjs`)
    const pidPath = join(dir, `${backend}.pid`)
    const invocationPath = join(dir, `${backend}.invocations`)
    const readyEvent = {
        claude: {
            type: "system",
            subtype: "init",
            session_id: `${backend}-session`,
        },
        codex: {
            type: "thread.started",
            thread_id: `${backend}-thread`,
        },
        opencode: {
            type: "step_start",
            sessionID: `${backend}-session`,
            part: { type: "step-start" },
        },
        pi: { type: "agent_start" },
    }[backend]
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
appendFileSync(${JSON.stringify(invocationPath)}, "attempt\\n");
console.log(${JSON.stringify(JSON.stringify(readyEvent))});
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25));
setInterval(() => {}, 1000);
`,
    )
    chmodSync(bin, 0o755)
    return { bin, pidPath, invocationPath }
}

function terminalResults(env: CapturedEnvironment, storyId: string) {
    return env.events
        .filter(StoryResult.is)
        .filter((event) => event.data.storyId === storyId)
}

function fixturePid(fixture: BlockingHarness): number | null {
    try {
        const pid = Number(readFileSync(fixture.pidPath, "utf8"))
        return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
        return null
    }
}

function invocationCount(fixture: BlockingHarness): number {
    try {
        return readFileSync(fixture.invocationPath, "utf8")
            .split("\n")
            .filter(Boolean).length
    } catch {
        return 0
    }
}

async function waitUntil(
    predicate: () => boolean,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await delay(10)
    }
    assert.fail(`condition not reached within ${timeoutMs}ms`)
}

async function withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs)
            }),
        ])
    } finally {
        if (timer !== null) clearTimeout(timer)
    }
}

function isAlive(pid: number): boolean {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
            const commandEnd = stat.lastIndexOf(")")
            if (
                commandEnd >= 0 &&
                stat.slice(commandEnd + 2, commandEnd + 3) === "Z"
            ) {
                return false
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        }
    }
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
