import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { BaroEvent } from "../../src/tui-protocol.js"
import {
    createVerifyPlan,
    isRunLevelCommand,
    MAX_FINAL_ADDED_VERIFY_COMMANDS,
    mergeVerifyPlans,
    recommendedMergedVerifyTimeoutMs,
    recommendedVerifyTimeoutMs,
    verifyBuild,
    type VerifyCommandSpec,
    type VerifyPlan,
} from "../../src/verification/verify.js"
import { withTempDir } from "../execution/helpers.js"

const ATTEMPT_BUDGET_MS = 10 * 60_000 + 5_000 + 3_000

/** Appends one line per attempt, so "exactly N attempts" is directly countable. */
function attemptScript(log: string, failWhile: "always" | "first" | "never"): string {
    const gate =
        failWhile === "always"
            ? "true"
            : failWhile === "first"
              ? "attempts === 1"
              : "false"
    return (
        "const fs = require('fs');" +
        `fs.appendFileSync(${JSON.stringify(log)}, 'x\\n');` +
        `const attempts = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;` +
        `if (${gate}) { console.error('attempt ' + attempts + ' fails'); process.exit(1); }` +
        "process.exit(0);"
    )
}

function attempts(log: string): number {
    return existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0
}

function planOf(...commands: VerifyCommandSpec[]): VerifyPlan {
    return { commands } as VerifyPlan
}

function capture(): { events: BaroEvent[]; emitActivity: (e: BaroEvent) => void } {
    const events: BaroEvent[] = []
    return { events, emitActivity: (event) => void events.push(event) }
}

describe("run-level verification retry", () => {
    it("retries a failed run-level command once and lets the retry decide", async () => {
        await withTempDir("baro-verify-runlevel-flake-", async (dir) => {
            const log = join(dir, "attempts")
            const { events, emitActivity } = capture()

            const result = await verifyBuild(dir, {
                emitActivity,
                plan: planOf({
                    // Deliberately not labelled "test": provenance, not wording,
                    // is what earns the retry now.
                    label: "cargo build (fixture)",
                    tool: process.execPath,
                    args: ["-e", attemptScript(log, "first")],
                    cwd: dir,
                }),
            })

            assert.equal(result.ok, true)
            assert.equal(result.ran, true)
            assert.equal(attempts(log), 2)
            const command = result.commands[0]!
            assert.equal(command.status, "passed")
            assert.equal(command.retriedAfterFailure, true)
            assert.match(command.firstFailureTail ?? "", /attempt 1 fails/u)

            assert.equal(events.length, 1)
            const event = events[0] as { type: string; id: string; kind: string; text: string }
            assert.equal(event.type, "activity")
            assert.equal(event.id, "_verify")
            assert.equal(event.kind, "warn")
            const { text } = event
            assert.match(text, /retried once/u)
            assert.match(text, /cargo build \(fixture\)/u)
            assert.match(text, /attempt 1 fails/u)
            assert.equal(/[\r\n]/u.test(text), false, "the tail must be collapsed")
        })
    })

    it("fails the gate closed when the single retry also fails", async () => {
        await withTempDir("baro-verify-runlevel-hard-", async (dir) => {
            const log = join(dir, "attempts")
            const { events, emitActivity } = capture()

            const result = await verifyBuild(dir, {
                emitActivity,
                plan: planOf({
                    label: "npm run test (fixture)",
                    tool: process.execPath,
                    args: ["-e", attemptScript(log, "always")],
                    cwd: dir,
                }),
            })

            assert.equal(result.ok, false)
            assert.equal(attempts(log), 2, "exactly two attempts, never a third")
            const command = result.commands[0]!
            assert.equal(command.status, "failed")
            assert.equal(command.retriedAfterFailure, true)
            assert.match(command.firstFailureTail ?? "", /attempt 1 fails/u)
            assert.match(command.tail ?? "", /attempt 2 fails/u)
            assert.equal(result.failures.length, 1)
            assert.equal(events.length, 1)
        })
    })

    it("gives a declared story test exactly one attempt and no announcement", async () => {
        await withTempDir("baro-verify-declared-noretry-", async (dir) => {
            const log = join(dir, "attempts")
            const { events, emitActivity } = capture()

            const result = await verifyBuild(dir, {
                emitActivity,
                plan: planOf({
                    label: "npm run test (declared fixture)",
                    tool: process.execPath,
                    args: ["-e", attemptScript(log, "always")],
                    cwd: dir,
                    origin: "declared",
                }),
            })

            assert.equal(result.ok, false)
            assert.equal(attempts(log), 1)
            assert.equal(result.commands[0]?.retriedAfterFailure, undefined)
            assert.deepEqual(events, [])
        })
    })

    it("never retries or announces a skipped command", async () => {
        await withTempDir("baro-verify-skipped-", async (dir) => {
            const { events, emitActivity } = capture()

            const result = await verifyBuild(dir, {
                emitActivity,
                plan: planOf({
                    label: "declared requirement needing a shell",
                    tool: "node",
                    args: [],
                    incompleteReason: "not translatable without a shell",
                }),
            })

            assert.equal(result.ran, false)
            assert.equal(result.commands[0]?.status, "skipped")
            assert.equal(result.commands[0]?.retriedAfterFailure, undefined)
            assert.deepEqual(events, [])
        })
    })

    it("never retries or announces a deterministic preflight failure", async () => {
        await withTempDir("baro-verify-preflight-", async (dir) => {
            const { events, emitActivity } = capture()

            const result = await verifyBuild(dir, {
                emitActivity,
                plan: planOf({
                    label: "npm run test (unparseable manifest)",
                    tool: "node",
                    args: [],
                    preflightFailure: "package.json is not valid JSON",
                }),
            })

            assert.equal(result.ok, false)
            assert.equal(result.commands[0]?.status, "failed")
            assert.equal(result.commands[0]?.retriedAfterFailure, undefined)
            assert.deepEqual(events, [])
        })
    })

    it("emits nothing when every command passes first time", async () => {
        await withTempDir("baro-verify-clean-", async (dir) => {
            const { events, emitActivity } = capture()

            const result = await verifyBuild(dir, {
                emitActivity,
                plan: planOf({
                    label: "npm run build (fixture)",
                    tool: process.execPath,
                    args: ["-e", "process.exit(0)"],
                    cwd: dir,
                }),
            })

            assert.equal(result.ok, true)
            assert.deepEqual(events, [])
        })
    })

    it("stamps declared origin at the single bounding site and preserves it through merge", async () => {
        await withTempDir("baro-verify-origin-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { build: "exit 0", test: "exit 0" } }),
            )
            writeFileSync(join(dir, "focus.test.js"), "")

            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    { storyId: "S1", command: "npm test -- focus.test.js" },
                    { storyId: "S2", command: "cd sub && npm test" },
                ],
            })

            const detected = plan.commands.filter((c) => c.origin === undefined)
            const declared = plan.commands.filter((c) => c.origin === "declared")
            assert.ok(detected.length > 0 && declared.length > 0, "need both kinds")
            assert.equal(
                plan.commands.every((c) => c.origin === undefined || c.origin === "declared"),
                true,
            )
            assert.equal(detected.every(isRunLevelCommand), true)
            assert.equal(declared.some(isRunLevelCommand), false)
            // Including the untranslatable declaration, which is still a story's.
            assert.equal(
                declared.some((c) => c.incompleteReason !== undefined),
                true,
            )

            const merged = mergeVerifyPlans(createVerifyPlan(dir), plan)
            for (const command of declared) {
                const carried = merged.commands.find((c) => c.label === command.label)
                assert.equal(carried?.origin, "declared", command.label)
            }
        })
    })

    it("budgets declared commands once and run-level commands twice", async () => {
        await withTempDir("baro-verify-budget-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { build: "exit 0", test: "exit 0" } }),
            )
            const empty = createVerifyPlan(join(dir, "..", "..", "nonexistent-root"))
            assert.equal(empty.commands.length, 0)

            const plan = createVerifyPlan(dir)
            const executable = plan.commands.filter(
                (c) => !c.preflightFailure && !c.incompleteReason,
            )
            assert.equal(executable.length, 2)
            assert.equal(
                recommendedVerifyTimeoutMs(plan),
                2 * 2 * ATTEMPT_BUDGET_MS + 60_000,
            )

            const mixed = planOf(
                { label: "run-level", tool: process.execPath, args: [] },
                { label: "declared", tool: process.execPath, args: [], origin: "declared" },
            )
            assert.equal(
                recommendedVerifyTimeoutMs(mixed),
                ATTEMPT_BUDGET_MS + 2 * ATTEMPT_BUDGET_MS + 60_000,
            )
            assert.equal(
                recommendedMergedVerifyTimeoutMs(mixed),
                ATTEMPT_BUDGET_MS +
                    (1 + MAX_FINAL_ADDED_VERIFY_COMMANDS) * 2 * ATTEMPT_BUDGET_MS +
                    60_000,
            )
        })
    })
})
