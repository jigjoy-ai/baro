import assert from "node:assert/strict"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { RunVerifier } from "../../src/participants/run-verifier.js"
import { createVerifyPlan } from "../../src/verify.js"
import {
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

const BOARD = source("board")

describe("RunVerifier", () => {
    it("fails closed before the Board authority is bound", async () => {
        let calls = 0
        const verifier = new RunVerifier({
            runId: "run-unbound",
            cwd: "/repo",
            verify: async () => {
                calls += 1
                return { ran: true, ok: true, failures: [], commands: [] }
            },
        })
        const env = joinWithCapture(verifier)

        env.deliverSemanticEvent(
            source("ambient-board"),
            RunVerificationRequested.create({
                runId: "run-unbound",
                verificationId: "run-unbound:verification:1",
            }),
        )
        await verifier.idle()

        assert.equal(calls, 0)
        assert.equal(env.events.filter(RunVerificationCompleted.is).length, 0)
    })

    it("accepts requests and replays only from the bound Board", async () => {
        let calls = 0
        const board = BOARD
        const verifier = new RunVerifier({
            runId: "run-authority",
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
                            status: "passed" as const,
                            durationMs: 1,
                        },
                    ],
                }
            },
        })
        verifier.setRequestAuthority(board)
        verifier.setRequestAuthority(board)
        assert.throws(
            () => verifier.setRequestAuthority(source("other-board")),
            /already bound/,
        )
        const env = joinWithCapture(verifier)
        const request = RunVerificationRequested.create({
            runId: "run-authority",
            verificationId: "run-authority:verification:1",
        })

        env.deliverSemanticEvent(source("attacker"), request)
        await verifier.idle()
        assert.equal(calls, 0)
        assert.equal(env.events.filter(RunVerificationCompleted.is).length, 0)

        env.deliverSemanticEvent(board, request)
        await verifier.idle()
        assert.equal(calls, 1)
        assert.equal(env.events.filter(RunVerificationCompleted.is).length, 1)

        env.deliverSemanticEvent(source("attacker-replay"), request)
        await verifier.idle()
        assert.equal(env.events.filter(RunVerificationCompleted.is).length, 1)
    })

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
        verifier.setRequestAuthority(BOARD)
        const env = joinWithCapture(verifier)
        const request = RunVerificationRequested.create({
            runId: "run-1",
            verificationId: "verify-1",
        })

        env.deliverSemanticEvent(BOARD, request)
        env.deliverSemanticEvent(BOARD, request)
        await verifier.idle()

        const completed = env.events.filter(RunVerificationCompleted.is)
        assert.equal(calls, 1)
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.data.verificationId, "verify-1")
        assert.equal(completed[0]?.data.status, "passed")
        assert.equal(completed[0]?.data.commands[0]?.command, "npm run test")

        env.deliverSemanticEvent(BOARD, request)
        await verifier.idle()
        assert.equal(calls, 1)
        assert.equal(env.events.filter(RunVerificationCompleted.is).length, 2)
    })

    it("reports no applicable commands as skipped, not passed or failed", async () => {
        await withTempDir("baro-run-verifier-skip-", async (dir) => {
            const verifier = new RunVerifier({
                runId: "run-skip",
                cwd: dir,
            })
            verifier.setRequestAuthority(BOARD)
            const env = joinWithCapture(verifier)
            env.deliverSemanticEvent(
                BOARD,
                RunVerificationRequested.create({
                    runId: "run-skip",
                    verificationId: "verify-skip",
                }),
            )
            await verifier.idle()

            const completed = env.events.find(RunVerificationCompleted.is)
            assert.equal(completed?.data.status, "skipped")
            assert.deepEqual(completed?.data.commands, [])
        })
    })

    it("reports partial pass plus skipped evidence as incomplete", async () => {
        const verifier = new RunVerifier({
            runId: "run-partial-skip",
            cwd: "/repo",
            verify: async () => ({
                ran: true,
                ok: true,
                failures: [],
                commands: [
                    {
                        command: "cargo test",
                        status: "passed",
                        durationMs: 10,
                    },
                    {
                        command: "npm run test",
                        status: "skipped",
                        durationMs: 1,
                        tail: "npm is not installed",
                    },
                ],
            }),
        })
        verifier.setRequestAuthority(BOARD)
        const env = joinWithCapture(verifier)
        env.deliverSemanticEvent(
            BOARD,
            RunVerificationRequested.create({
                runId: "run-partial-skip",
                verificationId: "verify-partial-skip",
            }),
        )
        await verifier.idle()

        const completed = env.events.find(RunVerificationCompleted.is)
        assert.equal(completed?.data.status, "skipped")
        assert.deepEqual(
            completed?.data.commands.map(({ status }) => status),
            ["passed", "skipped"],
        )
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
            verifier.setRequestAuthority(BOARD)
            const env = joinWithCapture(verifier)
            writeFileSync(
                pkgPath,
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )

            env.deliverSemanticEvent(
                BOARD,
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

    it("uses final PRD requirements so runtime additions enter and removals exit", async () => {
        await withTempDir("baro-run-verifier-authoritative-prd-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            const addedMarker = join(dir, "added.marker")
            const removedMarker = join(dir, "removed.marker")
            const scripts = {
                test:
                    "node -e \"const fs=require('node:fs');const marker=process.argv[1];if(marker)fs.writeFileSync(marker+'.marker','yes')\"",
            }
            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "npm@10.9.0",
                    scripts,
                }),
            )
            let finalRequirements = [
                { storyId: "S-removed", command: "npm test -- removed" },
            ]
            const verifier = new RunVerifier({
                runId: "run-authoritative-prd",
                cwd: dir,
                createFinalPlan: (cwd) =>
                    createVerifyPlan(cwd, {
                        declaredTests: finalRequirements,
                    }),
            })
            verifier.setRequestAuthority(BOARD)
            const env = joinWithCapture(verifier)

            // Simulate a runtime replan plus package-manager drift after the
            // trusted baseline snapshot. Only the final PRD test remains, but
            // the baseline npm authority must still govern its invocation.
            finalRequirements = [
                { storyId: "S-added", command: "yarn run test -- added" },
            ]
            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "yarn@4.9.2",
                    scripts,
                }),
            )
            env.deliverSemanticEvent(
                BOARD,
                RunVerificationRequested.create({
                    runId: "run-authoritative-prd",
                    verificationId: "verify-authoritative-prd",
                }),
            )
            await verifier.idle()

            const completed = env.events.find(RunVerificationCompleted.is)
            assert.equal(completed?.data.status, "passed")
            assert.deepEqual(
                completed?.data.commands.map(({ command }) => command),
                ["npm run test", "npm run test -- added"],
            )
            assert.equal(existsSync(addedMarker), true)
            assert.equal(existsSync(removedMarker), false)
        })
    })

    it("passes an A13-shaped final plan without executing npx or overflowing", async () => {
        await withTempDir("baro-run-verifier-a13-", async (dir) => {
            const binDir = join(dir, "node_modules", ".bin")
            mkdirSync(binDir, { recursive: true })
            const rstestBin = join(binDir, "rstest")
            writeFileSync(rstestBin, "#!/usr/bin/env node\nprocess.exit(0)\n")
            chmodSync(rstestBin, 0o755)
            writeFileSync(
                join(binDir, "rstest.cmd"),
                "@node -e \"process.exit(0)\" %*\r\n",
            )
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "a13-verifier-fixture",
                    private: true,
                    packageManager: "npm@10.9.0",
                    scripts: {
                        build: "node -e \"process.exit(0)\"",
                        typecheck: "node -e \"process.exit(0)\"",
                        test: "rstest run",
                        lint: "node -e \"process.exit(0)\"",
                    },
                }),
            )
            const testPaths = Array.from(
                { length: 9 },
                (_unused, index) => `tests/a13-provider-${index + 1}.test.ts`,
            )
            const declaredTests = [
                ...testPaths.map((testPath, index) => ({
                    storyId: `S${index + 1}`,
                    command: `npx rstest run ${testPath}`,
                })),
                {
                    storyId: "S9",
                    command: `npx rstest run ${testPaths[8]}`,
                },
            ]
            const verifier = new RunVerifier({
                runId: "run-a13-final-plan",
                cwd: dir,
                createFinalPlan: (cwd) =>
                    createVerifyPlan(cwd, { declaredTests }),
            })
            verifier.setRequestAuthority(BOARD)
            const env = joinWithCapture(verifier)
            env.deliverSemanticEvent(
                BOARD,
                RunVerificationRequested.create({
                    runId: "run-a13-final-plan",
                    verificationId: "verify-a13-final-plan",
                }),
            )
            await verifier.idle()

            const completed = env.events.find(RunVerificationCompleted.is)
            assert.equal(completed?.data.status, "passed")
            assert.equal(completed?.data.commands.length, 5)
            assert.equal(
                completed?.data.commands.every(({ status }) => status === "passed"),
                true,
            )
            assert.equal(
                completed?.data.commands.some(({ command }) =>
                    command.startsWith("npx ")),
                false,
            )
            const focused = completed?.data.commands.find(({ command }) =>
                command.startsWith("npm run test -- "))
            assert.ok(focused)
            for (const testPath of testPaths) {
                assert.match(focused.command, new RegExp(testPath.replaceAll(".", "\\.")))
            }
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
        verifier.setRequestAuthority(BOARD)
        const env = joinWithCapture(verifier)
        env.deliverSemanticEvent(
            BOARD,
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
        const board = source("board")
        verifier.setRequestAuthority(board)
        const env = joinWithCapture(verifier)
        env.deliverSemanticEvent(
            board,
            RunVerificationRequested.create({
                runId: "run-timeout",
                verificationId: "verify-timeout",
            }),
        )
        await started
        env.deliverSemanticEvent(
            source("attacker"),
            RunVerificationTimedOut.create({
                runId: "run-timeout",
                verificationId: "verify-timeout",
                timeoutMs: 5,
            }),
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(aborted, false)
        env.deliverSemanticEvent(
            board,
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
