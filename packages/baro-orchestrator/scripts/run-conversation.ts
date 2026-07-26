/**
 * One isolated turn of Baro's durable conversation session.
 *
 * Rust owns the session lifecycle and transcript. This process receives one
 * trusted snapshot, performs bounded autonomous RepoScout policy calls plus
 * one Conversation call, writes one strictly correlated decision, reconciles
 * billing, and exits. No Mozaik run or repository tool is kept alive across
 * turns.
 */

import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    createGatewayBillingCoordinatorFromEnv,
    reconcileAndCloseGatewayBilling,
} from "../src/telemetry/billing/index.js"
import {
    createDialogueResponder,
    type DialogueBackend,
} from "../src/conversation/dialogue-responder.js"
import {
    ConversationIntake,
    type ConversationHistoryEntry,
    type ConversationRequestIntent,
    type ConversationResponder,
} from "../src/conversation/session/conversation-intake.js"
import { assertCorrelationId } from "../src/conversation/session/conversation-contract.js"
import { runFrontDoorConversationTurn } from "../src/conversation/session/conversation-frontdoor.js"
import {
    AutonomousRepositoryScanner,
    type RepositoryScoutResponder,
} from "../src/conversation/session/autonomous-repository-scout.js"
import {
    validateRepositoryBriefV1,
    type RepositoryBriefV1,
} from "../src/conversation/session/repository-brief.js"
import {
    DeterministicRepositoryScanner,
    type RepositoryContextScanner,
} from "../src/conversation/session/repository-scanner.js"
import { trustedFrontDoorBillingRunId } from "../src/conversation/session/frontdoor-billing.js"
import { withTransientRetry } from "../src/harness/transient-retry.js"

interface Args {
    inputFile: string
    resultFile: string
    repositoryBriefFile: string
    cwd: string
    llm: DialogueBackend
    model?: string
    timeoutMs?: number
    turnTimeoutMs?: number
    claudeBin?: string
    codexBin?: string
    opencodeBin?: string
    piBin?: string
}

interface TurnInput {
    schemaVersion: 1
    sessionId: string
    requestId: string
    intent: ConversationRequestIntent
    text: string
    history: ConversationHistoryEntry[]
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1_000
const PROVIDER_CLEANUP_MARGIN_MS = 30_000

function parseArgs(argv: readonly string[]): Args {
    const values = new Map<string, string>()
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]!
        if (!flag.startsWith("--")) fatal(`unexpected positional argument: ${flag}`)
        const value = argv[index + 1]
        if (value === undefined || value.startsWith("--")) {
            fatal(`${flag} requires a value`)
        }
        if (values.has(flag)) fatal(`duplicate flag: ${flag}`)
        values.set(flag, value)
        index += 1
    }
    const allowed = new Set([
        "--input-file",
        "--result-file",
        "--repository-brief-file",
        "--cwd",
        "--llm",
        "--model",
        "--timeout-ms",
        "--turn-timeout-ms",
        "--claude-bin",
        "--codex-bin",
        "--opencode-bin",
        "--pi-bin",
    ])
    for (const key of values.keys()) {
        if (!allowed.has(key)) fatal(`unknown flag: ${key}`)
    }
    const inputFile = required(values, "--input-file")
    const resultFile = required(values, "--result-file")
    const cwd = required(values, "--cwd")
    const llm = required(values, "--llm")
    if (
        llm !== "claude" &&
        llm !== "openai" &&
        llm !== "codex" &&
        llm !== "opencode" &&
        llm !== "pi"
    ) {
        fatal(`--llm must be claude, openai, codex, opencode, or pi; got ${llm}`)
    }
    const timeoutRaw = values.get("--timeout-ms")
    const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw)
    if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
    ) {
        fatal("--timeout-ms must be a positive bounded integer")
    }
    const turnTimeoutRaw = values.get("--turn-timeout-ms")
    const turnTimeoutMs = turnTimeoutRaw === undefined
        ? undefined
        : Number(turnTimeoutRaw)
    if (
        turnTimeoutMs !== undefined &&
        (!Number.isSafeInteger(turnTimeoutMs) ||
            turnTimeoutMs < 1 ||
            turnTimeoutMs > 86_400_000)
    ) {
        fatal("--turn-timeout-ms must be a positive bounded integer")
    }
    return {
        inputFile,
        resultFile,
        repositoryBriefFile: required(values, "--repository-brief-file"),
        cwd,
        llm,
        model: values.get("--model"),
        timeoutMs,
        turnTimeoutMs,
        claudeBin: values.get("--claude-bin"),
        codexBin: values.get("--codex-bin"),
        opencodeBin: values.get("--opencode-bin"),
        piBin: values.get("--pi-bin"),
    }
}

function parseTurnInput(path: string): TurnInput {
    let value: unknown
    try {
        value = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
        fatal(`cannot read conversation input: ${messageOf(error)}`)
    }
    if (!exactRecord(value, [
        "schemaVersion",
        "sessionId",
        "requestId",
        "intent",
        "text",
        "history",
    ])) {
        fatal("conversation input must use the exact v1 schema")
    }
    if (value.schemaVersion !== 1) fatal("unsupported conversation input schemaVersion")
    assertCorrelationId(value.sessionId, "sessionId")
    assertCorrelationId(value.requestId, "requestId")
    if (
        value.intent !== "goal" &&
        value.intent !== "clarification" &&
        value.intent !== "chat"
    ) {
        fatal("conversation input intent is invalid")
    }
    if (typeof value.text !== "string" || !Array.isArray(value.history)) {
        fatal("conversation input text/history is invalid")
    }
    return {
        schemaVersion: 1,
        sessionId: value.sessionId,
        requestId: value.requestId,
        intent: value.intent,
        text: value.text,
        // ConversationIntake performs strict pair/correlation/text validation.
        history: value.history as ConversationHistoryEntry[],
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const input = parseTurnInput(args.inputFile)
    const providerTimeoutMs = args.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
    const turnTimeoutMs = args.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    if (
        turnTimeoutMs - providerTimeoutMs * 2 <
        PROVIDER_CLEANUP_MARGIN_MS
    ) {
        fatal(
            "--turn-timeout-ms must fit two provider deadlines plus 30000ms cleanup",
        )
    }
    const billingRunId = trustedFrontDoorBillingRunId(input.sessionId)
    const billing = args.llm === "openai"
        ? createGatewayBillingCoordinatorFromEnv({
              runId: billingRunId,
              publishMeasurement: () => undefined,
          })
        : null
    // The front door classifies user intent; it must not inherit repository
    // instructions or gain a readable checkout merely because a harness CLI
    // normally runs inside the target project. Authentication still comes
    // from HOME, while the process cwd is a fresh empty directory.
    const isolatedCwd = mkdtempSync(join(tmpdir(), "baro-conversation-intake-"))
    let intake: ConversationIntake | null = null
    try {
        // The front door is the user's conversational partner: default the
        // claude lane to sonnet (haiku's multilingual chat is noticeably
        // weaker); explicit --model always wins. Scout keeps its own default.
        const conversationModel =
            args.model ?? (args.llm === "claude" ? "sonnet" : undefined)
        const dialogue = createDialogueResponder({
            backend: args.llm,
            cwd: isolatedCwd,
            model: conversationModel,
            timeoutMs: providerTimeoutMs,
            claudeBin: args.claudeBin,
            codexBin: args.codexBin,
            opencodeBin: args.opencodeBin,
            piBin: args.piBin,
            codexSkipGitRepoCheck: true,
            billingCoordinator: billing ?? undefined,
        })
        // Stream the user-facing message out of the growing JSON envelope so
        // the TUI can render the reply as it is composed.
        let lastStreamed = ""
        const streamDelta = (jsonSoFar: string): void => {
            const partial = extractAssistantMessagePartial(jsonSoFar)
            if (partial === null || partial === lastStreamed) return
            // A brief-upgrade retry restarts the envelope on the same
            // requestId: emit a reset so the TUI replaces, not appends.
            const reset = !partial.startsWith(lastStreamed)
            const append = reset ? partial : partial.slice(lastStreamed.length)
            lastStreamed = partial
            if (!append) return
            // stderr: the runner streams stderr lines live; stdout is
            // buffered until exit.
            process.stderr.write(
                JSON.stringify({
                    type: "conversation_delta",
                    requestId: input.requestId,
                    append,
                    ...(reset ? { reset: true } : {}),
                }) + "\n",
            )
        }
        const responder: ConversationResponder = {
            backend: args.llm,
            respond: async (request, signal) => {
                // Fast transient provider failures (an error result mid-stream,
                // capacity cooldowns) get one classified retry. Our own
                // watchdog kills (`killed`) and user aborts fail closed: the
                // turn budget only guarantees room for two provider calls.
                const result = await withTransientRetry(
                    (attempt) =>
                        dialogue(
                            {
                                runId: billingRunId,
                                messageId:
                                    attempt === 1
                                        ? request.requestId
                                        : `${request.requestId}.retry${attempt - 1}`,
                                billingRole: "conversation",
                                systemPrompt: request.systemPrompt,
                                userPrompt: request.userPrompt,
                                onDeltaText: streamDelta,
                            },
                            signal,
                        ),
                    {
                        maxWaitMs: 10_000,
                        retryable: (error) =>
                            signal?.aborted !== true &&
                            (error as { killed?: boolean }).killed !== true,
                        notice: (message) =>
                            process.stderr.write(`[run-conversation] ${message}\n`),
                    },
                )
                return typeof result === "string" ? result : result.text
            },
        }
        // Scout stays on the caller's model (or the adapter default): its
        // calls are structured policy steps where haiku is sufficient.
        const scoutDialogue = createDialogueResponder({
            backend: args.llm,
            cwd: isolatedCwd,
            model: args.model,
            timeoutMs: providerTimeoutMs,
            claudeBin: args.claudeBin,
            codexBin: args.codexBin,
            opencodeBin: args.opencodeBin,
            piBin: args.piBin,
            codexSkipGitRepoCheck: true,
            billingCoordinator: billing ?? undefined,
        })
        const scoutResponder: RepositoryScoutResponder = {
            backend: args.llm,
            respond: async (request, signal) => {
                const result = await scoutDialogue(
                    {
                        runId: billingRunId,
                        messageId:
                            `${request.contextRequestId}.scout.` +
                            `${request.step}.${request.attempt}`,
                        billingRole: "repository_scout",
                        systemPrompt: request.systemPrompt,
                        userPrompt: request.userPrompt,
                    },
                    signal,
                )
                return typeof result === "string" ? result : result.text
            },
        }
        intake = new ConversationIntake({
            sessionId: input.sessionId,
            responder,
            // This is a caller/whole-turn watchdog, not a second provider
            // deadline. Keeping it strictly above the provider deadline makes
            // billing attribution deterministic when a provider hangs.
            timeoutMs: turnTimeoutMs,
            initialHistory: input.history,
        })
        const bootstrapScanner = new DeterministicRepositoryScanner(args.cwd)
        const autonomousScanner = new AutonomousRepositoryScanner(args.cwd, {
            responder: scoutResponder,
            bootstrapScanner,
        })
        let repositoryBrief: RepositoryBriefV1 | undefined
        let repositoryBriefCaptureStarted = false
        const scanner: RepositoryContextScanner = {
            async scan(request, signal) {
                const correlation = request.correlation
                if (
                    !correlation ||
                    correlation.sessionId !== input.sessionId ||
                    correlation.requestId !== input.requestId
                ) {
                    throw new Error(
                        "repository brief capture correlation does not match the conversation turn",
                    )
                }
                if (repositoryBriefCaptureStarted) {
                    throw new Error("repository brief capture was attempted more than once")
                }
                repositoryBriefCaptureStarted = true
                const candidate = await autonomousScanner.scan(request, signal)
                repositoryBrief = validateRepositoryBriefV1(candidate)
                return repositoryBrief
            },
        }
        const response = await runFrontDoorConversationTurn({
            sessionId: input.sessionId,
            intake,
            scanner,
            repositoryTimeoutMs:
                turnTimeoutMs - providerTimeoutMs - PROVIDER_CLEANUP_MARGIN_MS,
            turnTimeoutMs,
            turn: {
                requestId: input.requestId,
                text: input.text,
                intent: input.intent,
            },
        })
        // Conversational turns legitimately skip RepoScout; a ready handoff
        // always captured a brief before validation allowed it.
        if (response.kind === "ready" && !repositoryBrief) {
            throw new Error("a ready conversation turn produced no repository brief")
        }
        if (repositoryBrief) {
            writeFileSync(args.repositoryBriefFile, JSON.stringify({
                schemaVersion: 1,
                sessionId: input.sessionId,
                requestId: input.requestId,
                repositoryBrief,
            }))
        }
        writeFileSync(args.resultFile, JSON.stringify(response))
    } finally {
        intake?.close()
        try {
            const result = await reconcileAndCloseGatewayBilling(billing)
            if (result && !result.complete) {
                process.stderr.write(
                    `[run-conversation] billing reconciliation incomplete ` +
                        `(${result.unresolvedInvocationIds.length} invocation(s))\n`,
                )
            }
        } finally {
            rmSync(isolatedCwd, { recursive: true, force: true })
        }
    }
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
    return values.get(flag) ?? fatal(`${flag} is required`)
}

function exactRecord(
    value: unknown,
    keys: readonly string[],
): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const actual = Object.keys(value)
    return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function fatal(message: string): never {
    throw new Error(message)
}

main().catch((error) => {
    process.stderr.write(`[run-conversation] ${messageOf(error)}\n`)
    process.exitCode = 1
})

/**
 * Pull the (possibly still-growing) "message" string field out of a partial
 * JSON envelope. Escape-aware; returns the unescaped prefix composed so far,
 * or null before the field starts.
 */
export function extractAssistantMessagePartial(jsonSoFar: string): string | null {
    const key = /"message"\s*:\s*"/u.exec(jsonSoFar)
    if (!key) return null
    const start = key.index + key[0].length
    let end = jsonSoFar.length
    let closed = false
    for (let index = start; index < jsonSoFar.length; index += 1) {
        const ch = jsonSoFar[index]
        if (ch === "\\") {
            index += 1
            continue
        }
        if (ch === '"') {
            end = index
            closed = true
            break
        }
    }
    let raw = jsonSoFar.slice(start, end)
    if (!closed && raw.endsWith("\\")) raw = raw.slice(0, -1)
    try {
        return JSON.parse('"' + raw + '"') as string
    } catch {
        return null
    }
}
