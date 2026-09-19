import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { StoryResult } from "../../src/semantic-events.js"
import { StoryAgent } from "../../src/harness/claude/story-agent.js"
import {
    raceWithStoryActivity,
    startStoryActivityGuard,
    wallBoundMs,
} from "../../src/harness/activity-monitor.js"
import {
    activityIdleTimeoutMs,
    StoryAttemptTimeoutError,
} from "../../src/harness/liveness.js"
import { createFakeAwakeClock } from "../../src/runtime/awake-clock.js"
import { ConversationIntake } from "../../src/conversation/session/conversation-intake.js"
import {
    resolveGoalReviewTimeoutMs,
    storyTimeoutSecs,
} from "../../src/orchestrate.js"
import {
    verifyBuild,
    type VerifyCommandSpec,
    type VerifyPlan,
} from "../../src/verification/verify.js"
import { captureEnv, withTempDir } from "../execution/helpers.js"

const IDLE_MS = 200
// A spawned node child can take most of a second just to boot under load, so
// real-subprocess cases scale the same scenario up instead of racing startup.
const PROCESS_IDLE_MS = 1_000

async function withEnv<T>(
    vars: Record<string, string>,
    fn: () => Promise<T>,
): Promise<T> {
    const previous = Object.fromEntries(
        Object.keys(vars).map((key) => [key, process.env[key]]),
    )
    Object.assign(process.env, vars)
    try {
        return await fn()
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

/** Silent on stdout after init; only its file writes (or nothing) show life. */
function writeClaudeFixture(dir: string, writesFiles: boolean): string {
    const bin = join(dir, "claude")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }));
let n = 0;
const timer = setInterval(() => {
  n += 1;
  if (${writesFiles}) writeFileSync(join(process.cwd(), "work-" + n + ".txt"), String(n));
  if (n * 50 >= ${PROCESS_IDLE_MS * 2}) {
    clearInterval(timer);
    console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "s", is_error: false, result: "done" }));
    setTimeout(() => process.exit(0), 20);
  }
}, 50);
process.stdin.resume();
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

async function runClaudeStory(dir: string, writesFiles: boolean) {
    const cwd = join(dir, "cwd")
    mkdirSync(cwd)
    const agent = new StoryAgent({
        id: writesFiles ? "busy-story" : "silent-story",
        prompt: "work",
        cwd,
        claudeBin: writeClaudeFixture(dir, writesFiles),
        retries: 0,
        quietTimeoutMs: 5,
    })
    const env = captureEnv()
    const outcome = await withEnv(
        { BARO_ACTIVITY_IDLE_TIMEOUT_SECS: String(PROCESS_IDLE_MS / 1000) },
        () => agent.run(env),
    )
    return { outcome, event: env.events.find(StoryResult.is) }
}

describe("story activity watchdog", () => {
    it("does not kill a story that keeps writing files for twice the idle window", async () => {
        await withTempDir("activity-busy-", async (dir) => {
            const { outcome } = await runClaudeStory(dir, true)
            assert.equal(outcome.success, true, outcome.error ?? "")
        })
    })

    it("kills a story that shows no activity for the idle window", async () => {
        await withTempDir("activity-silent-", async (dir) => {
            const { outcome, event } = await runClaudeStory(dir, false)
            assert.equal(outcome.success, false)
            assert.match(outcome.error ?? "", /attempt 1 showed no activity for 1s/)
            assert.deepEqual(outcome.failure, {
                kind: "infrastructure",
                code: "command_timeout",
            })
            assert.deepEqual(event?.data.failure, outcome.failure)
        })
    })

    it("counts worktree file changes as activity, ignoring .git", async () => {
        await withTempDir("activity-race-", async (dir) => {
            mkdirSync(join(dir, ".git"))
            let n = 0
            const writer = setInterval(() => {
                n += 1
                writeFileSync(join(dir, `f-${n}`), "x")
            }, 50)
            const busy = raceWithStoryActivity(
                {
                    done: new Promise<string>((resolve) =>
                        setTimeout(() => resolve("finished"), IDLE_MS * 2),
                    ),
                    onActivity: null,
                },
                { cwd: dir, idleMs: IDLE_MS, label: "busy" },
            )
            try {
                assert.equal(await busy, "finished")
            } finally {
                clearInterval(writer)
            }

            const gitOnly = setInterval(() => {
                writeFileSync(join(dir, ".git", "index.lock"), "x")
            }, 50)
            try {
                await assert.rejects(
                    raceWithStoryActivity(
                        { done: new Promise<never>(() => {}), onActivity: null },
                        { cwd: dir, idleMs: IDLE_MS, label: "git only" },
                    ),
                    (error: unknown) =>
                        error instanceof StoryAttemptTimeoutError &&
                        /git only showed no activity/.test(error.message),
                )
            } finally {
                clearInterval(gitOnly)
            }
        })
    })

    it("measures idleness on the awake clock, discounting suspension", () => {
        const clock = createFakeAwakeClock()
        const fired: string[] = []
        const guard = startStoryActivityGuard({
            idleMs: IDLE_MS,
            label: "attempt 1",
            awakeClock: clock,
            onTimeout: (error) => fired.push(error.message),
        })
        clock.advance(150)
        guard.pet()
        clock.advance(150)
        clock.suspend(10_000)
        assert.deepEqual(fired, [])
        clock.advance(50)
        assert.deepEqual(fired, ["attempt 1 showed no activity for 0.2s"])
        clock.advance(10_000)
        assert.equal(fired.length, 1)
    })
})

describe("opt-in per-story --timeout", () => {
    it("is undefined when unset or 0 and passes an explicit value through", () => {
        assert.equal(storyTimeoutSecs(undefined, "high"), undefined)
        assert.equal(storyTimeoutSecs(0, undefined), undefined)
        assert.equal(storyTimeoutSecs(1_800, undefined), 1_800)
        assert.equal(wallBoundMs(undefined), undefined)
        assert.equal(wallBoundMs(0), undefined)
        assert.equal(wallBoundMs(2), 2_000)
        assert.equal(
            resolveGoalReviewTimeoutMs(undefined, undefined),
            activityIdleTimeoutMs(),
        )
    })

    it("adds only an awake-clock wall bound that activity cannot extend", () => {
        const clock = createFakeAwakeClock()
        const fired: string[] = []
        const guard = startStoryActivityGuard({
            idleMs: IDLE_MS,
            wallMs: 300,
            label: "attempt 1",
            awakeClock: clock,
            onTimeout: (error) => fired.push(error.message),
        })
        for (let i = 0; i < 2; i++) {
            clock.advance(100)
            guard.pet()
        }
        clock.suspend(5_000)
        assert.deepEqual(fired, [])
        clock.advance(100)
        assert.deepEqual(fired, ["attempt 1 exceeded its 0.3s timeout"])
    })
})

describe("conversation intake activity watchdog", () => {
    const ready = (requestId: string) =>
        JSON.stringify({
            schemaVersion: 1,
            sessionId: "session-activity",
            requestId,
            kind: "answer",
            message: "Hello.",
            questions: [],
            goalEnvelope: null,
        })

    it("keeps a turn alive while message chunks stream past the idle window", async () => {
        const intake = new ConversationIntake({
            sessionId: "session-activity",
            idleTimeoutMs: IDLE_MS,
            responder: {
                backend: "openai",
                async respond(input, _signal, onActivity) {
                    for (let i = 0; i < 8; i++) {
                        await new Promise((resolve) => setTimeout(resolve, 50))
                        onActivity?.()
                    }
                    return ready(input.requestId)
                },
            },
        })
        const response = await intake.submit({ requestId: "r-1", text: "hi", intent: "chat" })
        assert.equal(response.kind, "answer")
        intake.close()
    })

    it("ends a silent turn after the idle window", async () => {
        let aborted = false
        const intake = new ConversationIntake({
            sessionId: "session-activity",
            idleTimeoutMs: IDLE_MS,
            responder: {
                backend: "openai",
                respond: (_input, signal) =>
                    new Promise((_resolve, reject) => {
                        signal.addEventListener("abort", () => {
                            aborted = true
                            reject(new Error("provider AbortError"))
                        }, { once: true })
                    }),
            },
        })
        await assert.rejects(
            intake.submit({ requestId: "r-2", text: "hi", intent: "chat" }),
            /conversation response produced no activity for 200ms/,
        )
        assert.equal(aborted, true)
        intake.close()
    })
})

describe("verification activity window", () => {
    function nodeCommand(label: string, script: string, cwd: string): VerifyCommandSpec {
        return { label, tool: process.execPath, args: ["-e", script], cwd }
    }

    it("lets a command that streams output outlive the idle window and kills a silent one", async () => {
        await withTempDir("activity-verify-", async (dir) => {
            const repo = join(dir, "repo")
            mkdirSync(repo)
            const streaming = nodeCommand(
                "streaming",
                `let n = 0; const t = setInterval(() => { console.log(n); if (++n >= ${(PROCESS_IDLE_MS * 2) / 50}) clearInterval(t) }, 50)`,
                repo,
            )
            const silent = nodeCommand("silent", "setTimeout(() => {}, 60_000)", repo)
            const result = await withEnv(
                {
                    BARO_HOME: join(dir, "home"),
                    BARO_ACTIVITY_IDLE_TIMEOUT_SECS: String(PROCESS_IDLE_MS / 1000),
                },
                () =>
                    verifyBuild(repo, {
                        emitActivity: () => {},
                        sleep: async () => {},
                        refreshDependencies: false,
                        plan: { commands: [streaming, silent] } as unknown as VerifyPlan,
                    }),
            )
            const byLabel = new Map(result.commands.map((c) => [c.command, c]))
            assert.equal(byLabel.get("streaming")?.status, "passed")
            assert.equal(byLabel.get("silent")?.status, "failed")
            assert.match(
                result.failures.map((f) => f.tail).join("\n"),
                new RegExp(`produced no output for ${PROCESS_IDLE_MS}ms`),
            )
        })
    })
})
