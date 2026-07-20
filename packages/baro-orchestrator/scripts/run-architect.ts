/**
 * Architect CLI — the Rust TUI invokes this as a subprocess instead of
 * shelling out to `claude` directly. With `--result-file` the markdown
 * decision document is written to that file and STDOUT becomes the live
 * BaroEvent stream (the Rust runner forwards it to the feed); without it,
 * STDOUT is the doc (legacy). Stderr = debug + errors; non-zero exit on failure.
 */

import { readFileSync, writeFileSync } from "fs"
import { randomUUID } from "node:crypto"

import {
    createGatewayBillingCoordinatorFromEnv,
    reconcileAndCloseGatewayBilling,
} from "../src/billing/index.js"
import { sanitizeDiagnosticText } from "../src/codex-failure-diagnostics.js"
import { runArchitectClaude } from "../src/planning/architect-claude.js"
import { runArchitectCodex } from "../src/planning/architect-codex.js"
import { runArchitectOpenAI } from "../src/planning/architect-openai.js"
import { runArchitectOpenCode } from "../src/planning/architect-opencode.js"
import { runArchitectPi } from "../src/planning/architect-pi.js"
import {
    parseArchitectOutcome,
    validateArchitectOutcomeCorrelation,
    wrapArchitectOutcome,
    type ArchitectOutcomeCorrelationV1,
} from "../src/planning/architect-outcome.js"
import {
    parseRequiredModeContract,
    type ModeContract,
} from "../src/planning/planner-prompts.js"
import { emit } from "../src/tui-protocol.js"
import {
    validateGoalEnvelope,
    type GoalEnvelope,
} from "../src/session/conversation-contract.js"

interface Args {
    goal: string
    cwd: string
    /** Native architect backend selected for this isolated planning turn. */
    llm: "claude" | "openai" | "codex" | "opencode" | "pi"
    model?: string
    effort?: string
    /** Host-owned wall-clock budget for the provider/harness call. */
    timeoutMs?: number
    contextFile?: string
    /** Operator-fixed ModeContract. OpenAI uses it instead of running intake again. */
    modeFile?: string
    /** Host-owned GoalEnvelope used to bind Architect obligation ids. */
    goalEnvelopeFile?: string
    /** When set, the doc is written here and stdout is freed for the event stream. */
    resultFile?: string
    /** Opt-in strict ArchitectOutcomeV1 transport. Mutually exclusive with resultFile. */
    outcomeFile?: string
    sessionId?: string
    goalRequestId?: string
    architectRequestId?: string
    claudeBin?: string
    codexBin?: string
    opencodeBin?: string
    piBin?: string
}

function parseArgs(argv: string[]): Args {
    let goal: string | undefined
    let cwd: string | undefined
    let llm: "claude" | "openai" | "codex" | "opencode" | "pi" | undefined
    let model: string | undefined
    let effort: string | undefined
    let timeoutMs: number | undefined
    let contextFile: string | undefined
    let modeFile: string | undefined
    let goalEnvelopeFile: string | undefined
    let resultFile: string | undefined
    let outcomeFile: string | undefined
    let sessionId: string | undefined
    let goalRequestId: string | undefined
    let architectRequestId: string | undefined
    let claudeBin: string | undefined
    let codexBin: string | undefined
    let opencodeBin: string | undefined
    let piBin: string | undefined

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "--goal":
                goal = required(argv, ++i, "--goal")
                break
            case "--cwd":
                cwd = required(argv, ++i, "--cwd")
                break
            case "--llm": {
                const v = required(argv, ++i, "--llm")
                if (v !== "claude" && v !== "openai" && v !== "codex" && v !== "opencode" && v !== "pi") {
                    fatal(`--llm must be 'claude' | 'openai' | 'codex' | 'opencode' | 'pi', got '${v}'`)
                }
                llm = v as "claude" | "openai" | "codex" | "opencode" | "pi"
                break
            }
            case "--model":
                model = required(argv, ++i, "--model")
                break
            case "--effort":
                effort = required(argv, ++i, "--effort")
                break
            case "--timeout-ms": {
                const raw = required(argv, ++i, "--timeout-ms")
                const value = Number(raw)
                if (
                    !Number.isSafeInteger(value) ||
                    value < 1 ||
                    value > 7_200_000
                ) {
                    fatal(
                        `--timeout-ms must be an integer from 1 to 7200000, got '${raw}'`,
                    )
                }
                timeoutMs = value
                break
            }
            case "--context-file":
                contextFile = required(argv, ++i, "--context-file")
                break
            case "--mode-file":
                modeFile = required(argv, ++i, "--mode-file")
                break
            case "--goal-envelope-file":
                goalEnvelopeFile = required(
                    argv,
                    ++i,
                    "--goal-envelope-file",
                )
                break
            case "--result-file":
                resultFile = required(argv, ++i, "--result-file")
                break
            case "--outcome-file":
                outcomeFile = required(argv, ++i, "--outcome-file")
                break
            case "--conversation-session-id":
                sessionId = required(argv, ++i, "--conversation-session-id")
                break
            case "--goal-request-id":
                goalRequestId = required(argv, ++i, "--goal-request-id")
                break
            case "--architect-request-id":
                architectRequestId = required(argv, ++i, "--architect-request-id")
                break
            case "--claude-bin":
                claudeBin = required(argv, ++i, "--claude-bin")
                break
            case "--codex-bin":
                codexBin = required(argv, ++i, "--codex-bin")
                break
            case "--opencode-bin":
                opencodeBin = required(argv, ++i, "--opencode-bin")
                break
            case "--pi-bin":
                piBin = required(argv, ++i, "--pi-bin")
                break
            default:
                fatal(`unknown flag: ${a}`)
        }
    }
    if (!goal) fatal("--goal is required")
    if (!cwd) fatal("--cwd is required")
    if (!llm) fatal("--llm is required")
    if (resultFile && outcomeFile) {
        fatal("--result-file and --outcome-file are mutually exclusive")
    }
    const correlationFlags = [sessionId, goalRequestId, architectRequestId]
    if (outcomeFile && correlationFlags.some((value) => !value)) {
        fatal(
            "--outcome-file requires --conversation-session-id, --goal-request-id, and --architect-request-id",
        )
    }
    if (outcomeFile && !goalEnvelopeFile) {
        fatal("--outcome-file requires --goal-envelope-file")
    }
    if (!outcomeFile && goalEnvelopeFile) {
        fatal("--goal-envelope-file requires --outcome-file")
    }
    if (!outcomeFile && correlationFlags.some((value) => value !== undefined)) {
        fatal("architect correlation flags require --outcome-file")
    }
    return {
        goal: goal!,
        cwd: cwd!,
        llm: llm!,
        model,
        effort,
        timeoutMs,
        contextFile,
        modeFile,
        goalEnvelopeFile,
        resultFile,
        outcomeFile,
        sessionId,
        goalRequestId,
        architectRequestId,
        claudeBin,
        codexBin,
        opencodeBin,
        piBin,
    }
}

function required(argv: string[], i: number, flag: string): string {
    const v = argv[i]
    if (v == null) fatal(`flag ${flag} requires a value`)
    return v!
}

function fatal(msg: string): never {
    process.stderr.write(`[run-architect] ${msg}\n`)
    process.exit(2)
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const outcomeMode = args.outcomeFile !== undefined
    let correlation: ArchitectOutcomeCorrelationV1 | undefined
    if (outcomeMode) {
        try {
            correlation = validateArchitectOutcomeCorrelation({
                sessionId: args.sessionId!,
                goalRequestId: args.goalRequestId!,
                architectRequestId: args.architectRequestId!,
            })
        } catch (error) {
            fatal(`invalid architect outcome correlation: ${(error as Error).message}`)
        }
    }
    // With a result/outcome file, stdout is the event stream — let the architect emit.
    if (args.resultFile || args.outcomeFile) process.env.BARO_PLAN_EVENTS = "1"

    let projectContext: string | undefined
    if (args.contextFile) {
        try {
            projectContext = readFileSync(args.contextFile, "utf-8")
        } catch (e) {
            process.stderr.write(
                `[run-architect] warning: could not read context file ${args.contextFile}: ${(e as Error).message}\n`,
            )
        }
    }

    let modeContract: ModeContract | undefined
    if (args.modeFile) {
        try {
            modeContract = parseRequiredModeContract(readFileSync(args.modeFile, "utf-8"))
        } catch (e) {
            fatal(`invalid --mode-file: ${(e as Error).message}`)
        }
    }

    let trustedGoalEnvelope: GoalEnvelope | undefined
    if (args.goalEnvelopeFile) {
        try {
            trustedGoalEnvelope = validateGoalEnvelope(
                JSON.parse(readFileSync(args.goalEnvelopeFile, "utf-8")),
            )
        } catch (e) {
            fatal(`invalid --goal-envelope-file: ${(e as Error).message}`)
        }
    }

    process.stderr.write(
        `[run-architect] llm=${args.llm} model=${args.model ?? "(default)"}` +
            (modeContract ? ` mode=${modeContract.mode} (pre-decided)` : "") +
            (args.timeoutMs === undefined ? "" : ` timeoutMs=${args.timeoutMs}`) +
            "\n",
    )

    let result: string
    const t0 = Date.now()
    try {
        if (args.llm === "openai") {
            if (!process.env.OPENAI_API_KEY) {
                fatal("--llm openai requires OPENAI_API_KEY to be set")
            }
            const billing = createGatewayBillingCoordinatorFromEnv({
                runId: process.env.BARO_RUN_ID ?? `architect-${randomUUID()}`,
                publishMeasurement: (measurement) => {
                    if (process.env.BARO_PLAN_EVENTS === "1") {
                        emit({ type: "model_usage", measurement })
                    }
                },
            })
            try {
                result = await runArchitectOpenAI({
                    goal: args.goal,
                    cwd: args.cwd,
                    model: args.model,
                    projectContext,
                    modeContract,
                    billingCoordinator: billing ?? undefined,
                    outcomeMode,
                    readOnly: outcomeMode,
                    goalEnvelope: trustedGoalEnvelope,
                    timeoutMs: args.timeoutMs,
                })
            } finally {
                const result = await reconcileAndCloseGatewayBilling(billing)
                if (result && !result.complete) {
                    process.stderr.write(
                        `[run-architect] billing reconciliation incomplete (${result.unresolvedInvocationIds.length} invocation(s))\n`,
                    )
                }
            }
        } else if (args.llm === "codex") {
            result = await runArchitectCodex({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                modeContract,
                codexBin: args.codexBin,
                timeoutMs: args.timeoutMs,
                outcomeMode,
                readOnly: outcomeMode,
            })
        } else if (args.llm === "opencode") {
            result = await runArchitectOpenCode({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                modeContract,
                opencodeBin: args.opencodeBin,
                timeoutMs: args.timeoutMs,
                outcomeMode,
            })
        } else if (args.llm === "pi") {
            result = await runArchitectPi({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                modeContract,
                piBin: args.piBin,
                timeoutMs: args.timeoutMs,
                outcomeMode,
            })
        } else {
            result = await runArchitectClaude({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                effort: args.effort,
                projectContext,
                modeContract,
                claudeBin: args.claudeBin,
                timeoutMs: args.timeoutMs,
                outcomeMode,
                readOnly: outcomeMode,
            })
        }
    } catch (e) {
        process.stderr.write(
            `[run-architect] FAILED after ${Date.now() - t0}ms: ${safeErrorForStderr(e)}\n`,
        )
        process.exitCode = 1
        return
    }

    let outcomeTransport: ReturnType<typeof wrapArchitectOutcome> | undefined
    if (args.outcomeFile) {
        // Provider output is untrusted and contains no authority fields. Only
        // this runner can attach the caller correlation after strict parsing.
        try {
            outcomeTransport = wrapArchitectOutcome(
                parseArchitectOutcome(result, {
                    requireObligations: true,
                    trustedGoalEnvelope,
                }),
                correlation!,
            )
        } catch (error) {
            process.stderr.write(
                `[run-architect] FAILED after ${Date.now() - t0}ms: ${safeErrorForStderr(error)}\n`,
            )
            process.exitCode = 1
            return
        }
    }
    process.stderr.write(`[run-architect] ok in ${Date.now() - t0}ms (${result.length} chars)\n`)
    if (args.outcomeFile) {
        writeFileSync(args.outcomeFile, JSON.stringify(outcomeTransport!))
        return
    }
    // Result to the file (stdout is the event stream); legacy path keeps it on stdout.
    if (args.resultFile) {
        writeFileSync(args.resultFile, result)
    } else {
        process.stdout.write(result)
    }
}

main().catch((e) => {
    process.stderr.write(`[run-architect] crashed: ${safeErrorForStderr(e, true)}\n`)
    process.exitCode = 3
})

function safeErrorForStderr(value: unknown, includeStack = false): string {
    const raw =
        value instanceof Error
            ? includeStack
                ? (value.stack ?? value.message)
                : value.message
            : String(value)
    const sanitized = sanitizeDiagnosticText(raw)
    const maxBytes = 16 * 1024
    const bytes = Buffer.from(sanitized, "utf8")
    if (bytes.length <= maxBytes) return sanitized || "unknown error"
    const marker = "…[truncated]"
    const markerBytes = Buffer.byteLength(marker, "utf8")
    return `${bytes
        .subarray(0, maxBytes - markerBytes)
        .toString("utf8")
        .replace(/\uFFFD$/u, "")}${marker}`
}
