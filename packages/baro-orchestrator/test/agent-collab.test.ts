import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { createServer, type Server } from "node:http"
import { promisify } from "node:util"
import { describe, it } from "node:test"

import {
    decodeInboxAgentId,
    encodeInboxAgentId,
    inboxFilenameForAgentId,
} from "../scripts/collaboration-inbox-path.mjs"
import { withTempDir } from "./participants/helpers.js"

const exec = promisify(execFile)
const SCRIPT = join(import.meta.dirname, "..", "scripts", "agent-collab.mjs")
const UNSAFE_FILESYSTEM_ARGS = ["--unsafe-filesystem", "true"] as const

describe("agent-collab runtime replan transport", () => {
    it("reads collision-free inboxes by the original agent id", async () => {
        await withTempDir("agent-collab-inbox-collision-", async (dir) => {
            const inbox = join(dir, "inbox")
            mkdirSync(inbox, { recursive: true })
            const slashId = "A/B"
            const questionId = "A?B"
            const slashName = inboxFilenameForAgentId(slashId)
            const questionName = inboxFilenameForAgentId(questionId)
            assert.notEqual(slashName, questionName)
            assert.equal(slashName.includes("/"), false)
            assert.equal(questionName.includes("?"), false)
            assert.equal(decodeInboxAgentId(encodeInboxAgentId(slashId)), slashId)
            assert.equal(
                decodeInboxAgentId(encodeInboxAgentId(questionId)),
                questionId,
            )

            writeFileSync(
                join(inbox, slashName),
                `${JSON.stringify({ text: "slash-only" })}\n`,
            )
            writeFileSync(
                join(inbox, questionName),
                `${JSON.stringify({ text: "question-only" })}\n`,
            )

            const slash = await exec(process.execPath, [
                SCRIPT,
                "inbox",
                "--session",
                dir,
                "--agent",
                slashId,
                ...UNSAFE_FILESYSTEM_ARGS,
            ])
            const question = await exec(process.execPath, [
                SCRIPT,
                "inbox",
                "--session",
                dir,
                "--agent",
                questionId,
                ...UNSAFE_FILESYSTEM_ARGS,
            ])
            assert.match(slash.stdout, /slash-only/u)
            assert.doesNotMatch(slash.stdout, /question-only/u)
            assert.match(question.stdout, /question-only/u)
            assert.doesNotMatch(question.stdout, /slash-only/u)
        })
    })

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
                ...UNSAFE_FILESYSTEM_ARGS,
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
                    ...UNSAFE_FILESYSTEM_ARGS,
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
                    ...UNSAFE_FILESYSTEM_ARGS,
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
                    ...UNSAFE_FILESYSTEM_ARGS,
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
                    ...UNSAFE_FILESYSTEM_ARGS,
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
                ...UNSAFE_FILESYSTEM_ARGS,
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
                    ...UNSAFE_FILESYSTEM_ARGS,
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
                ...UNSAFE_FILESYSTEM_ARGS,
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
                    ...UNSAFE_FILESYSTEM_ARGS,
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

    it("returns the queued challenge identity and rejects blank reasons", async () => {
        await withTempDir("agent-collab-challenge-", async (dir) => {
            const outbox = join(dir, "outbox")
            mkdirSync(outbox, { recursive: true })
            const result = await exec(process.execPath, [
                SCRIPT,
                "emit",
                "--session",
                dir,
                "--lease",
                "lease-S1",
                "--kind",
                "challenge",
                "--challenge-id",
                "challenge-stable-1",
                "--invariant",
                "G-A1",
                "--reason",
                "cleanup can race the terminal response",
                ...UNSAFE_FILESYSTEM_ARGS,
            ])
            const receipt = JSON.parse(result.stdout) as {
                status: string
                kind: string
                challengeId: string
                invariantId: string
            }
            assert.equal(receipt.status, "queued")
            assert.equal(receipt.kind, "challenge")
            assert.equal(receipt.invariantId, "G-A1")
            assert.equal(receipt.challengeId, "challenge-stable-1")
            const record = JSON.parse(
                readFileSync(await waitForOutboxRecord(outbox), "utf8"),
            ) as { challengeId: string; reason: string }
            assert.equal(record.challengeId, receipt.challengeId)
            assert.equal(
                record.reason,
                "cleanup can race the terminal response",
            )

            const before = readdirSync(outbox).sort()
            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "challenge",
                    "--invariant",
                    "G-A1",
                    "--reason",
                    "   ",
                    ...UNSAFE_FILESYSTEM_ARGS,
                ]),
                (error: unknown) => {
                    const failure = error as { code?: number; stderr?: string }
                    assert.equal(failure.code, 2)
                    assert.match(failure.stderr ?? "", /non-whitespace/u)
                    return true
                },
            )
            assert.deepEqual(readdirSync(outbox).sort(), before)

            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "challenge",
                    "--challenge-id",
                    "../replacement",
                    "--invariant",
                    "G-A1",
                    "--reason",
                    "must never reach the outbox",
                    ...UNSAFE_FILESYSTEM_ARGS,
                ]),
                (error: unknown) => {
                    const failure = error as { code?: number; stderr?: string }
                    assert.equal(failure.code, 2)
                    assert.match(failure.stderr ?? "", /--challenge-id must/u)
                    return true
                },
            )
            assert.deepEqual(readdirSync(outbox).sort(), before)
        })
    })

    it("submits through the authenticated broker without a worker-visible session path", async () => {
        const token = "a".repeat(43)
        let received: Record<string, unknown> | null = null
        let authorization = ""
        const server = createServer(async (request, response) => {
            authorization = request.headers.authorization ?? ""
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            received = JSON.parse(Buffer.concat(chunks).toString("utf8"))
            response.writeHead(202, { "content-type": "application/json" })
            response.end(JSON.stringify({ status: "queued", kind: "note" }))
        })
        const endpoint = await listenLoopback(server)
        try {
            const result = await exec(process.execPath, [
                SCRIPT,
                "emit",
                "--endpoint",
                endpoint,
                "--token",
                token,
                "--kind",
                "note",
                "--event-id",
                "event-brokered-finding",
                "--text",
                "brokered finding",
            ])
            assert.equal(result.stderr, "")
            assert.equal(result.stdout, "event queued\n")
            assert.equal(authorization, `Bearer ${token}`)
            assert.deepEqual(received, {
                kind: "note",
                eventId: "event-brokered-finding",
                text: "brokered finding",
            })
            assert.equal(JSON.stringify(received).includes("session"), false)
            assert.equal(JSON.stringify(received).includes("lease"), false)
        } finally {
            await closeServer(server)
        }
    })

    it("surfaces a bounded broker rejection without claiming the event was queued", async () => {
        const token = "e".repeat(43)
        const receipt = {
            ok: false,
            status: "delivery_gap",
            kind: "message",
            eventId: "event-overflow-stable",
            deliveryGaps: ["S2"],
        }
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before returning the definitive receipt.
            }
            response.writeHead(429, { "content-type": "application/json" })
            response.end(JSON.stringify(receipt))
        })
        const endpoint = await listenLoopback(server)
        try {
            let failure: { code?: number; stdout?: string; stderr?: string }
            try {
                await exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--endpoint",
                    endpoint,
                    "--token",
                    token,
                    "--kind",
                    "message",
                    "--event-id",
                    "event-overflow-stable",
                    "--to",
                    "S2",
                    "--text",
                    "bounded recipient",
                ])
                assert.fail("a definitive mailbox rejection must be non-zero")
            } catch (error) {
                failure = error as typeof failure
            }
            assert.equal(failure!.code, 4)
            assert.equal(failure!.stderr, "")
            assert.deepEqual(JSON.parse(failure!.stdout ?? ""), receipt)
            assert.doesNotMatch(failure!.stdout ?? "", /event queued/u)
        } finally {
            await closeServer(server)
        }
    })

    it("retries the same event and challenge ids after an ambiguous broker receipt", async () => {
        const token = "c".repeat(43)
        const attempts = new Map<string, Record<string, unknown>[]>()
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            const record = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
            ) as Record<string, unknown>
            const identity = String(record.eventId ?? record.challengeId ?? "")
            const records = attempts.get(identity) ?? []
            records.push(record)
            attempts.set(identity, records)
            if (records.length === 1) {
                response.destroy()
                return
            }
            response.writeHead(202, { "content-type": "application/json" })
            response.end(JSON.stringify({
                status: "queued",
                kind: record.kind,
                ...(record.eventId ? { eventId: record.eventId } : {}),
                ...(record.challengeId
                    ? { challengeId: record.challengeId }
                    : {}),
                ...(record.invariantId
                    ? { invariantId: record.invariantId }
                    : {}),
            }))
        })
        const endpoint = await listenLoopback(server)
        try {
            const cases = [
                {
                    id: "event-retry-stable",
                    idKey: "eventId",
                    args: [
                        "--kind", "note",
                        "--event-id", "event-retry-stable",
                        "--text", "retry this exact note",
                    ],
                },
                {
                    id: "challenge-retry-stable",
                    idKey: "challengeId",
                    args: [
                        "--kind", "challenge",
                        "--challenge-id", "challenge-retry-stable",
                        "--invariant", "G-A1",
                        "--reason", "retry this exact evidence",
                    ],
                },
            ] as const
            for (const testCase of cases) {
                const args = [
                    SCRIPT,
                    "emit",
                    "--endpoint",
                    endpoint,
                    "--token",
                    token,
                    ...testCase.args,
                ]
                let failure: { code?: number; stdout?: string; stderr?: string }
                try {
                    await exec(process.execPath, args)
                    assert.fail("the lost receipt must remain outcome_unknown")
                } catch (error) {
                    failure = error as typeof failure
                }
                assert.equal(failure!.code, 3)
                assert.equal(failure!.stderr, "")
                const outcome = JSON.parse(failure!.stdout ?? "") as Record<
                    string,
                    unknown
                >
                assert.equal(outcome.status, "outcome_unknown")
                assert.equal(outcome[testCase.idKey], testCase.id)

                await exec(process.execPath, args)
                const records = attempts.get(testCase.id)
                assert.equal(records?.length, 2)
                assert.deepEqual(records?.[1], records?.[0])
            }
        } finally {
            await closeServer(server)
        }
    })

    it("flushes broker inbox output before acknowledging its delivery ids", async () => {
        await withTempDir("agent-collab-stdout-ack-", async (dir) => {
            const token = "d".repeat(43)
            const outputPath = join(dir, "stdout.jsonl")
            const deliveryId = "11111111-1111-4111-8111-111111111111"
            const marker = "must-be-visible-before-ack"
            let outputWasVisibleAtAck = false
            let acknowledged: unknown = null
            const server = createServer(async (request, response) => {
                if (request.method === "GET" && request.url === "/v1/inbox") {
                    response.writeHead(200, {
                        "content-type": "application/json",
                    })
                    response.end(JSON.stringify({
                        messages: [{
                            deliveryId,
                            ts: new Date(0).toISOString(),
                            type: "agent_targeted_message",
                            data: { text: marker },
                        }],
                    }))
                    return
                }
                if (
                    request.method === "POST" &&
                    request.url === "/v1/inbox/ack"
                ) {
                    outputWasVisibleAtAck = readFileSync(outputPath, "utf8")
                        .includes(marker)
                    const chunks: Buffer[] = []
                    for await (const chunk of request) {
                        chunks.push(Buffer.from(chunk))
                    }
                    acknowledged = JSON.parse(
                        Buffer.concat(chunks).toString("utf8"),
                    )
                    response.writeHead(200, {
                        "content-type": "application/json",
                    })
                    response.end(JSON.stringify({ acknowledged: 1 }))
                    return
                }
                response.writeHead(404, { "content-type": "application/json" })
                response.end(JSON.stringify({ error: "unknown route" }))
            })
            const endpoint = await listenLoopback(server)
            const outputFd = openSync(outputPath, "w")
            try {
                const child = spawn(
                    process.execPath,
                    [
                        SCRIPT,
                        "inbox",
                        "--endpoint",
                        endpoint,
                        "--token",
                        token,
                    ],
                    { stdio: ["ignore", outputFd, "pipe"] },
                )
                let stderr = ""
                child.stderr.setEncoding("utf8")
                child.stderr.on("data", (chunk: string) => {
                    stderr += chunk
                })
                const code = await new Promise<number | null>((resolve, reject) => {
                    child.once("error", reject)
                    child.once("close", resolve)
                })
                assert.equal(code, 0)
                assert.equal(stderr, "")
                assert.equal(outputWasVisibleAtAck, true)
                assert.deepEqual(acknowledged, { deliveryIds: [deliveryId] })
                assert.match(readFileSync(outputPath, "utf8"), new RegExp(marker))
            } finally {
                closeSync(outputFd)
                await closeServer(server)
            }
        })
    })

    it("preserves a decision id when the broker accepts a POST but its receipt is lost", async () => {
        const token = "b".repeat(43)
        let acceptedProposalId = ""
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            const record = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
            ) as { proposalId?: string }
            acceptedProposalId = record.proposalId ?? ""
            response.destroy()
        })
        const endpoint = await listenLoopback(server)
        try {
            let failure: { code?: number; stdout?: string; stderr?: string }
            try {
                await exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--endpoint",
                    endpoint,
                    "--token",
                    token,
                    "--kind",
                    "replan",
                    "--base-version",
                    "2",
                    "--replan-json",
                    JSON.stringify({
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: {},
                    }),
                    "--wait-ms",
                    "100",
                ])
                assert.fail("the lost broker receipt must remain outcome_unknown")
            } catch (error) {
                failure = error as typeof failure
            }
            assert.equal(failure!.code, 3)
            assert.equal(failure!.stderr, "")
            assert.match(acceptedProposalId, /^replan-/)
            const outcome = JSON.parse(failure!.stdout ?? "") as {
                status: string
                proposalId: string
            }
            assert.equal(outcome.status, "outcome_unknown")
            assert.equal(outcome.proposalId, acceptedProposalId)
        } finally {
            await closeServer(server)
        }
    })

    it("requires an explicit unsafe flag before using the retired filesystem transport", async () => {
        await withTempDir("agent-collab-no-filesystem-fallback-", async (dir) => {
            mkdirSync(join(dir, "outbox"), { recursive: true })
            await assert.rejects(
                exec(process.execPath, [
                    SCRIPT,
                    "emit",
                    "--session",
                    dir,
                    "--lease",
                    "lease-S1",
                    "--kind",
                    "note",
                    "--text",
                    "must fail closed",
                ]),
                (error: unknown) => {
                    const failure = error as { code?: number; stderr?: string }
                    assert.equal(failure.code, 2)
                    assert.match(
                        failure.stderr ?? "",
                        /filesystem collaboration is disabled/,
                    )
                    return true
                },
            )
            assert.deepEqual(readdirSync(join(dir, "outbox")), [])
        })
    })
})

async function listenLoopback(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject)
            resolve()
        })
    })
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
}

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
