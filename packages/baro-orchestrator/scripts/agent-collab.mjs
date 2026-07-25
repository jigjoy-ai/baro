import { randomUUID } from "node:crypto"
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

import { inboxFilenameForAgentId } from "./collaboration-inbox-path.mjs"

const [command, ...argv] = process.argv.slice(2)
let flags = new Map()

async function main() {
if (command === "emit") {
    const kind = required("kind")
    let decisionWaitMs = null
    let decisionId = null
    if (!["message", "help", "note", "discover", "replan", "block", "challenge"].includes(kind)) {
        fail(`unsupported kind '${kind}'`)
    }
    const record = { kind }
    if (["message", "help", "note", "discover"].includes(kind)) {
        record.eventId = safeTransportId(
            flags.get("event-id") ?? `event-${randomUUID()}`,
            "--event-id",
        )
    }
    if (kind === "challenge") {
        record.challengeId = safeTransportId(
            flags.get("challenge-id") ?? `challenge-${randomUUID()}`,
            "--challenge-id",
        )
        record.invariantId = required("invariant")
        if (!/^G-[AC][1-9]\d*$/.test(record.invariantId)) {
            fail("--invariant must be a GoalContract id such as G-A1 or G-C1")
        }
        record.reason = required("reason").trim()
        if (!record.reason) fail("--reason must contain non-whitespace text")
        if (record.reason.length > 8_000) fail("--reason exceeds 8000 characters")
    } else if (kind === "discover") {
        const raw = required("story-json")
        try {
            record.story = JSON.parse(raw)
        } catch {
            fail("--story-json must be valid JSON")
        }
        record.reason = flags.get("reason") ?? ""
    } else if (kind === "replan") {
        const raw = required("replan-json")
        try {
            record.mutation = JSON.parse(raw)
        } catch {
            fail("--replan-json must be valid JSON")
        }
        if (!validReplanMutation(record.mutation)) {
            fail(
                "--replan-json must be an object with addedStories, removedStoryIds, and modifiedDeps",
            )
        }
        record.proposalId = `replan-${randomUUID()}`
        decisionId = record.proposalId
        record.baseGraphVersion = positiveInteger("base-version")
        decisionWaitMs = boundedWaitMs()
        record.reason = flags.get("reason")?.trim() ||
            "worker proposed a runtime DAG adaptation"
    } else if (kind === "block") {
        const raw = required("requires-json")
        try {
            record.requiredStoryIds = JSON.parse(raw)
        } catch {
            fail("--requires-json must be valid JSON")
        }
        if (!validRequiredStoryIds(record.requiredStoryIds)) {
            fail("--requires-json must be a non-empty array of unique story ids")
        }
        record.blockId = `block-${randomUUID()}`
        decisionId = record.blockId
        decisionWaitMs = boundedWaitMs()
        record.reason = flags.get("reason")?.trim() ||
            "worker is blocked on prerequisite work"
    } else {
        record.text = required("text")
        if (record.text.length > 8_000) fail("--text exceeds 8000 characters")
        if (kind === "message") record.to = required("to")
    }
    const serialized = JSON.stringify(record)
    if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
        fail("event exceeds the 16384-byte collaboration transport limit")
    }
    const broker = brokerConfig()
    let receipt
    let submissionOutcomeUnknown = false
    let submissionDefinitivelyRejected = false
    if (broker) {
        try {
            receipt = await brokerRequestOrThrow(broker, "/v1/events", {
                method: "POST",
                body: serialized,
                timeoutMs: 15_000,
            })
            // Preserve fail-closed semantics even if an older broker returns
            // a structured delivery-gap receipt with a 2xx status.
            if (receipt?.status === "delivery_gap") {
                await writeStdout(JSON.stringify(receipt) + "\n")
                process.exitCode = 4
                submissionDefinitivelyRejected = true
            }
        } catch (error) {
            if (error?.definitive === true) {
                if (
                    error.status === 429 &&
                    error.value &&
                    typeof error.value === "object"
                ) {
                    // A bounded broker rejection is authoritative and may
                    // describe partial fan-out. Preserve the structured
                    // receipt on stdout; never follow it with "event queued".
                    await writeStdout(JSON.stringify(error.value) + "\n")
                    process.exitCode = 4
                    submissionDefinitivelyRejected = true
                } else {
                    fail(error.message ?? String(error))
                }
            } else if (decisionId !== null) {
                // The broker may have accepted this stable, client-generated
                // id before its HTTP receipt was lost. Never claim rejection;
                // preserve the id so the same decision can be reconciled.
                await writeOutcomeUnknown(decisionId, decisionWaitMs, kind)
                submissionOutcomeUnknown = true
            } else if (kind === "challenge") {
                await writeChallengeOutcomeUnknown(record.challengeId)
                submissionOutcomeUnknown = true
            } else if (record.eventId) {
                await writeEventOutcomeUnknown(record.eventId, kind)
                submissionOutcomeUnknown = true
            } else {
                fail(error?.message ?? String(error))
            }
        }
    } else {
        requireUnsafeFilesystemTransport()
        const session = required("session")
        record.leaseId = required("lease")
        const sessionDir = resolve(session)
        const outbox = join(sessionDir, "outbox")
        if (!existsSync(outbox)) {
            fail(`collaboration session is not active: ${session}`)
        }
        mkdirSync(outbox, { recursive: true })
        const name = `${Date.now()}-${randomUUID()}`
        const pending = join(outbox, `.${name}.tmp`)
        const path = join(outbox, `${name}.json`)
        const unsafeSerialized = JSON.stringify(record)
        if (Buffer.byteLength(unsafeSerialized, "utf8") > 16 * 1024) {
            fail("event exceeds the 16384-byte collaboration transport limit")
        }
        try {
            writeFileSync(pending, unsafeSerialized, { flag: "wx", mode: 0o600 })
            renameSync(pending, path)
        } catch (error) {
            try { unlinkSync(pending) } catch {}
            throw error
        }
    }
    if (submissionOutcomeUnknown || submissionDefinitivelyRejected) {
        // The submission branch already produced the only safe result.
    } else if (decisionId !== null) {
        let decision = null
        try {
            decision = broker
                ? await requestBrokerDecision(
                      broker,
                      decisionId,
                      decisionWaitMs,
                  )
                : await waitForDecision(
                      decisionPath(resolve(required("session")), decisionId),
                      decisionWaitMs,
                  )
        } catch {
            decision = null
        }
        if (decision === null) {
            await writeOutcomeUnknown(decisionId, decisionWaitMs, kind)
        } else {
            await writeStdout(JSON.stringify(decision) + "\n")
        }
    } else if (kind === "challenge") {
        await writeStdout(JSON.stringify(receipt ?? {
            status: "queued",
            kind,
            challengeId: record.challengeId,
            invariantId: record.invariantId,
        }) + "\n")
    } else {
        await writeStdout("event queued\n")
    }
} else if (command === "decision") {
    const proposalId = safeProposalId(required("proposal"))
    const decisionWaitMs = boundedWaitMs()
    const broker = brokerConfig()
    let decision = null
    try {
        decision = broker
            ? await requestBrokerDecision(broker, proposalId, decisionWaitMs)
            : (requireUnsafeFilesystemTransport(),
              await waitForDecision(
                  decisionPath(resolve(required("session")), proposalId),
                  decisionWaitMs,
              ))
    } catch {
        decision = null
    }
    if (decision === null) {
        await writeOutcomeUnknown(proposalId, decisionWaitMs)
    } else {
        await writeStdout(JSON.stringify(decision) + "\n")
    }
} else if (command === "inbox") {
    const broker = brokerConfig()
    if (broker) {
        const result = await brokerRequest(broker, "/v1/inbox", {
            method: "GET",
            timeoutMs: 15_000,
        })
        const messages = Array.isArray(result?.messages) ? result.messages : []
        if (messages.length === 0) {
            await writeStdout("No peer messages.\n")
        } else {
            const deliveryIds = messages.map((message) => message?.deliveryId)
            if (
                deliveryIds.some((value) =>
                    typeof value !== "string" ||
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
                )
            ) {
                fail("collaboration broker returned invalid inbox delivery ids")
            }
            // Print before acknowledgement. If the ACK request is lost, a
            // later poll may repeat stable deliveryIds (at-least-once), but an
            // already-received message is never silently discarded.
            await writeStdout(
                messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
            )
            await brokerRequest(broker, "/v1/inbox/ack", {
                method: "POST",
                body: JSON.stringify({ deliveryIds }),
                timeoutMs: 15_000,
            })
        }
    } else {
        requireUnsafeFilesystemTransport()
        const path = join(
            resolve(required("session")),
            "inbox",
            inboxFilenameForAgentId(required("agent")),
        )
        if (!existsSync(path)) {
            await writeStdout("No peer messages.\n")
        } else {
            const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
            await writeStdout(lines.slice(-20).join("\n") + "\n")
        }
    }
} else {
    await writeStdout([
        "Usage:",
        "  agent-collab.mjs emit --endpoint URL --token TOKEN --kind help --text TEXT [--event-id ID]",
        "  agent-collab.mjs emit --endpoint URL --token TOKEN --kind message --to AGENT --text TEXT [--event-id ID]",
        "  agent-collab.mjs emit --endpoint URL --token TOKEN --kind note --text TEXT [--event-id ID]",
        "  agent-collab.mjs emit --endpoint URL --token TOKEN --kind challenge --invariant G-A1 --reason TEXT [--challenge-id ID]",
        "  agent-collab.mjs emit --endpoint URL --token TOKEN --kind discover --story-json JSON [--reason TEXT] [--event-id ID]",
        "  agent-collab.mjs emit --endpoint URL --token TOKEN --kind replan --base-version N --replan-json JSON [--reason TEXT] [--wait-ms N]",
        "  agent-collab.mjs emit --endpoint URL --token TOKEN --kind block --requires-json JSON [--reason TEXT] [--wait-ms N]",
        "  agent-collab.mjs decision --endpoint URL --token TOKEN --proposal ID [--wait-ms N]",
        "  agent-collab.mjs inbox --endpoint URL --token TOKEN",
        "  On outcome_unknown, retry with the returned --event-id or --challenge-id; never mint a replacement id.",
        "  Exit 4 is a definitive structured broker rejection; do not claim that event was queued.",
        "",
    ].join("\n"))
}
}

function parseFlags(args) {
    const values = new Map()
    for (let index = 0; index < args.length; index += 1) {
        const key = args[index]
        if (!key?.startsWith("--")) fail(`unexpected argument '${key}'`)
        const value = args[index + 1]
        if (value == null || value.startsWith("--")) fail(`${key} requires a value`)
        values.set(key.slice(2), value)
        index += 1
    }
    return values
}

function required(name) {
    const value = flags.get(name)
    if (!value) fail(`--${name} is required`)
    return value
}

function brokerConfig() {
    const endpointFlag = flags.get("endpoint")
    const token = flags.get("token")
    if (endpointFlag === undefined && token === undefined) return null
    if (!endpointFlag || !token) fail("--endpoint and --token must be provided together")
    let endpoint
    try {
        endpoint = new URL(endpointFlag)
    } catch {
        fail("--endpoint must be a valid loopback HTTP URL")
    }
    if (
        endpoint.protocol !== "http:" ||
        endpoint.hostname !== "127.0.0.1" ||
        !endpoint.port ||
        endpoint.username ||
        endpoint.password ||
        (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
        endpoint.search ||
        endpoint.hash
    ) {
        fail("--endpoint must be an origin on http://127.0.0.1:PORT")
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        fail("--token is not a valid collaboration capability")
    }
    return Object.freeze({ endpoint: endpoint.origin, token })
}

function requireUnsafeFilesystemTransport() {
    if (flags.get("unsafe-filesystem") !== "true") {
        fail(
            "filesystem collaboration is disabled; use --endpoint/--token " +
            "(tests may opt in with --unsafe-filesystem true)",
        )
    }
}

async function requestBrokerDecision(broker, proposalId, waitMs) {
    const result = await brokerFetch(
        broker,
        `/v1/decisions/${encodeURIComponent(safeProposalId(proposalId))}?waitMs=${waitMs}`,
        { method: "GET", timeoutMs: waitMs + 10_000 },
    )
    if (result.status === 202) return null
    if (
        result.status !== 200 ||
        !result.value ||
        typeof result.value !== "object" ||
        !result.value.decision
    ) {
        throw new Error("collaboration broker returned an invalid decision response")
    }
    return result.value.decision
}

async function brokerRequest(broker, path, options) {
    try {
        return await brokerRequestOrThrow(broker, path, options)
    } catch (error) {
        fail(error?.message ?? String(error))
    }
}

async function brokerRequestOrThrow(broker, path, options) {
    const result = await brokerFetch(broker, path, options)
    if (result.status < 200 || result.status >= 300) {
        const error = new Error(brokerErrorMessage(result.value, result.status))
        // Most 4xx responses prove the broker rejected the request before
        // commit. A conflict can also mean a prior same-id commit, so it stays
        // outcome-unknown for decision-bearing submissions.
        error.definitive =
            result.status >= 400 &&
            result.status < 500 &&
            result.status !== 409
        error.status = result.status
        error.value = result.value
        throw error
    }
    return result.value
}

async function brokerFetch(broker, path, options) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
        const response = await fetch(`${broker.endpoint}${path}`, {
            method: options.method,
            headers: {
                authorization: `Bearer ${broker.token}`,
                ...(options.body === undefined
                    ? {}
                    : { "content-type": "application/json" }),
            },
            ...(options.body === undefined ? {} : { body: options.body }),
            signal: controller.signal,
        })
        const raw = await response.text()
        if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
            throw new Error("collaboration broker response exceeds 65536 bytes")
        }
        let value = null
        try {
            value = raw ? JSON.parse(raw) : null
        } catch {
            throw new Error("collaboration broker returned invalid JSON")
        }
        return { status: response.status, value }
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("collaboration broker request timed out")
        }
        if (
            error instanceof Error &&
            error.message.startsWith("collaboration broker ")
        ) throw error
        throw new Error(
            `collaboration broker request failed: ${error?.message ?? String(error)}`,
        )
    } finally {
        clearTimeout(timer)
    }
}

function brokerErrorMessage(value, status) {
    const detail = value && typeof value === "object" && typeof value.error === "string"
        ? value.error
        : `HTTP ${status}`
    return `collaboration broker rejected the request: ${detail}`
}

function safeProposalId(value) {
    return safeTransportId(value, "--proposal")
}

function safeTransportId(value, flagName) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
        fail(
            `${flagName} must be 1-128 safe characters starting with a letter or digit`,
        )
    }
    return value
}

function decisionPath(sessionDir, proposalId) {
    return join(sessionDir, "decisions", `${safeProposalId(proposalId)}.json`)
}

function positiveInteger(name) {
    const raw = required(name)
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1) {
        fail(`--${name} must be a positive integer`)
    }
    return value
}

function boundedWaitMs() {
    const raw = flags.get("wait-ms")
    if (raw === undefined) return 30_000
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
        fail("--wait-ms must be an integer between 1 and 300000")
    }
    return value
}

function validReplanMutation(value) {
    return Boolean(
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        hasOnlyKeys(value, [
            "addedStories",
            "removedStoryIds",
            "modifiedDeps",
        ]) &&
        Array.isArray(value.addedStories) &&
        value.addedStories.every((story) =>
            story &&
            typeof story === "object" &&
            !Array.isArray(story) &&
            hasOnlyKeys(story, [
                "id",
                "priority",
                "title",
                "description",
                "dependsOn",
                "retries",
                "acceptance",
                "tests",
                "model",
                "goalInvariantIds",
            ]),
        ) &&
        Array.isArray(value.removedStoryIds) &&
        value.modifiedDeps &&
        typeof value.modifiedDeps === "object" &&
        !Array.isArray(value.modifiedDeps),
    )
}

function validRequiredStoryIds(value) {
    return Boolean(
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 32 &&
        value.every((item) =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= 128 &&
            item.trim() === item,
        ) &&
        new Set(value).size === value.length,
    )
}

function hasOnlyKeys(value, allowed) {
    const keys = new Set(allowed)
    return Object.keys(value).every((key) => keys.has(key))
}

async function waitForDecision(path, waitMs) {
    const deadline = Date.now() + waitMs
    while (Date.now() <= deadline) {
        if (existsSync(path)) {
            try {
                const decision = JSON.parse(readFileSync(path, "utf8"))
                return decision
            } catch (error) {
                fail(`invalid decision JSON: ${error?.message ?? String(error)}`)
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return null
}

async function writeOutcomeUnknown(proposalId, waitMs, kind = "decision") {
    const reason = kind === "replan"
        ? "No authoritative runtime replan decision was observed before the local wait expired. Do not assume the proposal was applied or rejected; query the same proposal with the decision command."
        : `No authoritative ${kind} decision was observed before the local wait expired. Do not assume the request was accepted or rejected; query the same id with the decision command.`
    await writeStdout(JSON.stringify({
        ok: false,
        status: "outcome_unknown",
        proposalId,
        waitMs,
        reason,
    }) + "\n")
    process.exitCode = 3
}

async function writeChallengeOutcomeUnknown(challengeId) {
    await writeStdout(JSON.stringify({
        ok: false,
        status: "outcome_unknown",
        challengeId,
        reason:
            "The broker may have durably queued this invariant challenge before " +
            "its HTTP receipt was lost. Do not submit a replacement challenge " +
            "with a new id; report this same challengeId for reconciliation.",
    }) + "\n")
    process.exitCode = 3
}

async function writeEventOutcomeUnknown(eventId, kind) {
    await writeStdout(JSON.stringify({
        ok: false,
        status: "outcome_unknown",
        eventId,
        kind,
        reason:
            `The broker may have accepted this ${kind} event before its HTTP ` +
            "receipt was lost. Retry only with the same payload and " +
            `--event-id ${eventId}; the Bridge will deduplicate it.`,
    }) + "\n")
    process.exitCode = 3
}

class CliFailure extends Error {}

function fail(message) {
    throw new CliFailure(String(message))
}

function writeStdout(value) {
    return writeStream(process.stdout, value)
}

function writeStderr(value) {
    return writeStream(process.stderr, value)
}

function writeStream(stream, value) {
    return new Promise((resolve, reject) => {
        stream.write(value, (error) => {
            if (error) reject(error)
            else resolve()
        })
    })
}

try {
    flags = parseFlags(argv)
    await main()
} catch (error) {
    if (error instanceof CliFailure) {
        await writeStderr(`agent-collab: ${error.message}\n`)
        process.exitCode = 2
    } else {
        await writeStderr(
            `agent-collab: ${error?.message ?? String(error)}\n`,
        )
        process.exitCode = 1
    }
}
