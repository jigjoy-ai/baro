import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    classifyFailureTail,
    decideRetry,
} from "../../src/verification/failure-classifier.js"
import {
    FAILURE_SIGNALS,
    loadFailureSignals,
} from "../../src/verification/failure-signals.js"
import { RunVerifier } from "../../src/verification/run-verifier.js"
import {
    verifyBuild,
    type VerifyCommandResult,
    type VerifyCommandSpec,
    type VerifyPlan,
} from "../../src/verification/verify.js"
import {
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationRetryClassified,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "../execution/helpers.js"

const BOARD = source("board")

/** Restores the override variable whatever the body does with it. */
async function withSignalsFile(
    path: string | undefined,
    fn: () => Promise<void> | void,
): Promise<void> {
    const previous = process.env.BARO_FAILURE_SIGNALS_FILE
    if (path === undefined) delete process.env.BARO_FAILURE_SIGNALS_FILE
    else process.env.BARO_FAILURE_SIGNALS_FILE = path
    try {
        await fn()
    } finally {
        if (previous === undefined) delete process.env.BARO_FAILURE_SIGNALS_FILE
        else process.env.BARO_FAILURE_SIGNALS_FILE = previous
    }
}

/** Runs one verification through a RunVerifier whose verify() is injected. */
async function verifyWith(
    runId: string,
    commands: VerifyCommandResult[],
): Promise<{
    completed: ReturnType<typeof RunVerificationCompleted.create>
    classified: ReturnType<typeof RunVerificationRetryClassified.create>[]
}> {
    const verifier = new RunVerifier({
        runId,
        cwd: "/repo",
        hostRepoRoot: "/repo",
        verify: async () => ({
            ran: true,
            ok: commands.every((c) => c.status !== "failed"),
            failures: [],
            commands,
        }),
    })
    verifier.setRequestAuthority(BOARD)
    const env = joinWithCapture(verifier)
    env.deliverSemanticEvent(
        BOARD,
        RunVerificationRequested.create({
            runId,
            verificationId: `${runId}:verification:1`,
        }),
    )
    await verifier.idle()
    const completed = env.events.filter(RunVerificationCompleted.is)
    assert.equal(completed.length, 1)
    return {
        completed: completed[0]!,
        classified: env.events.filter(RunVerificationRetryClassified.is),
    }
}

describe("classifyFailureTail", () => {
    it("buckets one tail per bucket with the matching remedy", () => {
        const environment = classifyFailureTail(
            "Error: Cannot find module 'tsx' imported from /repo/test/x.ts",
            {},
        )
        assert.equal(environment.bucket, "environment")
        assert.equal(environment.remedy, "install-dependencies")
        assert.equal(environment.signalId, "node-module-missing")

        const ceiling = classifyFailureTail(
            "npm run test exceeded the absolute command ceiling of 600s",
            {},
        )
        assert.equal(ceiling.bucket, "time-ceiling")
        assert.equal(ceiling.remedy, "lift-ceiling")
        assert.equal(ceiling.signalId, "absolute-command-ceiling")

        const regression = classifyFailureTail(
            "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
            {},
        )
        assert.equal(regression.bucket, "regression")
        assert.equal(regression.remedy, "none")
        assert.equal(regression.signalId, "assertion-failed")
    })

    it("defaults an unrecognised tail to regression with no signal", () => {
        const verdict = classifyFailureTail("something nobody has a signal for", {})
        assert.deepEqual(verdict, {
            bucket: "regression",
            remedy: "none",
            signalId: null,
        })
    })

    it("lets the environment hint outrank a regression tail", () => {
        // STORY-168 stamps environment:true on a vanished cwd. The hint is an
        // observation; the text is a guess, so the hint decides the bucket.
        const verdict = classifyFailureTail(
            "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
            { environment: true },
        )
        assert.equal(verdict.bucket, "environment")
        assert.equal(verdict.remedy, "rematerialize-worktree")
    })

    it("takes the sharper remedy from the table for a hinted missing cwd", () => {
        const verdict = classifyFailureTail(
            "verification cwd missing: /tmp/baro-worktrees/run-1/S2",
            { environment: true },
        )
        assert.equal(verdict.bucket, "environment")
        assert.equal(verdict.remedy, "rematerialize-worktree")
        assert.equal(verdict.signalId, "verification-cwd-missing")
    })

    it("ranks the timeout hint above the table but below the environment hint", () => {
        assert.equal(
            classifyFailureTail("AssertionError: nope", { timedOut: true }).bucket,
            "time-ceiling",
        )
        assert.equal(
            classifyFailureTail("AssertionError: nope", {
                timedOut: true,
                environment: true,
            }).bucket,
            "environment",
        )
    })

    it("treats a missing dependency as environment even when tsc reports it", () => {
        // `error TS2307: Cannot find module` matches both an environment and a
        // regression signal; table order must hand it to environment.
        const verdict = classifyFailureTail(
            "src/a.ts(3,20): error TS2307: Cannot find module 'left-pad'.",
            {},
        )
        assert.equal(verdict.bucket, "environment")
        assert.equal(verdict.remedy, "install-dependencies")
    })

    it("matches case-insensitively and covers the non-JS ecosystems", () => {
        for (const [tail, remedy] of [
            ["ModuleNotFoundError: No module named 'pytest'", "install-dependencies"],
            ["cannot find package \"golang.org/x/tools\"", "install-dependencies"],
            ["PHP Fatal error: Class not found", "install-dependencies"],
            ["error: could not find Cargo.toml in /repo", "rematerialize-worktree"],
            ["spawn npm ENOENT", "rematerialize-worktree"],
            ["sh: cargo: command not found", "install-dependencies"],
            ["ERR_MODULE_NOT_FOUND", "install-dependencies"],
            ["error: cannot find module '@types/node'", "install-dependencies"],
        ] as const) {
            const verdict = classifyFailureTail(tail.toUpperCase(), {})
            assert.equal(verdict.bucket, "environment", tail)
            assert.equal(verdict.remedy, remedy, tail)
        }
        assert.equal(
            classifyFailureTail("warning: unused variable `x`", {}).bucket,
            "regression",
        )
        assert.equal(
            classifyFailureTail("warnings are denied by -D warnings", {}).bucket,
            "regression",
        )
    })
})

describe("decideRetry", () => {
    it("retries an environment failure exactly once, after its remedy", () => {
        const first = decideRetry("Cannot find module 'tsx'", {})
        assert.equal(first.retry, true)
        assert.equal(first.remedy, "install-dependencies")
        assert.equal(first.liftCeiling, false)

        // The same tail, once the single retry is spent, never retries again.
        const second = decideRetry("Cannot find module 'tsx'", {
            alreadyRetried: true,
        })
        assert.equal(second.retry, false)
        assert.equal(second.classification.bucket, "environment")
    })

    it("retries a time-ceiling failure once with the ceiling lifted, never twice", () => {
        const first = decideRetry("exceeded the absolute command ceiling", {})
        assert.equal(first.retry, true)
        assert.equal(first.liftCeiling, true)
        assert.equal(first.remedy, "lift-ceiling")

        const second = decideRetry("exceeded the absolute command ceiling", {
            alreadyRetried: true,
        })
        assert.equal(second.retry, false)
        assert.equal(second.liftCeiling, false)
    })

    it("never retries a regression and preserves its tail for the story agent", () => {
        const tail = "AssertionError [ERR_ASSERTION]: expected 3 to equal 4"
        const verdict = decideRetry(tail, {})
        assert.equal(verdict.retry, false)
        assert.equal(verdict.liftCeiling, false)
        assert.equal(verdict.remedy, "none")
        assert.equal(verdict.classification.bucket, "regression")
    })

    it("rematerialises rather than installs for a vanished cwd", () => {
        const verdict = decideRetry("verification cwd missing: /tmp/gone", {
            environment: true,
        })
        assert.equal(verdict.retry, true)
        assert.equal(verdict.remedy, "rematerialize-worktree")
    })
})

describe("loadFailureSignals", () => {
    it("returns the built-in table when no override is configured", async () => {
        await withSignalsFile(undefined, () => {
            assert.equal(loadFailureSignals(), FAILURE_SIGNALS)
            assert.ok(FAILURE_SIGNALS.length > 0)
        })
    })

    it("lets a well-formed override win the first match", async () => {
        await withTempDir("baro-signals-ok-", async (dir) => {
            const file = join(dir, "signals.json")
            writeFileSync(
                file,
                JSON.stringify([
                    {
                        id: "ruby-gem-missing",
                        bucket: "environment",
                        remedy: "install-dependencies",
                        match: "LoadError: cannot load such file",
                    },
                    {
                        id: "assertion-is-environment-here",
                        bucket: "environment",
                        remedy: "rematerialize-worktree",
                        match: "AssertionError",
                    },
                ]),
            )
            await withSignalsFile(file, () => {
                assert.equal(
                    classifyFailureTail("LoadError: cannot load such file -- rspec", {})
                        .signalId,
                    "ruby-gem-missing",
                )
                // Prepended, so it outranks the built-in regression signal.
                const shadowed = classifyFailureTail("AssertionError: boom", {})
                assert.equal(shadowed.bucket, "environment")
                assert.equal(shadowed.signalId, "assertion-is-environment-here")
            })
        })
    })

    it("falls back to the built-in table for every defective override", async () => {
        await withTempDir("baro-signals-bad-", async (dir) => {
            const cases: Array<[string, string]> = [
                ["missing.json", ""],
                ["not-json.json", "{"],
                ["not-array.json", JSON.stringify({ id: "x" })],
                [
                    "bad-bucket.json",
                    JSON.stringify([
                        { id: "x", bucket: "nope", remedy: "none", match: "x" },
                    ]),
                ],
                [
                    "bad-remedy.json",
                    JSON.stringify([
                        { id: "x", bucket: "regression", remedy: "nope", match: "x" },
                    ]),
                ],
                [
                    "empty-match.json",
                    JSON.stringify([
                        { id: "x", bucket: "regression", remedy: "none", match: "" },
                    ]),
                ],
                [
                    "oversized.json",
                    JSON.stringify([
                        {
                            id: "x",
                            bucket: "regression",
                            remedy: "none",
                            match: "z".repeat(64 * 1024 + 1),
                        },
                    ]),
                ],
            ]
            for (const [name, contents] of cases) {
                const file = join(dir, name)
                if (name !== "missing.json") writeFileSync(file, contents)
                await withSignalsFile(file, () => {
                    assert.equal(loadFailureSignals(), FAILURE_SIGNALS, name)
                })
            }
            // A directory is not a readable regular file.
            await withSignalsFile(dir, () => {
                assert.equal(loadFailureSignals(), FAILURE_SIGNALS)
            })
        })
    })
})

describe("run verification evidence and the retry-classified event", () => {
    it("stamps bucket and remedy on a failed command and announces it once", async () => {
        const { completed, classified } = await verifyWith("run-regression", [
            {
                command: "npm run test",
                status: "failed",
                durationMs: 12,
                tail: "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
            },
        ])

        const command = completed.data.commands[0]!
        assert.equal(command.failureBucket, "regression")
        assert.equal(command.remedy, "none")

        assert.equal(classified.length, 1)
        assert.deepEqual(classified[0]!.data, {
            runId: "run-regression",
            verificationId: "run-regression:verification:1",
            command: "npm run test",
            bucket: "regression",
            remedy: "none",
            signalId: "assertion-failed",
            retried: false,
            tail: "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
        })
    })

    it("classifies a command that failed once and passed on retry", async () => {
        const { completed, classified } = await verifyWith("run-retry-winner", [
            {
                command: "npm run test",
                status: "passed",
                durationMs: 30,
                retriedAfterFailure: true,
                firstFailureTail: "Error: Cannot find module 'tsx'",
            },
        ])

        const command = completed.data.commands[0]!
        assert.equal(command.status, "passed")
        assert.equal(command.failureBucket, "environment")
        assert.equal(command.remedy, "install-dependencies")

        assert.equal(classified.length, 1)
        assert.equal(classified[0]!.data.retried, true)
        // The bounded first-attempt tail, not the (green) second attempt.
        assert.equal(classified[0]!.data.tail, "Error: Cannot find module 'tsx'")
    })

    it("judges the first attempt's tail, not the retry's", async () => {
        const { classified } = await verifyWith("run-two-tails", [
            {
                command: "npm run test",
                status: "failed",
                durationMs: 30,
                retriedAfterFailure: true,
                firstFailureTail: "exceeded the absolute command ceiling",
                tail: "AssertionError: a different second-attempt failure",
            },
        ])
        assert.equal(classified.length, 1)
        assert.equal(classified[0]!.data.bucket, "time-ceiling")
        assert.equal(classified[0]!.data.remedy, "lift-ceiling")
    })

    it("prefers the runner's environment observation over the tail text", async () => {
        const { completed, classified } = await verifyWith("run-vanished-cwd", [
            {
                command: "cargo test",
                status: "failed",
                durationMs: 3,
                retryable: false,
                environment: true,
                tail: "verification cwd missing: /tmp/baro-worktrees/run-1/S2",
            },
        ])
        assert.equal(completed.data.commands[0]!.failureBucket, "environment")
        assert.equal(completed.data.commands[0]!.remedy, "rematerialize-worktree")
        assert.equal(classified[0]!.data.signalId, "verification-cwd-missing")
    })

    it("leaves passing and skipped commands unclassified and silent", async () => {
        const { completed, classified } = await verifyWith("run-green", [
            { command: "npm run build", status: "passed", durationMs: 5 },
            {
                command: "npm run lint",
                status: "skipped",
                durationMs: 0,
                tail: "no lint script",
            },
        ])
        for (const command of completed.data.commands) {
            assert.equal(command.failureBucket, undefined)
            assert.equal(command.remedy, undefined)
        }
        assert.equal(classified.length, 0)
    })

    it("does not re-announce classifications when a request is replayed", async () => {
        const verifier = new RunVerifier({
            runId: "run-replay",
            cwd: "/repo",
            hostRepoRoot: "/repo",
            verify: async () => ({
                ran: true,
                ok: false,
                failures: [],
                commands: [
                    {
                        command: "npm run test",
                        status: "failed",
                        durationMs: 1,
                        tail: "AssertionError: boom",
                    },
                ],
            }),
        })
        verifier.setRequestAuthority(BOARD)
        const env = joinWithCapture(verifier)
        const request = RunVerificationRequested.create({
            runId: "run-replay",
            verificationId: "run-replay:verification:1",
        })

        env.deliverSemanticEvent(BOARD, request)
        await verifier.idle()
        env.deliverSemanticEvent(BOARD, request)
        await verifier.idle()

        assert.equal(env.events.filter(RunVerificationCompleted.is).length, 2)
        assert.equal(env.events.filter(RunVerificationRetryClassified.is).length, 1)
    })

    it("does not add a BaroEvent wire variant for the classification", async () => {
        const protocol = await import("../../src/tui-protocol.js")
        assert.equal(
            Object.keys(protocol).includes("RunVerificationRetryClassified"),
            false,
        )
        assert.equal(
            RunVerificationRetryClassified.type,
            "run_verification_retry_classified",
        )
    })
})

/** Appends one line per spawn, so "exactly N attempts" is directly countable. */
function failingScript(log: string, message: string): string {
    return (
        "const fs = require('fs');" +
        `fs.appendFileSync(${JSON.stringify(log)}, 'x\\n');` +
        `console.error(${JSON.stringify(message)});` +
        "process.exit(1);"
    )
}

function attemptCount(log: string): number {
    return existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0
}

function planOf(...commands: VerifyCommandSpec[]): VerifyPlan {
    return { commands } as VerifyPlan
}

/**
 * Drives the real verifyBuild and counts retries through the sleep seam, which
 * it calls once per retry. Returns the gate's own evidence so the classifier
 * is judged on a tail verifyBuild actually produced.
 */
async function runGate(
    dir: string,
    command: VerifyCommandSpec,
    options: { storyExecutorsActive?: () => boolean; ceilingFloorMs?: number } = {},
): Promise<{ sleeps: number; command: VerifyCommandResult }> {
    let sleeps = 0
    const result = await verifyBuild(dir, {
        emitActivity: () => {},
        refreshDependencies: false,
        sleep: async () => {
            sleeps += 1
        },
        plan: planOf(command),
        ...options,
    })
    return { sleeps, command: result.commands[0]! }
}

describe("classifying failures verifyBuild actually produced", () => {
    it("refuses a real regression tail any retry, and preserves it for the story agent", async () => {
        await withTempDir("baro-classify-regression-", async (dir) => {
            const log = join(dir, "attempts")
            const { command } = await runGate(dir, {
                label: "npm run test (fixture)",
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

            assert.equal(command.status, "failed")
            const tail = command.firstFailureTail ?? command.tail ?? ""
            assert.match(tail, /AssertionError/u)

            const verdict = classifyFailureTail(tail, {
                timedOut: command.timedOut,
                environment: command.environment,
            })
            assert.equal(verdict.bucket, "regression")
            assert.equal(verdict.remedy, "none")
            // The contract for this bucket is ZERO retries. Deliberately no
            // assertion on the gate's own retry count: verifyBuild does not yet
            // consult decideRetry (S6 owns that wiring), and pinning today's
            // count here would freeze the defect as if it were the contract.
            assert.equal(decideRetry(tail, {}).retry, false)
            assert.equal(decideRetry(tail, {}).liftCeiling, false)
        })
    })

    it("classifies a real environment failure and stamps it on the gate's evidence", async () => {
        await withTempDir("baro-classify-environment-", async (dir) => {
            const log = join(dir, "attempts")
            const { sleeps, command } = await runGate(dir, {
                label: "npm run build (fixture)",
                tool: process.execPath,
                args: [
                    "-e",
                    failingScript(log, "Error: Cannot find module 'left-pad'"),
                ],
                cwd: dir,
            })

            assert.equal(sleeps, 1)
            assert.equal(attemptCount(log), 2)

            const verdict = classifyFailureTail(command.firstFailureTail ?? "", {})
            assert.equal(verdict.bucket, "environment")
            assert.equal(verdict.remedy, "install-dependencies")

            // End to end: the same tail carried through the run-verifier lands
            // on the evidence and on exactly one event.
            const { completed, classified } = await verifyWith("run-env-e2e", [command])
            assert.equal(completed.data.commands[0]!.failureBucket, "environment")
            assert.equal(completed.data.commands[0]!.remedy, "install-dependencies")
            assert.equal(classified.length, 1)
            assert.equal(classified[0]!.data.retried, true)
        })
    })

    it("classifies a real ceiling kill as time-ceiling and still retries only once", async () => {
        await withTempDir("baro-classify-ceiling-", async (dir) => {
            const log = join(dir, "attempts")
            const { sleeps, command } = await runGate(
                dir,
                {
                    label: "cargo test (fixture)",
                    tool: process.execPath,
                    args: [
                        "-e",
                        `require('fs').appendFileSync(${JSON.stringify(log)}, 'x\\n');` +
                            "setTimeout(() => {}, 60_000);",
                    ],
                    cwd: dir,
                },
                { ceilingFloorMs: 1_000, storyExecutorsActive: () => false },
            )

            assert.equal(command.timedOut, true)
            assert.ok(sleeps <= 1, `at most one retry, saw ${sleeps}`)
            assert.ok(attemptCount(log) <= 2, "never a third attempt")

            const verdict = classifyFailureTail(command.firstFailureTail ?? command.tail ?? "", {
                timedOut: command.timedOut,
            })
            assert.equal(verdict.bucket, "time-ceiling")
            assert.equal(verdict.remedy, "lift-ceiling")
            assert.equal(
                decideRetry("", { timedOut: true, alreadyRetried: true }).retry,
                false,
                "a ceiling failure is never retried twice",
            )
        })
    })

    it("lets BARO_FAILURE_SIGNALS_FILE rebucket a real gate failure", async () => {
        await withTempDir("baro-classify-override-", async (dir) => {
            const log = join(dir, "attempts")
            const { command } = await runGate(dir, {
                label: "npm run test (fixture)",
                tool: process.execPath,
                args: [
                    "-e",
                    failingScript(log, "Flake: transient fixture outage"),
                ],
                cwd: dir,
            })

            const tail = command.firstFailureTail ?? ""
            // Unknown text is a regression until an operator says otherwise.
            assert.equal(classifyFailureTail(tail, {}).bucket, "regression")

            const file = join(dir, "signals.json")
            writeFileSync(
                file,
                JSON.stringify([
                    {
                        id: "fixture-outage",
                        bucket: "environment",
                        remedy: "rematerialize-worktree",
                        match: "transient fixture outage",
                    },
                ]),
            )
            await withSignalsFile(file, () => {
                const verdict = decideRetry(tail, {})
                assert.equal(verdict.classification.bucket, "environment")
                assert.equal(verdict.remedy, "rematerialize-worktree")
                assert.equal(verdict.retry, true)
            })
        })
    })
})
