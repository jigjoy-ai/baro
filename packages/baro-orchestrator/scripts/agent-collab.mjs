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

const [command, ...argv] = process.argv.slice(2)
const flags = parseFlags(argv)

if (command === "emit") {
    const session = required("session")
    const leaseId = required("lease")
    const kind = required("kind")
    let decisionWaitMs = null
    let decisionId = null
    if (!["message", "help", "note", "discover", "replan", "block"].includes(kind)) {
        fail(`unsupported kind '${kind}'`)
    }
    const record = { leaseId, kind }
    if (kind === "discover") {
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
    const sessionDir = resolve(session)
    const outbox = join(sessionDir, "outbox")
    if (!existsSync(outbox)) fail(`collaboration session is not active: ${session}`)
    mkdirSync(outbox, { recursive: true })
    const name = `${Date.now()}-${randomUUID()}`
    const pending = join(outbox, `.${name}.tmp`)
    const path = join(outbox, `${name}.json`)
    const serialized = JSON.stringify(record)
    if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
        fail("event exceeds the 16384-byte collaboration transport limit")
    }
    try {
        writeFileSync(pending, serialized, { flag: "wx", mode: 0o600 })
        renameSync(pending, path)
    } catch (error) {
        try { unlinkSync(pending) } catch {}
        throw error
    }
    if (decisionId !== null) {
        const decision = await waitForDecision(
            decisionPath(sessionDir, decisionId),
            decisionWaitMs,
        )
        if (decision === null) {
            writeOutcomeUnknown(decisionId, decisionWaitMs, kind)
        } else {
            process.stdout.write(JSON.stringify(decision) + "\n")
        }
    } else {
        process.stdout.write("event queued\n")
    }
} else if (command === "decision") {
    const session = required("session")
    const proposalId = safeProposalId(required("proposal"))
    const decisionWaitMs = boundedWaitMs()
    const decision = await waitForDecision(
        decisionPath(resolve(session), proposalId),
        decisionWaitMs,
    )
    if (decision === null) {
        writeOutcomeUnknown(proposalId, decisionWaitMs)
    } else {
        process.stdout.write(JSON.stringify(decision) + "\n")
    }
} else if (command === "inbox") {
    const session = required("session")
    const agent = safeName(required("agent"))
    const path = join(resolve(session), "inbox", `${agent}.jsonl`)
    if (!existsSync(path)) {
        process.stdout.write("No peer messages.\n")
    } else {
        const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
        process.stdout.write(lines.slice(-20).join("\n") + "\n")
    }
} else {
    process.stdout.write([
        "Usage:",
        "  agent-collab.mjs emit --session DIR --lease ID --kind help --text TEXT",
        "  agent-collab.mjs emit --session DIR --lease ID --kind message --to AGENT --text TEXT",
        "  agent-collab.mjs emit --session DIR --lease ID --kind note --text TEXT",
        "  agent-collab.mjs emit --session DIR --lease ID --kind discover --story-json JSON [--reason TEXT]",
        "  agent-collab.mjs emit --session DIR --lease ID --kind replan --base-version N --replan-json JSON [--reason TEXT] [--wait-ms N]",
        "  agent-collab.mjs emit --session DIR --lease ID --kind block --requires-json JSON [--reason TEXT] [--wait-ms N]",
        "  agent-collab.mjs decision --session DIR --proposal ID [--wait-ms N]",
        "  agent-collab.mjs inbox --session DIR --agent AGENT",
        "",
    ].join("\n"))
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

function safeName(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function safeProposalId(value) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
        fail(
            "--proposal must be 1-128 safe characters starting with a letter or digit",
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

function writeOutcomeUnknown(proposalId, waitMs, kind = "decision") {
    const reason = kind === "replan"
        ? "No authoritative runtime replan decision was observed before the local wait expired. Do not assume the proposal was applied or rejected; query the same proposal with the decision command."
        : `No authoritative ${kind} decision was observed before the local wait expired. Do not assume the request was accepted or rejected; query the same id with the decision command.`
    process.stdout.write(JSON.stringify({
        ok: false,
        status: "outcome_unknown",
        proposalId,
        waitMs,
        reason,
    }) + "\n")
    process.exitCode = 3
}

function fail(message) {
    process.stderr.write(`agent-collab: ${message}\n`)
    process.exit(2)
}
