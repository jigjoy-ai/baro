import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { BaroEvent } from "../../src/tui-protocol.js"
import {
    ABSOLUTE_COMMAND_TIMEOUT_MS,
    commandCeilingMs,
    commandKey,
    createCeilingResolver,
    loadTimings,
    recordTiming,
    timingsFile,
} from "../../src/verification/command-timing.js"
import {
    recommendedVerifyTimeoutMs,
    verifyBuild,
    type VerifyCommandSpec,
    type VerifyPlan,
} from "../../src/verification/verify.js"
import { withTempDir } from "../execution/helpers.js"

async function withBaroHome(fn: (repo: string) => Promise<void>): Promise<void> {
    await withTempDir("baro-command-timing-", async (dir) => {
        const previous = process.env.BARO_HOME
        process.env.BARO_HOME = join(dir, "home")
        const repo = join(dir, "repo")
        mkdirSync(repo)
        try {
            await fn(repo)
        } finally {
            if (previous === undefined) delete process.env.BARO_HOME
            else process.env.BARO_HOME = previous
        }
    })
}

function planOf(...commands: VerifyCommandSpec[]): VerifyPlan {
    return { commands } as VerifyPlan
}

function nodeCommand(label: string, script: string, cwd: string): VerifyCommandSpec {
    return { label, tool: process.execPath, args: ["-e", script], cwd }
}

function attempts(log: string): number {
    return existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0
}

describe("commandCeilingMs", () => {
    it("prefers the declaration, then twice the measurement, never below the floor", () => {
        assert.equal(
            commandCeilingMs({ declaredSecs: 1_800, lastMs: 20 * 60_000 }),
            1_800_000,
        )
        assert.equal(commandCeilingMs({ lastMs: 8 * 60_000 }), 16 * 60_000)
        assert.equal(commandCeilingMs({}), ABSOLUTE_COMMAND_TIMEOUT_MS)
        assert.equal(commandCeilingMs({ declaredSecs: 5 }), ABSOLUTE_COMMAND_TIMEOUT_MS)
        assert.equal(commandCeilingMs({ lastMs: 1_000 }), ABSOLUTE_COMMAND_TIMEOUT_MS)
    })

    it("derives each command's ceiling from package.json and ~/.baro timings", async () => {
        await withBaroHome(async (repo) => {
            writeFileSync(
                join(repo, "package.json"),
                JSON.stringify({
                    baro: { verification: { commandTimeoutsSecs: { "npm run test": 1_500 } } },
                }),
            )
            const declared = { label: "npm run test", tool: "npm", args: ["run", "test"] }
            const measured = { label: "npm run build", tool: "npm", args: ["run", "build"] }
            const unknown = { label: "npm run lint", tool: "npm", args: ["run", "lint"] }
            recordTiming(repo, commandKey(declared, repo), 30 * 60_000)
            recordTiming(repo, commandKey(measured, repo), 7 * 60_000)

            assert.ok(timingsFile().startsWith(process.env.BARO_HOME!))
            const resolve = createCeilingResolver(repo, repo)
            assert.equal(resolve(declared).ceilingMs, 1_500_000)
            assert.equal(resolve(measured).ceilingMs, 14 * 60_000)
            assert.equal(resolve(measured).lastMs, 7 * 60_000)
            assert.equal(resolve(unknown).ceilingMs, ABSOLUTE_COMMAND_TIMEOUT_MS)
            assert.equal(resolve(unknown).lastMs, undefined)

            const plan = planOf({ ...measured, origin: "declared" })
            assert.equal(
                recommendedVerifyTimeoutMs(plan, { cwd: repo }) -
                    recommendedVerifyTimeoutMs(plan),
                14 * 60_000 - ABSOLUTE_COMMAND_TIMEOUT_MS,
            )
        })
    })

    it("records a command's duration only when it succeeds", async () => {
        await withBaroHome(async (repo) => {
            const passing = nodeCommand("pass", "process.exit(0)", repo)
            const failing = nodeCommand("fail", "process.exit(1)", repo)
            const result = await verifyBuild(repo, {
                emitActivity: () => {},
                sleep: async () => {},
                refreshDependencies: false,
                plan: planOf(passing, failing),
            })

            assert.equal(result.ok, false)
            const timings = loadTimings(repo)
            assert.equal(typeof timings[commandKey(passing, repo)]?.lastMs, "number")
            assert.equal(timings[commandKey(failing, repo)], undefined)
        })
    })
})

describe("verification timeout retry policy", () => {
    async function runTimeout(
        executorsActive: boolean,
    ): Promise<{ attempts: number; events: BaroEvent[]; result: Awaited<ReturnType<typeof verifyBuild>> }> {
        let out!: { attempts: number; events: BaroEvent[]; result: Awaited<ReturnType<typeof verifyBuild>> }
        await withBaroHome(async (repo) => {
            const log = join(repo, "attempts")
            const command = nodeCommand(
                "slow gate",
                `require('fs').appendFileSync(${JSON.stringify(log)}, 'x\\n'); setTimeout(() => {}, 60_000)`,
                repo,
            )
            recordTiming(repo, commandKey(command, repo), 600)
            const events: BaroEvent[] = []
            const result = await verifyBuild(repo, {
                emitActivity: (event) => void events.push(event),
                sleep: async () => {},
                refreshDependencies: false,
                ceilingFloorMs: 1_000,
                storyExecutorsActive: () => executorsActive,
                plan: planOf(command),
            })
            out = { attempts: attempts(log), events, result }
        })
        return out
    }

    function timeoutWarnings(events: BaroEvent[]): string[] {
        return events
            .map((event) => (event as { text?: string }).text ?? "")
            .filter((text) => text.startsWith("verification timeout:"))
    }

    it("does not retry a timeout while story executors are running", async () => {
        const { attempts: count, events, result } = await runTimeout(true)

        assert.equal(count, 1)
        assert.equal(result.ok, false)
        const command = result.commands[0]!
        assert.equal(command.status, "failed")
        assert.equal(command.timedOut, true)
        assert.equal(command.retryable, false)
        assert.equal(command.retriedAfterFailure, undefined)
        assert.deepEqual(timeoutWarnings(events), [
            "verification timeout: slow gate hit ceiling 1s (last measured 1s)",
        ])
    })

    it("retries a timeout once when no story executor is running", async () => {
        const { attempts: count, events, result } = await runTimeout(false)

        assert.equal(count, 2)
        const command = result.commands[0]!
        assert.equal(command.status, "failed")
        assert.equal(command.retriedAfterFailure, true)
        assert.equal(timeoutWarnings(events).length, 2)
    })

    it("reports 'none' when the command was never measured", async () => {
        await withBaroHome(async (repo) => {
            const events: BaroEvent[] = []
            await verifyBuild(repo, {
                emitActivity: (event) => void events.push(event),
                sleep: async () => {},
                refreshDependencies: false,
                ceilingFloorMs: 1_000,
                plan: planOf(nodeCommand("silent gate", "setTimeout(() => {}, 60_000)", repo)),
            })
            assert.deepEqual(timeoutWarnings(events), [
                "verification timeout: silent gate hit ceiling 1s (last measured none)",
            ])
        })
    })
})
