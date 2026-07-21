/**
 * Architect CLI — the Rust TUI invokes this as a subprocess instead of
 * shelling out to `claude` directly. With `--result-file` the markdown
 * decision document is written to that file and STDOUT becomes the live
 * BaroEvent stream (the Rust runner forwards it to the feed); without it,
 * STDOUT is the doc (legacy). Stderr = debug + errors; non-zero exit on failure.
 */

import {
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import {
    createGatewayBillingCoordinatorFromEnv,
    reconcileAndCloseGatewayBilling,
    type GatewayBillingCoordinator,
} from "../src/billing/index.js"
import { sanitizeDiagnosticText } from "../src/codex-failure-diagnostics.js"
import {
    DialogueResponderInvocationError,
    type DialogueResponderInvocation,
} from "../src/participants/dialogue-agent.js"
import { createDialogueResponder } from "../src/participants/dialogue-responder.js"
import { runArchitectClaude } from "../src/planning/architect-claude.js"
import { runArchitectCodex } from "../src/planning/architect-codex.js"
import type { ArchitectInvocationObserver } from "../src/planning/architect-invocation.js"
import { compileArchitectObligationSegments } from "../src/planning/architect-obligation-segments.js"
import { runArchitectOpenAI } from "../src/planning/architect-openai.js"
import { runArchitectOpenCode } from "../src/planning/architect-opencode.js"
import { runArchitectPi } from "../src/planning/architect-pi.js"
import { providerCallTimeoutError } from "../src/planning/openai-runtime.js"
import { emitPlanLine } from "../src/planning/plan-events.js"
import { effortTimeoutMs } from "../src/planning/planner-claude.js"
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
import { resolvePlannerModelName } from "../src/planning/planner-openai.js"
import { runnerMeasurement } from "../src/runner-measurement.js"
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

    const t0 = Date.now()
    const billingRunId = process.env.BARO_RUN_ID ?? `architect-${randomUUID()}`
    let billing: GatewayBillingCoordinator | null = null
    let result = ""
    let outcomeTransport: ReturnType<typeof wrapArchitectOutcome> | undefined
    let failure: unknown
    const resolvedArchitectRoute: { model?: string } = {}
    const observeDecisionInvocation: ArchitectInvocationObserver = (
        observation,
        metadata,
    ) => {
        publishArchitectInvocation(
            billingRunId,
            "decision",
            1,
            1,
            {
                backend: args.llm,
                requestedModel: metadata.requestedModel ??
                    architectDecisionModel(
                        args,
                        modeContract,
                        resolvedArchitectRoute.model,
                    ),
                observation,
                ...(metadata.measurementPublished
                    ? { measurementPublished: true }
                    : {}),
            },
            metadata.phase ?? "architect",
        )
    }
    try {
        if (args.llm === "openai") {
            billing = createGatewayBillingCoordinatorFromEnv({
                runId: billingRunId,
                publishMeasurement: (measurement) => {
                    if (process.env.BARO_PLAN_EVENTS === "1") {
                        emit({ type: "model_usage", measurement })
                    }
                },
            })
        }
        result = await runInitialArchitect(
            args,
            projectContext,
            modeContract,
            trustedGoalEnvelope,
            billing,
            resolvedArchitectRoute,
            observeDecisionInvocation,
        )
        if (
            args.outcomeFile &&
            Date.now() - t0 >= architectPhaseBudgetMs(args)
        ) {
            throw architectDeadlineError(
                architectPhaseBudgetMs(args),
                "decision phase",
            )
        }

        if (args.outcomeFile) {
            // Phase one is deliberately ADR-only. The repository-aware model
            // may still stop here with a bounded clarification request.
            const decisionOutcome = parseArchitectOutcome(result, {
                decisionOnly: true,
            })
            const completeOutcome = decisionOutcome.kind === "ready"
                ? {
                      ...decisionOutcome,
                      decisionDocument: await compileObligations({
                          args,
                          decisionDocument: decisionOutcome.decisionDocument,
                          goalEnvelope: trustedGoalEnvelope!,
                          modeContract,
                          billing,
                          billingRunId,
                          startedAtMs: t0,
                          resolvedModel: resolvedArchitectRoute.model,
                      }),
                  }
                : decisionOutcome

            // Provider fragments never cross the trusted boundary directly.
            // Reparse the host-assembled document with the unchanged complete
            // contract before attaching caller-owned correlation fields.
            result = JSON.stringify(completeOutcome)
            outcomeTransport = wrapArchitectOutcome(
                parseArchitectOutcome(result, {
                    requireObligations: true,
                    trustedGoalEnvelope,
                }),
                correlation!,
            )
        }
    } catch (e) {
        failure = e
    } finally {
        try {
            const billingResult = await reconcileAndCloseGatewayBilling(billing)
            if (billingResult && !billingResult.complete) {
                process.stderr.write(
                    `[run-architect] billing reconciliation incomplete (${billingResult.unresolvedInvocationIds.length} invocation(s))\n`,
                )
            }
        } catch (error) {
            failure ??= error
        }
    }

    if (failure !== undefined) {
        process.stderr.write(
            `[run-architect] FAILED after ${Date.now() - t0}ms: ${safeErrorForStderr(failure)}\n`,
        )
        process.exitCode = 1
        return
    }
    process.stderr.write(`[run-architect] ok in ${Date.now() - t0}ms (${result.length} chars)\n`)
    if (args.outcomeFile) {
        writeFileAtomic(args.outcomeFile, JSON.stringify(outcomeTransport!))
        return
    }
    // Result to the file (stdout is the event stream); legacy path keeps it on stdout.
    if (args.resultFile) {
        writeFileAtomic(args.resultFile, result)
    } else {
        process.stdout.write(result)
    }
}

async function runInitialArchitect(
    args: Args,
    projectContext: string | undefined,
    modeContract: ModeContract | undefined,
    trustedGoalEnvelope: GoalEnvelope | undefined,
    billing: GatewayBillingCoordinator | null,
    resolvedArchitectRoute: { model?: string },
    onInvocation: ArchitectInvocationObserver,
): Promise<string> {
    const outcomeContractMode = args.outcomeFile ? "decision" as const : undefined
    const timeoutMs = args.timeoutMs ??
        (args.outcomeFile ? architectPhaseBudgetMs(args) : undefined)
    if (args.llm === "openai") {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error("--llm openai requires OPENAI_API_KEY to be set")
        }
        return await runArchitectOpenAI({
            goal: args.goal,
            cwd: args.cwd,
            model: args.model,
            effort: architectOpenAIEffort(args.effort),
            projectContext,
            modeContract,
            billingCoordinator: billing ?? undefined,
            outcomeMode: args.outcomeFile !== undefined,
            outcomeContractMode,
            readOnly: args.outcomeFile !== undefined,
            goalEnvelope: trustedGoalEnvelope,
            timeoutMs,
            onArchitectModelResolved: (modelName) => {
                resolvedArchitectRoute.model = modelName
            },
            onInvocation,
        })
    }
    if (args.llm === "codex") {
        return await runArchitectCodex({
            goal: args.goal,
            cwd: args.cwd,
            model: args.model,
            effort: architectCompilerEffort(args.effort),
            projectContext,
            modeContract,
            codexBin: args.codexBin,
            timeoutMs,
            outcomeMode: args.outcomeFile !== undefined,
            outcomeContractMode,
            readOnly: args.outcomeFile !== undefined,
            onInvocation,
        })
    }
    if (args.llm === "opencode") {
        return await runArchitectOpenCode({
            goal: args.goal,
            cwd: args.cwd,
            model: args.model,
            projectContext,
            modeContract,
            opencodeBin: args.opencodeBin,
            timeoutMs,
            outcomeMode: args.outcomeFile !== undefined,
            outcomeContractMode,
            onInvocation,
        })
    }
    if (args.llm === "pi") {
        return await runArchitectPi({
            goal: args.goal,
            cwd: args.cwd,
            model: args.model,
            projectContext,
            modeContract,
            piBin: args.piBin,
            timeoutMs,
            outcomeMode: args.outcomeFile !== undefined,
            outcomeContractMode,
            onInvocation,
        })
    }
    return await runArchitectClaude({
        goal: args.goal,
        cwd: args.cwd,
        model: args.model,
        effort: args.effort,
        projectContext,
        modeContract,
        claudeBin: args.claudeBin,
        timeoutMs,
        outcomeMode: args.outcomeFile !== undefined,
        outcomeContractMode,
        readOnly: args.outcomeFile !== undefined,
        onInvocation,
    })
}

async function compileObligations(input: {
    args: Args
    decisionDocument: string
    goalEnvelope: GoalEnvelope
    modeContract: ModeContract | undefined
    billing: GatewayBillingCoordinator | null
    billingRunId: string
    startedAtMs: number
    resolvedModel?: string
}): Promise<string> {
    const totalBudgetMs = architectPhaseBudgetMs(input.args)
    const remainingMs = totalBudgetMs - (Date.now() - input.startedAtMs)
    if (remainingMs < 1) {
        throw architectDeadlineError(totalBudgetMs, "obligation compilation")
    }

    const runtimeCwd = mkdtempSync(join(tmpdir(), "baro-architect-obligations-"))
    const controller = new AbortController()
    const timeoutError = architectDeadlineError(
        totalBudgetMs,
        "obligation compilation",
    )
    const timer = setTimeout(() => controller.abort(timeoutError), remainingMs)
    let callOrdinal = 0
    try {
        const responder = createDialogueResponder({
            backend: input.args.llm,
            cwd: runtimeCwd,
            model: input.resolvedModel ??
                architectCompilerModel(input.args, input.modeContract),
            effort: architectResponderEffort(input.args),
            timeoutMs: remainingMs,
            claudeBin: input.args.claudeBin,
            codexBin: input.args.codexBin,
            opencodeBin: input.args.opencodeBin,
            piBin: input.args.piBin,
            codexSkipGitRepoCheck: true,
            safeReadOnlyEvaluator: true,
            diagnosticLabel: `${input.args.llm}-architect`,
            billingCoordinator: input.billing ?? undefined,
        })
        const compiled = await compileArchitectObligationSegments({
            decisionDocument: input.decisionDocument,
            goalEnvelope: input.goalEnvelope,
            signal: controller.signal,
            onProgress: (event) => {
                const detail =
                    `batch=${event.batchId} invariants=${event.invariantIds.join(",")}` +
                    (event.attempt === undefined ? "" : ` attempt=${event.attempt}`) +
                    (event.obligationCount === undefined
                        ? ""
                        : ` obligations=${event.obligationCount}`) +
                    (event.childBatchIds === undefined
                        ? ""
                        : ` children=${event.childBatchIds.join(",")}`)
                process.stderr.write(
                    `[architect-obligations] ${event.type} ${detail}\n`,
                )
                emitPlanLine(`architecture obligations: ${event.type.replace(/_/gu, " ")} (${detail})`)
            },
            respond: async (request, signal) => {
                const invocationOrdinal = ++callOrdinal
                const messageId =
                    `${input.args.architectRequestId}.obligations.${invocationOrdinal}`
                try {
                    const response = await responder(
                        {
                            runId: input.billingRunId,
                            messageId,
                            billingPhase: "architect",
                            billingAttempt: Math.max(1, request.attempt),
                            systemPrompt: request.systemPrompt,
                            userPrompt: request.userPrompt,
                        },
                        signal ?? controller.signal,
                    )
                    if (typeof response === "string") return response
                    publishArchitectInvocation(
                        input.billingRunId,
                        "obligations",
                        invocationOrdinal,
                        request.attempt,
                        response.invocation,
                    )
                    return response.text
                } catch (error) {
                    if (error instanceof DialogueResponderInvocationError) {
                        publishArchitectInvocation(
                            input.billingRunId,
                            "obligations",
                            invocationOrdinal,
                            request.attempt,
                            error.invocation,
                        )
                    }
                    throw error
                }
            },
        })
        // A child exit and the deadline timer can become runnable in the same
        // event-loop turn. The absolute clock remains authoritative even if
        // the successful child callback happens to run first.
        if (
            controller.signal.aborted ||
            Date.now() - input.startedAtMs >= totalBudgetMs
        ) throw timeoutError
        return compiled.decisionDocument
    } catch (error) {
        if (controller.signal.aborted) throw timeoutError
        throw error
    } finally {
        clearTimeout(timer)
        rmSync(runtimeCwd, { recursive: true, force: true })
    }
}

function architectPhaseBudgetMs(args: Args): number {
    return args.timeoutMs ??
        (args.llm === "claude" ? effortTimeoutMs(args.effort) : 600_000)
}

function architectDeadlineError(totalBudgetMs: number, stage: string): Error {
    const error = providerCallTimeoutError(totalBudgetMs)
    error.message =
        `Architect ${stage} exceeded the shared ${totalBudgetMs}ms phase budget`
    return error
}

function architectCompilerModel(
    args: Args,
    modeContract: ModeContract | undefined,
): string | undefined {
    if (args.llm === "claude") return args.model ?? "opus"
    if (args.llm === "openai") {
        return modeContract
            ? resolvePlannerModelName(modeContract.mode, args.model)
            : args.model ?? "gpt-5.5"
    }
    return args.model
}

function architectDecisionModel(
    args: Args,
    modeContract: ModeContract | undefined,
    resolvedModel: string | undefined,
): string | null {
    if (resolvedModel) return resolvedModel
    if (args.llm === "claude") return args.model ?? "opus"
    if (args.llm === "codex") return args.model ?? "codex-default"
    if (args.llm === "opencode") return args.model ?? "opencode-default"
    if (args.llm === "pi") return args.model ?? "pi-default"
    return architectCompilerModel(args, modeContract) ?? null
}

function architectCompilerEffort(
    effort: string | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
    return effort === "low" || effort === "medium" || effort === "high" ||
        effort === "xhigh" || effort === "max"
        ? effort
        : undefined
}

function architectOpenAIEffort(
    effort: string | undefined,
): "low" | "medium" | "high" | "xhigh" | undefined {
    const normalized = architectCompilerEffort(effort)
    // Codex/Claude call their top setting "max"; OpenAI's equivalent native
    // Responses setting is "xhigh". Both Architect phases use this same map.
    return normalized === "max" ? "xhigh" : normalized
}

function architectResponderEffort(
    args: Args,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
    return args.llm === "openai"
        ? architectOpenAIEffort(args.effort)
        : architectCompilerEffort(args.effort)
}

function publishArchitectInvocation(
    runId: string,
    lane: "decision" | "obligations",
    callOrdinal: number,
    attempt: number,
    invocation: DialogueResponderInvocation,
    phase: "intake" | "architect" = "architect",
): void {
    if (
        invocation.measurementPublished ||
        process.env.BARO_PLAN_EVENTS !== "1"
    ) return
    emit({
        type: "model_usage",
        measurement: runnerMeasurement(
            {
                invocationBaseId:
                    `${runId}:architect-${lane}:${callOrdinal}`,
                runId,
                phase,
                storyId: null,
                attempt,
                backend: invocation.backend,
                requestedModel: invocation.requestedModel,
            },
            invocation.observation,
        ),
    })
}

function writeFileAtomic(path: string, contents: string): void {
    const temporary = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    try {
        writeFileSync(temporary, contents, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        })
        renameSync(temporary, path)
    } finally {
        rmSync(temporary, { force: true })
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
