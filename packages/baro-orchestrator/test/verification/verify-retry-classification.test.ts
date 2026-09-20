import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CoordinationForwarder } from "../../src/execution/forwarders/coordination.js"
import {
    RunVerificationRetryClassified,
    type RunVerificationEvidence,
} from "../../src/semantic-events.js"
import { ABSOLUTE_COMMAND_TIMEOUT_MS } from "../../src/verification/command-timing.js"
import { classifyFailureTail } from "../../src/verification/failure-classifier.js"
import {
    FAILURE_SIGNALS,
    loadFailureSignals,
} from "../../src/verification/failure-signals.js"
import {
    decideRetry,
    type FailureBucket,
    type FailureRemedy,
} from "../../src/verification/retry-decision.js"
import { toVerificationEvidenceInfo, type BaroEvent } from "../../src/tui-protocol.js"
import {
    liftedCeiling,
    verifyBuild,
    type VerifyBuildOptions,
    type VerifyCommandResult,
    type VerifyCommandSpec,
    type VerifyPlan,
} from "../../src/verification/verify.js"
import { captureStdout, source, withTempDir } from "../execution/helpers.js"

function planOf(...commands: VerifyCommandSpec[]): VerifyPlan {
    return { commands } as VerifyPlan
}

/** Appends one line per spawn, so "exactly N attempts" is directly countable. */
function failingScript(log: string, tail: string): string {
    return (
        "const fs = require('fs');" +
        `fs.appendFileSync(${JSON.stringify(log)}, 'x\\n');` +
        `console.error(${JSON.stringify(tail)});` +
        "process.exit(1);"
    )
}

function spawns(log: string): number {
    return existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0
}

type RetryAnnouncement = Parameters<
    NonNullable<VerifyBuildOptions["onRetryDecision"]>
>[0]

/**
 * Drives the REAL verifyBuild over a temp fixture and reports what the gate
 * itself produced. No `sleep` seam and no fake timers: the run-level path
 * waits out no backoff, so a retry costs only the second spawn.
 */
async function runGate(
    dir: string,
    command: VerifyCommandSpec,
    options: Partial<VerifyBuildOptions> = {},
): Promise<{
    command: VerifyCommandResult
    announcements: RetryAnnouncement[]
}> {
    const announcements: RetryAnnouncement[] = []
    const result = await verifyBuild(dir, {
        emitActivity: () => {},
        refreshDependencies: false,
        plan: planOf(command),
        onRetryDecision: (info) => void announcements.push(info),
        ...options,
    })
    return { command: result.commands[0]!, announcements }
}

/** Restores the override variable whatever the body does with it. */
async function withSignalsFile(
    path: string,
    fn: () => Promise<void> | void,
): Promise<void> {
    const previous = process.env.BARO_FAILURE_SIGNALS_FILE
    process.env.BARO_FAILURE_SIGNALS_FILE = path
    try {
        await fn()
    } finally {
        if (previous === undefined) delete process.env.BARO_FAILURE_SIGNALS_FILE
        else process.env.BARO_FAILURE_SIGNALS_FILE = previous
    }
}

describe("the signal list this wiring depends on", () => {
    it("is frozen data with unique kebab-case ids and literal matches", () => {
        assert.equal(Object.isFrozen(FAILURE_SIGNALS), true)
        assert.ok(FAILURE_SIGNALS.length > 0)
        const ids = FAILURE_SIGNALS.map((signal) => signal.id)
        assert.equal(new Set(ids).size, ids.length, "ids must be unique")
        for (const signal of FAILURE_SIGNALS) {
            assert.match(signal.id, /^[a-z0-9]+(-[a-z0-9]+)*$/u, signal.id)
            assert.equal(typeof signal.match, "string", signal.id)
            assert.ok(signal.match.length > 0, signal.id)
        }
    })

    it("covers every mandated failure tail without falling through to regression", () => {
        const required: Array<[string, string, FailureBucket, FailureRemedy]> = [
            ["spawn cargo ENOENT", "enoent", "environment", "rematerialize-worktree"],
            [
                "verification cwd missing: /tmp/baro-worktrees/run-1/__run",
                "verification-cwd-missing",
                "environment",
                "rematerialize-worktree",
            ],
            [
                "error: could not find Cargo.toml in /repo or any parent directory",
                "cargo-manifest-missing",
                "environment",
                "rematerialize-worktree",
            ],
            [
                "Error: Cannot find module 'tsx' imported from /repo/test/x.ts",
                "node-module-missing",
                "environment",
                "install-dependencies",
            ],
            [
                "error TS2688: Cannot find type definition file for '@types/node'",
                "node-types-missing",
                "environment",
                "install-dependencies",
            ],
            [
                "sh: pnpm: command not found",
                "command-not-found",
                "environment",
                "install-dependencies",
            ],
            [
                "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'",
                "node-esm-module-missing",
                "environment",
                "install-dependencies",
            ],
            [
                "ModuleNotFoundError: No module named 'pytest'",
                "python-module-missing",
                "environment",
                "install-dependencies",
            ],
            [
                "main.go:3:8: cannot find package \"example.com/x\"",
                "go-package-missing",
                "environment",
                "install-dependencies",
            ],
            [
                'PHP Fatal error: Class not found: App\\Kernel',
                "php-class-missing",
                "environment",
                "install-dependencies",
            ],
            [
                "killed: exceeded the absolute command ceiling of 600s",
                "absolute-command-ceiling",
                "time-ceiling",
                "lift-ceiling",
            ],
        ]
        assert.equal(required.length, 11)
        for (const [tail, signalId, bucket, remedy] of required) {
            const classification = classifyFailureTail(tail, {})
            assert.deepEqual(classification, { bucket, remedy, signalId }, tail)
        }
    })

    it("takes a well-formed override and ignores every defective one", async () => {
        await withTempDir("baro-retry-signals-", async (dir) => {
            const good = join(dir, "good.json")
            writeFileSync(
                good,
                JSON.stringify([
                    {
                        id: "ruby-gem-missing",
                        bucket: "environment",
                        remedy: "install-dependencies",
                        match: "LoadError: cannot load such file",
                    },
                ]),
            )
            await withSignalsFile(good, () => {
                const verdict = decideRetry("LoadError: cannot load such file -- rspec")
                assert.equal(verdict.retry, true)
                assert.equal(verdict.signalId, "ruby-gem-missing")
                assert.equal(verdict.remedy, "install-dependencies")
            })

            const malformed = join(dir, "malformed.json")
            writeFileSync(malformed, "{ not json")
            const oversized = join(dir, "oversized.json")
            writeFileSync(
                oversized,
                JSON.stringify([
                    {
                        id: "x",
                        bucket: "environment",
                        remedy: "install-dependencies",
                        match: "z".repeat(64 * 1024 + 1),
                    },
                ]),
            )
            for (const file of [malformed, oversized, join(dir, "absent.json")]) {
                await withSignalsFile(file, () => {
                    assert.equal(loadFailureSignals(), FAILURE_SIGNALS, file)
                })
            }
        })
    })
})

describe("decideRetry", () => {
    it("retries an environment tail once, after its remedy", () => {
        const verdict = decideRetry("Error: Cannot find module 'tsx'")
        assert.deepEqual(verdict, {
            retry: true,
            bucket: "environment",
            remedy: "install-dependencies",
            signalId: "node-module-missing",
            refusal: null,
        })
        assert.equal(
            decideRetry("spawn cargo ENOENT").remedy,
            "rematerialize-worktree",
        )
    })

    it("retries a time-ceiling tail only once the machine is idle", () => {
        const tail = "killed: exceeded the absolute command ceiling of 600s"
        const idle = decideRetry(tail, {
            timedOut: true,
            retryable: true,
            storyExecutorsActive: false,
        })
        assert.equal(idle.retry, true)
        assert.equal(idle.bucket, "time-ceiling")
        assert.equal(idle.remedy, "lift-ceiling")
        assert.equal(idle.refusal, null)

        for (const storyExecutorsActive of [true, undefined]) {
            const busy = decideRetry(tail, { timedOut: true, storyExecutorsActive })
            assert.equal(busy.retry, false, String(storyExecutorsActive))
            assert.equal(busy.remedy, "none")
            assert.equal(busy.refusal, "story-executors-active")
            assert.equal(busy.bucket, "time-ceiling")
        }
    })

    it("refuses a regression, an empty tail and an unretryable outcome", () => {
        for (const tail of ["error TS2345: no", "AssertionError: 3 !== 4", ""]) {
            const verdict = decideRetry(tail)
            assert.equal(verdict.retry, false, tail)
            assert.equal(verdict.bucket, "regression", tail)
            assert.equal(verdict.remedy, "none", tail)
            assert.equal(verdict.refusal, "classified-regression", tail)
        }
        const terminal = decideRetry("verification cwd missing: /gone", {
            environment: true,
            retryable: false,
        })
        assert.equal(terminal.retry, false)
        assert.equal(terminal.bucket, "environment")
        assert.equal(terminal.remedy, "none")
        assert.equal(terminal.refusal, "not-retryable")
    })
})

describe("the lifted ceiling a time-ceiling retry earns", () => {
    it("quadruples the resolved ceiling and stops at thirty minutes", () => {
        assert.deepEqual(liftedCeiling({ key: "k", ceilingMs: 1_000 }), {
            key: "k",
            ceilingMs: 4_000,
        })
        assert.deepEqual(
            liftedCeiling({ key: "k", ceilingMs: 60_000, lastMs: 42 }),
            { key: "k", ceilingMs: 240_000, lastMs: 42 },
        )
        assert.equal(
            liftedCeiling({ key: "k", ceilingMs: ABSOLUTE_COMMAND_TIMEOUT_MS })
                .ceilingMs,
            30 * 60_000,
        )
    })
})

describe("verifyBuild classifies its own run-level failures", () => {
    it("stamps bucket and remedy beside firstFailureTail, one tail per bucket", async () => {
        const cases: Array<
            [string, string, FailureBucket, FailureRemedy, number]
        > = [
            [
                "environment",
                "Error: Cannot find module 'left-pad'",
                "environment",
                "install-dependencies",
                2,
            ],
            [
                "regression",
                "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
                "regression",
                "none",
                1,
            ],
            [
                "ceiling",
                "npm ERR! exceeded the absolute command ceiling of 600s",
                "time-ceiling",
                "lift-ceiling",
                2,
            ],
        ]
        for (const [name, tail, bucket, remedy, expectedSpawns] of cases) {
            await withTempDir(`baro-retry-bucket-${name}-`, async (dir) => {
                const log = join(dir, "spawns")
                const { command } = await runGate(
                    dir,
                    {
                        label: `npm run test (${name})`,
                        tool: process.execPath,
                        args: ["-e", failingScript(log, tail)],
                        cwd: dir,
                    },
                    { storyExecutorsActive: () => false },
                )

                assert.equal(command.status, "failed", name)
                assert.equal(command.firstFailureTail, tail, name)
                assert.equal(command.failureBucket, bucket, name)
                assert.equal(command.remedy, remedy, name)
                assert.equal(spawns(log), expectedSpawns, name)
            })
        }
    })

    it("runs the install remedy through runCmd before the single retry", async () => {
        await withTempDir("baro-retry-install-", async (dir) => {
            const log = join(dir, "spawns")
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "fixture", private: true }),
            )
            // Every runCmd spawn re-reads the run cwd through this resolver, so
            // its call count separates "install + two attempts" from "two
            // attempts" without depending on a real package manager.
            let resolved = 0
            const { command, announcements } = await runGate(
                dir,
                {
                    label: "npm run test (missing dependency)",
                    tool: process.execPath,
                    args: [
                        "-e",
                        failingScript(log, "Error: Cannot find module 'left-pad'"),
                    ],
                },
                {
                    resolveRunCwd: () => {
                        resolved += 1
                        return dir
                    },
                },
            )

            assert.equal(command.retriedAfterFailure, true)
            assert.equal(command.failureBucket, "environment")
            assert.equal(command.remedy, "install-dependencies")
            assert.equal(spawns(log), 2, "exactly two attempts, never a third")
            assert.equal(resolved, 3, "the install spawned between the attempts")
            assert.equal(announcements.length, 1)
        })
    })

    it("never retries a persistently broken environment a second time", async () => {
        await withTempDir("baro-retry-persistent-", async (dir) => {
            const log = join(dir, "spawns")
            const { command, announcements } = await runGate(dir, {
                label: "cargo test (vanished toolchain)",
                tool: process.execPath,
                args: [
                    "-e",
                    failingScript(log, "error: could not find Cargo.toml"),
                ],
                cwd: dir,
            })

            assert.equal(command.status, "failed")
            assert.equal(command.retriedAfterFailure, true)
            assert.equal(command.failureBucket, "environment")
            assert.equal(command.remedy, "rematerialize-worktree")
            assert.equal(spawns(log), 2, "one decision, so never a third spawn")
            assert.equal(announcements.length, 1, "decided once, announced once")
        })
    })

    it("hands a regression tail to the story agent without retrying or announcing", async () => {
        await withTempDir("baro-retry-regression-", async (dir) => {
            const log = join(dir, "spawns")
            const { command, announcements } = await runGate(dir, {
                label: "npm run test (regression)",
                tool: process.execPath,
                args: [
                    "-e",
                    failingScript(
                        log,
                        "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
                    ),
                ],
                cwd: dir,
            })

            assert.equal(spawns(log), 1)
            assert.equal(command.retriedAfterFailure, undefined)
            assert.match(command.firstFailureTail ?? "", /AssertionError/u)
            assert.equal(command.failureBucket, "regression")
            assert.equal(command.remedy, "none")
            assert.deepEqual(announcements, [])
        })
    })

    it("lifts the ceiling for the one retry a timeout earns", async () => {
        await withTempDir("baro-retry-ceiling-", async (dir) => {
            const log = join(dir, "spawns")
            // Attempt 1 is killed at the 1s floor; attempt 2 has 4s and the
            // command needs 2s, so only a lifted ceiling can let it pass.
            const { command, announcements } = await runGate(
                dir,
                {
                    label: "cargo test (slow)",
                    tool: process.execPath,
                    args: [
                        "-e",
                        `require('fs').appendFileSync(${JSON.stringify(log)}, 'x\\n');` +
                            "setTimeout(() => process.exit(0), 2_000);",
                    ],
                    cwd: dir,
                },
                { ceilingFloorMs: 1_000, storyExecutorsActive: () => false },
            )

            assert.equal(command.status, "passed")
            assert.equal(command.retriedAfterFailure, true)
            assert.equal(command.failureBucket, "time-ceiling")
            assert.equal(command.remedy, "lift-ceiling")
            assert.equal(spawns(log), 2, "never a third attempt")
            assert.deepEqual(announcements.map(({ remedy }) => remedy), [
                "lift-ceiling",
            ])
        })
    })

    it("survives an onRetryDecision that throws", async () => {
        await withTempDir("baro-retry-throwing-", async (dir) => {
            const log = join(dir, "spawns")
            const result = await verifyBuild(dir, {
                emitActivity: () => {},
                refreshDependencies: false,
                onRetryDecision: () => {
                    throw new Error("subscriber exploded")
                },
                plan: planOf({
                    label: "npm run test (noisy subscriber)",
                    tool: process.execPath,
                    args: [
                        "-e",
                        failingScript(log, "Error: Cannot find module 'left-pad'"),
                    ],
                    cwd: dir,
                }),
            })

            assert.equal(spawns(log), 2, "the retry still ran")
            assert.equal(result.commands[0]?.retriedAfterFailure, true)
            assert.equal(result.ok, false)
        })
    })

    it("omits all three fields for a command that never failed", async () => {
        await withTempDir("baro-retry-green-", async (dir) => {
            const { command } = await runGate(dir, {
                label: "npm run build (green)",
                tool: process.execPath,
                args: ["-e", "process.exit(0)"],
                cwd: dir,
            })

            assert.equal(command.status, "passed")
            assert.equal("failureBucket" in command, false)
            assert.equal("remedy" in command, false)
            assert.equal("firstFailureTail" in command, false)
        })
    })
})

describe("the operator's view of a classified retry", () => {
    const evidence: RunVerificationEvidence = {
        verificationId: "verify-1",
        status: "failed",
        commands: [
            {
                command: "npm run test",
                status: "failed",
                durationMs: 9,
                tail: "second attempt",
                firstFailureTail: "Error: Cannot find module 'left-pad'",
                failureBucket: "environment",
                remedy: "install-dependencies",
                retriedAfterFailure: true,
            },
            { command: "npm run build", status: "passed", durationMs: 3 },
        ],
    }

    it("projects failure_bucket and remedy beside first_failure_tail, and no output", () => {
        const [failed, passed] = toVerificationEvidenceInfo(evidence).commands
        assert.equal(failed?.first_failure_tail, "Error: Cannot find module 'left-pad'")
        assert.equal(failed?.failure_bucket, "environment")
        assert.equal(failed?.remedy, "install-dependencies")
        assert.equal("output" in (failed ?? {}), false)
        assert.equal("failure_bucket" in (passed ?? {}), false)
        assert.equal("remedy" in (passed ?? {}), false)
    })

    it("names the bucket and remedy on the activity feed, but only for a retry", async () => {
        const forwarder = new CoordinationForwarder()
        const lines = await captureStdout(async () => {
            for (const retried of [true, false]) {
                await forwarder.onExternalEvent(
                    source("verifier"),
                    RunVerificationRetryClassified.create({
                        runId: "run-1",
                        verificationId: "verify-1",
                        command: "npm run test",
                        bucket: "environment",
                        remedy: "install-dependencies",
                        signalId: "node-module-missing",
                        retried,
                        tail: "Error: Cannot find module 'left-pad'",
                    }),
                )
            }
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.equal(events.length, 1, "a refusal says nothing here")
        assert.deepEqual(events[0], {
            type: "activity",
            id: "_verify",
            kind: "warn",
            text: "verification retry: npm run test (environment → install-dependencies)",
        })
    })
})
