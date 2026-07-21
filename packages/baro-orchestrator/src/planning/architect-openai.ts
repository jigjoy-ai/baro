/**
 * ArchitectOpenAI — one-shot Architect via Mozaik's native OpenAI
 * runner: a multi-turn tool loop that ends on an assistant message with
 * no tool calls (that message is the design document). Hand-rolled
 * instead of `BaseAgentParticipant` because the Architect has no peers
 * to react to — direct iteration is half the code.
 */

import {
    FunctionCallOutputItem,
    ModelContext,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
    type Tool,
} from "@mozaik-ai/core"

import {
    createOpenAIModel,
    GenericOpenAIModel,
    inferenceFailureMeasurementPublished,
    UsageAccumulator,
    runInferenceRound,
    type OpenAIConnection,
    type OpenAIReasoningEffort,
} from "./openai-runtime.js"
import type { GatewayBillingCoordinator } from "../billing/index.js"
import {
    isRunnerTimeoutError,
    normalizeOpenAIRunnerObservation,
    unknownOpenAIRunnerObservation,
} from "../participants/dialogue-responder.js"
import type { GoalEnvelope } from "../session/conversation-contract.js"

import {
    ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import {
    parseArchitectOutcome,
    type ArchitectOutcomeContractMode,
} from "./architect-outcome.js"
import {
    observeArchitectInvocation,
    observeArchitectModelResolved,
    type ArchitectInvocationObserver,
} from "./architect-invocation.js"
import { createCodebaseTools } from "./codebase-tools.js"
import { emitPlanLine, emitToolCall } from "./plan-events.js"
import { decideExecutionMode, resolvePlannerModelName } from "./planner-openai.js"
import { heuristicModeContract, type ModeContract } from "./planner-prompts.js"

export interface RunArchitectOpenAIOptions {
    goal: string
    cwd: string
    model?: string
    /** Optional Mozaik-native OpenAI reasoning effort. */
    effort?: OpenAIReasoningEffort
    /** Explicit compatible endpoint; forces the redirectable generic adapter. */
    openaiConnection?: OpenAIConnection
    projectContext?: string
    /** Pre-decided contract (user pick or run-intake step); skips this architect's own intake. */
    modeContract?: ModeContract
    /** Cap on inference rounds; errors if exceeded. */
    maxRounds?: number
    /** How many tool-using rounds may execute before finalization is forced. */
    maxExplorationRounds?: number
    /** Token budget after which tool execution closes. */
    maxTokens?: number
    /** Malformed final responses that may be repaired before failing. */
    maxFinalizationRetries?: number
    /** Default 600 s — reasoning models can need minutes per round. */
    perRoundTimeoutSecs?: number
    /** Host-owned total phase budget forwarded by run-architect. The Rust
     * supervisor supplies separate cleanup headroom after this deadline. */
    timeoutMs?: number
    /** Present only for an explicitly trusted Baro Gateway process. */
    billingCoordinator?: GatewayBillingCoordinator
    /** Deterministic no-network seam used by the architect state-machine tests. */
    testRuntime?: ArchitectOpenAITestRuntime
    /** Host continuation hook for reusing the exact phase-one model. */
    onArchitectModelResolved?: (modelName: string) => void
    /** Optional observational telemetry emitted once per completed inference round. */
    onInvocation?: ArchitectInvocationObserver
    outcomeMode?: boolean
    /** Strict outcome phase. Defaults to the complete ADR + obligations contract. */
    outcomeContractMode?: ArchitectOutcomeContractMode
    /** Host-owned goal used to bind the Architect's obligation parent ids. */
    goalEnvelope?: GoalEnvelope
    /** Excludes the bash tool; remaining tools are project-contained reads. */
    readOnly?: boolean
}

export interface ArchitectOpenAITestRuntime {
    /** Omit to exercise production model selection without provider I/O. */
    model?: GenerativeModel
    tools: Tool[]
    inferRound: typeof runInferenceRound
}

export async function runArchitectOpenAI(
    opts: RunArchitectOpenAIOptions,
): Promise<string> {
    if (opts.timeoutMs === undefined) {
        return await runArchitectOpenAIWithinBudget(opts)
    }
    if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1) {
        throw new RangeError(
            "ArchitectOpenAI: timeoutMs must be a positive safe integer",
        )
    }

    const startedAt = Date.now()
    const deadlineAt = startedAt + opts.timeoutMs
    const controller = new AbortController()
    const phase = runArchitectOpenAIWithinBudget(
        opts,
        controller.signal,
        deadlineAt,
    )
    const timeoutError = architectPhaseTimeoutError(opts.timeoutMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(timeoutError)
            controller.abort(timeoutError)
        }, Math.max(0, deadlineAt - Date.now()))
    })
    const result = await Promise.race([phase, timeout]).finally(() =>
        clearTimeout(timer),
    )
    // Promise timers cannot fire while a synchronous adapter blocks the event
    // loop. The absolute clock remains authoritative after either branch wins.
    if (controller.signal.aborted || Date.now() >= deadlineAt) {
        controller.abort(timeoutError)
        throw timeoutError
    }
    return result
}

async function runArchitectOpenAIWithinBudget(
    opts: RunArchitectOpenAIOptions,
    phaseSignal?: AbortSignal,
    phaseDeadlineAt?: number,
): Promise<string> {
    // Intake first (cheap classifier via BARO_INTAKE_MODEL), then route the
    // architect model off the resolved mode — a pre-decided contract skips intake.
    let invocationSequence = 0
    const intake = opts.modeContract ?? await decideExecutionMode(
        opts,
        createOpenAIModel(opts.model ?? "gpt-5.5", {
            connection: opts.openaiConnection,
            reasoningEffort: opts.effort,
        }),
        {
            ...(phaseSignal ? { signal: phaseSignal } : {}),
            ...(opts.testRuntime?.inferRound
                ? { inferRound: opts.testRuntime.inferRound }
                : {}),
            onInvocation: (event) => {
                const requestedModel = event.model.specification.name
                const sequence = ++invocationSequence
                if (event.status === "succeeded") {
                    observeArchitectInvocation(
                        opts.onInvocation,
                        {
                            ...normalizeOpenAIRunnerObservation(
                                event.result.usage,
                                requestedModel,
                                event.model instanceof GenericOpenAIModel,
                            ),
                            sequence,
                        },
                        event.result.billingInvocationId !== null,
                        { phase: "intake", requestedModel },
                    )
                    return
                }
                const timedOut = isRunnerTimeoutError(event.error) ||
                    (phaseSignal?.aborted === true &&
                        isRunnerTimeoutError(phaseSignal.reason))
                observeArchitectInvocation(
                    opts.onInvocation,
                    {
                        ...unknownOpenAIRunnerObservation(
                            timedOut ? "timed_out" : "failed",
                            timedOut ? "timed_out" : "not_reported",
                            requestedModel,
                        ),
                        sequence,
                    },
                    inferenceFailureMeasurementPublished(event.error),
                    { phase: "intake", requestedModel },
                )
            },
        },
    ).catch((e) => {
        if (phaseSignal?.aborted) throw e
        process.stderr.write(`[architect-openai] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    const architectModelName = resolvePlannerModelName(intake.mode, opts.model)
    observeArchitectModelResolved(
        opts.onArchitectModelResolved,
        architectModelName,
    )
    process.stderr.write(`[architect-openai] architect model=${architectModelName} (${intake.mode === "focused" ? "floor" : "ceiling"}, mode=${intake.mode})\n`)
    emitPlanLine("designing the architecture")

    const model = opts.testRuntime?.model ?? createOpenAIModel(
        architectModelName,
        {
            connection: opts.openaiConnection,
            reasoningEffort: opts.effort,
        },
    )
    const tools = opts.testRuntime?.tools ?? createCodebaseTools(opts.cwd, {
        includeBash: opts.readOnly !== true,
    })
    const inferRound = opts.testRuntime?.inferRound ?? runInferenceRound
    setModelTools(model, tools)

    let context = ModelContext.create("architect")
        .addContextItem(SystemMessageItem.create(
            opts.outcomeMode
                ? (opts.outcomeContractMode ?? "complete") === "decision"
                    ? ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT
                    : ARCHITECT_OUTCOME_SYSTEM_PROMPT
                : ARCHITECT_SYSTEM_PROMPT,
        ))
        .addContextItem(
            UserMessageItem.create(buildArchitectUserMessage(opts.goal, opts.projectContext, intake)),
        )

    const maxRounds = opts.maxRounds ?? 12
    const maxExplorationRounds = Math.max(1, Math.min(
        opts.maxExplorationRounds ?? numberEnv("BARO_ARCHITECT_MAX_EXPLORATION_ROUNDS", 6),
        maxRounds - 1,
    ))
    const maxTokens = Math.max(50_000, opts.maxTokens ?? numberEnv("BARO_ARCHITECT_MAX_TOKENS", 150_000))
    const maxFinalizationRetries = Math.max(0, Math.floor(opts.maxFinalizationRetries ?? 2))
    const perRoundTimeoutMs: number | undefined =
        opts.perRoundTimeoutSecs !== undefined
            ? opts.perRoundTimeoutSecs * 1_000
            : opts.timeoutMs === undefined
              ? 600_000
              : undefined
    const usage = new UsageAccumulator()
    let finalRequested = false
    let invalidFinalResponses = 0

    for (let round = 1; round <= maxRounds; round++) {
        const newItems: Array<{
            type: string
            callId?: string
            name?: string
            args?: string
            text?: string
        }> = []

        // Per-round timeout via Promise.race — Mozaik's infer() exposes no
        // AbortSignal. Clear the timer once the round settles: a pending
        // setTimeout kept the subprocess alive ~10 min after finishing,
        // stalling `baro --headless`.
        // Do not remove the schemas during finalization. Some compatible
        // models otherwise serialize their next tool call into message text.
        let result: Awaited<ReturnType<typeof inferRound>>
        try {
            const roundPromise = inferRound(context, model, {
                ...(phaseSignal ? { signal: phaseSignal } : {}),
                ...(opts.billingCoordinator
                    ? {
                          billing: {
                              coordinator: opts.billingCoordinator,
                              context: {
                                  runId: null,
                                  phase: "architect",
                                  storyId: null,
                                  leaseId: null,
                                  generation: null,
                                  attempt: 1,
                                  turn: round,
                                  round,
                              },
                          },
                      }
                    : {}),
            })
            let timer: ReturnType<typeof setTimeout> | undefined
            result = perRoundTimeoutMs === undefined
                ? await roundPromise
                : await Promise.race([
                      roundPromise,
                      new Promise<never>((_, reject) => {
                          timer = setTimeout(
                              () => reject(new Error(
                                  `round ${round} timed out after ${perRoundTimeoutMs}ms`,
                              )),
                              perRoundTimeoutMs,
                          )
                      }),
                  ]).finally(() => clearTimeout(timer))
            assertArchitectPhaseDeadline(opts.timeoutMs, phaseDeadlineAt)
        } catch (error) {
            const timedOut = isRunnerTimeoutError(error) ||
                (phaseSignal?.aborted === true &&
                    isRunnerTimeoutError(phaseSignal.reason))
            observeArchitectInvocation(
                opts.onInvocation,
                {
                    ...unknownOpenAIRunnerObservation(
                        timedOut ? "timed_out" : "failed",
                        timedOut ? "timed_out" : "not_reported",
                        architectModelName,
                    ),
                    sequence: ++invocationSequence,
                },
                inferenceFailureMeasurementPublished(error),
            )
            throw error
        }
        usage.add(result.usage)
        observeArchitectInvocation(
            opts.onInvocation,
            {
                ...normalizeOpenAIRunnerObservation(
                    result.usage,
                    architectModelName,
                    model instanceof GenericOpenAIModel,
                ),
                sequence: ++invocationSequence,
            },
            typeof result.billingInvocationId === "string"
                && result.billingInvocationId.length > 0,
        )

        for (const item of result.items) {
            if (item.type === "function_call") {
                const fc = item as unknown as { callId: string; name: string; args: string }
                newItems.push({
                    type: "function_call",
                    callId: fc.callId,
                    name: fc.name,
                    args: fc.args,
                })
                context = context.addContextItem(item)
            } else if (item.type === "message") {
                const json = item.toJSON() as { content: Array<{ text: string }> }
                const text = json.content?.[0]?.text ?? ""
                newItems.push({ type: "message", text })
                context = context.addContextItem(item)
            } else if (item.type === "reasoning") {
                context = context.addContextItem(item)
            }
        }

        if (newItems.length === 0) {
            throw new Error(
                `ArchitectOpenAI: round ${round} returned no items. Aborting.`,
            )
        }

        const calls = newItems.filter((i) => i.type === "function_call")
        if (calls.length > 0) {
            emitPlanLine(`exploring — round ${round}`)
            for (const call of calls) emitToolCall(call.name ?? "tool", call.args)
        }
        for (const call of calls) {
            const tool = tools.find((t) => t.name === call.name)
            const output = finalRequested
                ? closedToolOutput()
                : tool
                  ? await runToolSafely(tool, call.args ?? "{}")
                  : `Error: tool '${call.name}' not registered`
            context = context.addContextItem(
                FunctionCallOutputItem.create(call.callId ?? "", output),
            )
        }

        if (calls.length > 0) {
            if (!finalRequested && (round >= maxExplorationRounds || usage.totalTokens >= maxTokens)) {
                finalRequested = true
                context = context.addContextItem(UserMessageItem.create(finalArchitectInstruction(
                    usage.summary(),
                    round,
                    maxExplorationRounds,
                    maxTokens,
                    opts.outcomeMode === true,
                )))
                emitPlanLine("architecture exploration budget reached — finalizing decisions")
            } else if (finalRequested) {
                context = context.addContextItem(UserMessageItem.create(architectRepairInstruction(
                    "The previous response requested another tool after the exploration budget closed.",
                    opts.outcomeMode === true,
                )))
                emitPlanLine("architect tool request refused after budget — retrying final document")
            }
        } else {
            const messages = newItems.filter((i) => i.type === "message")
            if (messages.length === 0) {
                throw new Error(
                    `ArchitectOpenAI: round ${round} had no tool calls and no message — stuck.`,
                )
            }
            const doc = messages.map((m) => m.text ?? "").join("\n").trim()
            if (!doc) {
                throw new Error("ArchitectOpenAI: empty final document")
            }
            let normalizedOutcome: string | null = null
            let invalidReason: string | null = null
            if (containsRawToolCall(doc)) {
                invalidReason = "The previous response contained a literal <tool_call> instead of the final architecture result."
            } else if (opts.outcomeMode) {
                try {
                    const decisionOnly =
                        (opts.outcomeContractMode ?? "complete") === "decision"
                    normalizedOutcome = JSON.stringify(parseArchitectOutcome(doc, {
                        requireObligations: !decisionOnly,
                        decisionOnly,
                        trustedGoalEnvelope: opts.goalEnvelope,
                    }))
                } catch (error) {
                    invalidReason = `The previous response violated ArchitectOutcomeV1: ${(error as Error).message}`
                }
            } else if (!isArchitectureDocument(doc)) {
                invalidReason = "The previous response was not an ADR decision document with the required headings and fields."
            }
            if (invalidReason) {
                invalidFinalResponses += 1
                if (round < maxRounds && invalidFinalResponses <= maxFinalizationRetries) {
                    finalRequested = true
                    context = context.addContextItem(UserMessageItem.create(architectRepairInstruction(
                        invalidReason,
                        opts.outcomeMode === true,
                    )))
                    process.stderr.write(`[architect-openai] invalid final document — repair ${invalidFinalResponses}/${maxFinalizationRetries}\n`)
                    emitPlanLine(`invalid architect document — repair ${invalidFinalResponses}/${maxFinalizationRetries}`)
                    continue
                }
                throw new Error("ArchitectOpenAI: invalid document persisted after bounded finalization repairs")
            }
            process.stderr.write(`[architect-openai] ${usage.summary()}\n`)
            return normalizedOutcome ?? doc
        }
    }

    process.stderr.write(`[architect-openai] ${usage.summary()} — exceeded maxRounds=${maxRounds}\n`)
    throw new Error(
        `ArchitectOpenAI: exceeded maxRounds=${maxRounds} without producing a final ` +
        `document. Increase maxRounds or simplify the goal.`,
    )
}

function numberEnv(name: string, fallback: number): number {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? n : fallback
}

function architectPhaseTimeoutError(timeoutMs: number): Error {
    const error = new Error(
        `ArchitectOpenAI: phase timed out after ${timeoutMs}ms`,
    )
    error.name = "TimeoutError"
    return error
}

function assertArchitectPhaseDeadline(
    timeoutMs: number | undefined,
    deadlineAt: number | undefined,
): void {
    if (
        timeoutMs !== undefined &&
        deadlineAt !== undefined &&
        Date.now() >= deadlineAt
    ) {
        throw architectPhaseTimeoutError(timeoutMs)
    }
}

function finalArchitectInstruction(summary: string, round: number, maxExplorationRounds: number, maxTokens: number, outcomeMode: boolean): string {
    return [
        "You have explored enough. Stop calling tools and finalize the architecture document.",
        `Exploration round ${round}/${maxExplorationRounds}; architecture budget ${maxTokens} tokens; usage so far: ${summary}.`,
        "Tool schemas remain visible only for protocol compatibility. Any further tool request will be refused.",
        outcomeMode
            ? "Output ONLY the exact ArchitectOutcomeV1 JSON object required by the system prompt. Do not use a markdown fence or commentary."
            : "Output ONLY the markdown decision document required by the system prompt. Do not emit tool-call markup or commentary.",
    ].join("\n")
}

function architectRepairInstruction(reason: string, outcomeMode: boolean): string {
    return [
        reason,
        "Do not call tools and do not emit <tool_call> tags; tool execution is closed.",
        outcomeMode
            ? "Output ONLY the exact ArchitectOutcomeV1 JSON object required by the system prompt. Do not use a markdown fence."
            : "Output ONLY the final markdown decision document required by the system prompt.",
    ].join("\n")
}

function closedToolOutput(): string {
    return "Tool exploration budget is closed. This call was not executed. Output the final architecture document now."
}

function containsRawToolCall(text: string): boolean {
    return /<tool_call(?:>|\s)/i.test(text)
}

function isArchitectureDocument(text: string): boolean {
    const hasAdr = /^## ADR-\d{3}:\s+.+$/m.test(text)
    const hasFields = ["Status", "Context", "Decision", "Consequences"].every(
        (field) => new RegExp(`^\\*\\*${field}:\\*\\*`, "m").test(text),
    )
    const isTrivial = /^## ADR-001: No cross-cutting decisions needed$/m.test(text)
    const hasExistingContext = /^## Existing context$/m.test(text)
    return hasAdr && hasFields && (isTrivial || hasExistingContext)
}

/** Turn any tool throw into an error string the model can read. */
async function runToolSafely(tool: Tool, argsJson: string): Promise<string> {
    let parsed: unknown
    try {
        parsed = JSON.parse(argsJson)
    } catch (e) {
        return `Error: tool args were not valid JSON: ${(e as Error)?.message ?? String(e)}`
    }
    try {
        const result = await tool.invoke(parsed)
        return typeof result === "string" ? result : JSON.stringify(result)
    } catch (e) {
        return `Error running ${tool.name}: ${(e as Error)?.message ?? String(e)}`
    }
}

/** Duck-typed rather than `instanceof`: older `GenerativeModel`s lacked ToolCallingCapability. */
function setModelTools(model: GenerativeModel, tools: Tool[]): void {
    const m = model as unknown as { setTools?: (t: Tool[]) => void }
    if (typeof m.setTools !== "function") {
        throw new Error(
            `ArchitectOpenAI: model ${model.specification.name} does not implement ToolCallingCapability`,
        )
    }
    m.setTools(tools)
}
