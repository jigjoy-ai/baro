import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { RunVerifier } from "../../src/participants/run-verifier.js"
import {
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("RunVerifier", () => {
    it("publishes correlated objective evidence and deduplicates replay", async () => {
        let calls = 0
        const verifier = new RunVerifier({
            runId: "run-1",
            cwd: "/repo",
            verify: async () => {
                calls += 1
                return {
                    ran: true,
                    ok: true,
                    failures: [],
                    commands: [
                        {
                            command: "npm run test",
                            status: "passed",
                            durationMs: 12,
                        },
                    ],
                }
            },
        })
        const env = joinWithCapture(verifier)
        const request = RunVerificationRequested.create({
            runId: "run-1",
            verificationId: "verify-1",
        })

        env.deliverSemanticEvent(source("board"), request)
        env.deliverSemanticEvent(source("replay"), request)
        await verifier.idle()

        const completed = env.events.filter(RunVerificationCompleted.is)
        assert.equal(calls, 1)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.data.verificationId, "verify-1")
        assert.equal(completed[0]?.data.status, "passed")
        assert.equal(completed[0]?.data.commands[0]?.command, "npm run test")

        env.deliverSemanticEvent(source("late-replay"), request)
        await verifier.idle()
        assert.equal(calls, 1)
        assert.equal(env.events.filter(RunVerificationCompleted.is).length, 2)
    })

    it("distinguishes an unverified skip from a verified pass", async () => {
        const verifier = new RunVerifier({
            runId: "run-skip",
            cwd: "/repo",
            verify: async () => ({
                ran: false,
                ok: true,
                failures: [],
                commands: [],
            }),
        })
        const env = joinWithCapture(verifier)
        env.deliverSemanticEvent(
            source("board"),
            RunVerificationRequested.create({
                runId: "run-skip",
                verificationId: "verify-skip",
            }),
        )
        await verifier.idle()

        const completed = env.events.find(RunVerificationCompleted.is)
        assert.equal(completed?.data.status, "skipped")
    })

    it("runs a test script introduced after the verifier snapshots the repo", async () => {
        await withTempDir("baro-run-verifier-final-plan-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            writeFileSync(
                pkgPath,
                JSON.stringify({ name: "v", scripts: {} }),
            )
            const verifier = new RunVerifier({
                runId: "run-final-plan",
                cwd: dir,
            })
            const env = joinWithCapture(verifier)
            writeFileSync(
                pkgPath,
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )

            env.deliverSemanticEvent(
                source("board"),
                RunVerificationRequested.create({
                    runId: "run-final-plan",
                    verificationId: "verify-final-plan",
                }),
            )
            await verifier.idle()

            const completed = env.events.find(RunVerificationCompleted.is)
            assert.equal(completed?.data.status, "passed")
            assert.deepEqual(
                completed?.data.commands.map(({ command, status }) => ({
                    command,
                    status,
                })),
                [{ command: "npm run test", status: "passed" }],
            )
        })
    })

    it("turns an unexpected verifier crash into failed evidence", async () => {
        const verifier = new RunVerifier({
            runId: "run-fail",
            cwd: "/repo",
            verify: async () => {
                throw new Error("verifier exploded")
            },
        })
        const env = joinWithCapture(verifier)
        env.deliverSemanticEvent(
            source("board"),
            RunVerificationRequested.create({
                runId: "run-fail",
                verificationId: "verify-fail",
            }),
        )
        await verifier.idle()

        const completed = env.events.find(RunVerificationCompleted.is)
        assert.equal(completed?.data.status, "failed")
        assert.match(completed?.data.commands[0]?.tail ?? "", /exploded/)
    })

    it("cancels the active verifier on the correlated timeout event", async () => {
        let aborted = false
        let markStarted!: () => void
        const started = new Promise<void>((resolve) => {
            markStarted = resolve
        })
        const verifier = new RunVerifier({
            runId: "run-timeout",
            cwd: "/repo",
            verify: async (_cwd, signal) =>
                new Promise((_resolve, reject) => {
                    markStarted()
                    signal.addEventListener(
                        "abort",
                        () => {
                            aborted = true
                            reject(signal.reason)
                        },
                        { once: true },
                    )
                }),
        })
        const env = joinWithCapture(verifier)
        env.deliverSemanticEvent(
            source("board"),
            RunVerificationRequested.create({
                runId: "run-timeout",
                verificationId: "verify-timeout",
            }),
        )
        await started
        env.deliverSemanticEvent(
            source("board"),
            RunVerificationTimedOut.create({
                runId: "run-timeout",
                verificationId: "verify-timeout",
                timeoutMs: 5,
            }),
        )
        await verifier.idle()

        assert.equal(aborted, true)
        assert.equal(env.events.some(RunVerificationCompleted.is), false)
    })
})
