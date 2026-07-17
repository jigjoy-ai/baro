import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, it } from "node:test"

import { withTempDir } from "./participants/helpers.js"

const exec = promisify(execFile)
const SCRIPT = join(import.meta.dirname, "..", "scripts", "agent-collab.mjs")

describe("agent-collab runtime replan transport", () => {
    it("atomically enqueues a versioned proposal and prints its correlated decision", async () => {
        await withTempDir("agent-collab-replan-", async (dir) => {
            const outbox = join(dir, "outbox")
            const decisions = join(dir, "decisions")
            mkdirSync(outbox, { recursive: true })
            mkdirSync(decisions, { recursive: true })
            const mutation = {
                addedStories: [
                    {
                        id: "S2",
                        priority: 2,
                        title: "Add migration",
                        description: "Create the runtime-discovered migration.",
                        dependsOn: ["S1"],
                        acceptance: ["migration exists"],
                        tests: ["npm test"],
                    },
                ],
                removedStoryIds: [],
                modifiedDeps: {},
            }
            const child = spawn(process.execPath, [
                SCRIPT,
                "emit",
                "--session",
                dir,
                "--lease",
                "lease-S1",
                "--kind",
                "replan",
                "--base-version",
                "4",
                "--replan-json",
                JSON.stringify(mutation),
                "--reason",
                "the migration is required",
                "--wait-ms",
                "2000",
            ])
            let stdout = ""
            let stderr = ""
            child.stdout.setEncoding("utf8")
            child.stderr.setEncoding("utf8")
            child.stdout.on("data", (chunk: string) => {
                stdout += chunk
            })
            child.stderr.on("data", (chunk: string) => {
                stderr += chunk
            })

            try {
                const recordPath = await waitForOutboxRecord(outbox)
                assert.deepEqual(
                    readdirSync(outbox).filter((name) => name.endsWith(".tmp")),
                    [],
                )
                const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
                    proposalId: string
                    leaseId: string
                    kind: string
                    baseGraphVersion: number
                    reason: string
                    mutation: unknown
                }
                assert.match(
                    record.proposalId,
                    /^replan-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                )
                assert.equal(record.leaseId, "lease-S1")
                assert.equal(record.kind, "replan")
                assert.equal(record.baseGraphVersion, 4)
                assert.equal(record.reason, "the migration is required")
                assert.deepEqual(record.mutation, mutation)

                const decision = {
                    status: "applied",
                    runId: "run-test",
                    proposalId: record.proposalId,
                    sourceStoryId: "S1",
                    leaseId: "lease-S1",
                    generation: 3,
                    baseGraphVersion: 4,
                    previousGraphVersion: 4,
                    graphVersion: 5,
                    reason: record.reason,
                    mutation,
                }
                const pending = join(decisions, `.${record.proposalId}.tmp`)
                const decisionPath = join(decisions, `${record.proposalId}.json`)
                writeFileSync(pending, JSON.stringify(decision), {
                    flag: "wx",
                    mode: 0o600,
                })
                renameSync(pending, decisionPath)

                const code = await new Promise<number | null>((resolve, reject) => {
                    child.once("error", reject)
                    child.once("close", resolve)
                })
                assert.equal(code, 0)
                assert.equal(stderr, "")
                assert.deepEqual(JSON.parse(stdout), decision)
                assert.deepEqual(readdirSync(decisions), [
                    `${record.proposalId}.json`,
                ])
            } finally {
                if (child.exitCode === null) child.kill("SIGKILL")
            }
        })
    })

    it("validates the graph version and wait bound before creating an outbox record", async () => {
        await withTempDir("agent-collab-invalid-wait-", async (dir) => {
            const outbox = join(dir, "outbox")
            mkdirSync(outbox, { recursive: true })
            const mutation = JSON.stringify({
                addedStories: [],
                removedStoryIds: [],
                modifiedDeps: {},
            })
            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "replan",
                    "--base-version",
                    "0",
                    "--replan-json",
                    mutation,
                    "--wait-ms",
                    "100",
                ]),
                (error: unknown) => {
                    const failure = error as { code?: number; stderr?: string }
                    assert.equal(failure.code, 2)
                    assert.match(failure.stderr ?? "", /positive integer/)
                    return true
                },
            )
            assert.deepEqual(readdirSync(outbox), [])

            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "replan",
                    "--base-version",
                    "1",
                    "--replan-json",
                    mutation,
                    "--wait-ms",
                    "300001",
                ]),
                (error: unknown) => {
                    const failure = error as { code?: number; stderr?: string }
                    assert.equal(failure.code, 2)
                    assert.match(failure.stderr ?? "", /between 1 and 300000/)
                    return true
                },
            )
            assert.deepEqual(readdirSync(outbox), [])

            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "replan",
                    "--base-version",
                    "1",
                    "--replan-json",
                    JSON.stringify({
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: {},
                        assumedApplied: true,
                    }),
                    "--wait-ms",
                    "100",
                ]),
                (error: unknown) => {
                    const failure = error as { code?: number; stderr?: string }
                    assert.equal(failure.code, 2)
                    assert.match(failure.stderr ?? "", /must be an object/)
                    return true
                },
            )
            assert.deepEqual(readdirSync(outbox), [])
        })
    })

    it("reports an unknown timeout outcome and recovers the same late decision", async () => {
        await withTempDir("agent-collab-late-decision-", async (dir) => {
            const outbox = join(dir, "outbox")
            const decisions = join(dir, "decisions")
            mkdirSync(outbox, { recursive: true })
            mkdirSync(decisions, { recursive: true })
            const mutation = JSON.stringify({
                addedStories: [],
                removedStoryIds: [],
                modifiedDeps: {},
            })

            let timeout: { code?: number; stdout?: string; stderr?: string }
            try {
                await exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "replan",
                    "--base-version",
                    "2",
                    "--replan-json",
                    mutation,
                    "--wait-ms",
                    "1",
                ])
                assert.fail("the local decision wait should time out")
            } catch (error) {
                timeout = error as typeof timeout
            }

            assert.equal(timeout!.code, 3)
            assert.equal(timeout!.stderr, "")
            const recordPath = await waitForOutboxRecord(outbox)
            const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
                proposalId: string
            }
            assert.deepEqual(JSON.parse(timeout!.stdout ?? ""), {
                ok: false,
                status: "outcome_unknown",
                proposalId: record.proposalId,
                waitMs: 1,
                reason: "No authoritative runtime replan decision was observed before the local wait expired. Do not assume the proposal was applied or rejected; query the same proposal with the decision command.",
            })

            const query = spawn(process.execPath, [
                SCRIPT,
                "decision",
                "--session",
                dir,
                "--proposal",
                record.proposalId,
                "--wait-ms",
                "2000",
            ])
            let stdout = ""
            let stderr = ""
            query.stdout.setEncoding("utf8")
            query.stderr.setEncoding("utf8")
            query.stdout.on("data", (chunk: string) => {
                stdout += chunk
            })
            query.stderr.on("data", (chunk: string) => {
                stderr += chunk
            })

            const decision = {
                status: "rejected",
                proposalId: record.proposalId,
                code: "stale_graph_version",
                reason: "the graph advanced while the local caller was waiting",
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 40))
            const pending = join(decisions, `.${record.proposalId}.tmp`)
            const decisionPath = join(decisions, `${record.proposalId}.json`)
            writeFileSync(pending, JSON.stringify(decision), {
                flag: "wx",
                mode: 0o600,
            })
            renameSync(pending, decisionPath)

            const code = await new Promise<number | null>((resolve, reject) => {
                query.once("error", reject)
                query.once("close", resolve)
            })
            assert.equal(code, 0)
            assert.equal(stderr, "")
            assert.deepEqual(JSON.parse(stdout), decision)
            assert.deepEqual(readdirSync(decisions), [
                `${record.proposalId}.json`,
            ])
        })
    })

    it("rejects unsafe proposal ids without probing a decision path", async () => {
        await withTempDir("agent-collab-unsafe-proposal-", async (dir) => {
            mkdirSync(join(dir, "decisions"), { recursive: true })
            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "decision",
                    "--session",
                    dir,
                    "--proposal",
                    "../../outside",
                    "--wait-ms",
                    "1",
                ]),
                (error: unknown) => {
                    const failure = error as {
                        code?: number
                        stdout?: string
                        stderr?: string
                    }
                    assert.equal(failure.code, 2)
                    assert.equal(failure.stdout, "")
                    assert.match(failure.stderr ?? "", /safe characters/)
                    return true
                },
            )
        })
    })

    it("queues a dependency block and waits for the Board decision", async () => {
        await withTempDir("agent-collab-block-", async (dir) => {
            const outbox = join(dir, "outbox")
            const decisions = join(dir, "decisions")
            mkdirSync(outbox, { recursive: true })
            mkdirSync(decisions, { recursive: true })
            const child = spawn(process.execPath, [
                SCRIPT,
                "emit",
                "--session",
                dir,
                "--lease",
                "lease-S6",
                "--kind",
                "block",
                "--requires-json",
                JSON.stringify(["S11"]),
                "--reason",
                "iterateWithAbort must integrate first",
                "--wait-ms",
                "2000",
            ])
            let stdout = ""
            let stderr = ""
            child.stdout.setEncoding("utf8")
            child.stderr.setEncoding("utf8")
            child.stdout.on("data", (chunk: string) => { stdout += chunk })
            child.stderr.on("data", (chunk: string) => { stderr += chunk })

            try {
                const recordPath = await waitForOutboxRecord(outbox)
                const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
                    blockId: string
                    leaseId: string
                    kind: string
                    requiredStoryIds: string[]
                    reason: string
                }
                assert.match(record.blockId, /^block-[0-9a-f-]{36}$/)
                assert.equal(record.leaseId, "lease-S6")
                assert.equal(record.kind, "block")
                assert.deepEqual(record.requiredStoryIds, ["S11"])
                assert.equal(record.reason, "iterateWithAbort must integrate first")

                const decision = {
                    status: "accepted",
                    runId: "run-test",
                    blockId: record.blockId,
                    storyId: "S6",
                    leaseId: "lease-S6",
                    generation: 2,
                    requiredStoryIds: ["S11"],
                    reason: record.reason,
                    graphVersion: 5,
                }
                writeFileSync(
                    join(decisions, `${record.blockId}.json`),
                    JSON.stringify(decision),
                    { mode: 0o600 },
                )
                const code = await new Promise<number | null>((resolve, reject) => {
                    child.once("error", reject)
                    child.once("close", resolve)
                })
                assert.equal(code, 0)
                assert.equal(stderr, "")
                assert.deepEqual(JSON.parse(stdout), decision)
            } finally {
                if (child.exitCode === null) child.kill("SIGKILL")
            }
        })
    })

    it("keeps the collaboration transport bounded before enqueueing", async () => {
        await withTempDir("agent-collab-oversized-", async (dir) => {
            const outbox = join(dir, "outbox")
            mkdirSync(outbox, { recursive: true })
            const mutation = JSON.stringify({
                addedStories: [
                    {
                        id: "S2",
                        priority: 2,
                        title: "Oversized story",
                        description: "x".repeat(17_000),
                        dependsOn: [],
                        acceptance: ["The oversized story is implemented."],
                        tests: ["npm test"],
                    },
                ],
                removedStoryIds: [],
                modifiedDeps: {},
            })
            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "replan",
                    "--base-version",
                    "1",
                    "--replan-json",
                    mutation,
                    "--wait-ms",
                    "1",
                ]),
                (error: unknown) => {
                    const failure = error as { code?: number; stderr?: string }
                    assert.equal(failure.code, 2)
                    assert.match(failure.stderr ?? "", /16384-byte/)
                    return true
                },
            )
            assert.deepEqual(readdirSync(outbox), [])
        })
    })
})

async function waitForOutboxRecord(outbox: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const name = readdirSync(outbox).find((candidate) =>
            candidate.endsWith(".json"),
        )
        if (name) return join(outbox, name)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail("timed out waiting for agent-collab outbox record")
}
