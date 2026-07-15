/**
 * ArchitectOpenAI — one-shot Architect via Mozaik's native OpenAI
 * runner: a multi-turn tool loop that ends on an assistant message with
 * no tool calls (that message is the design document). Hand-rolled
 * instead of `BaseAgentParticipant` because the Architect has no peers
 * to react to — direct iteration is half the code.
 */

import {
    FunctionCallOutputItem,
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    ModelContext,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
    type Tool,
} from "@mozaik-ai/core"

import {
    GenericOpenAIModel,
    UsageAccumulator,
    runInferenceRound,
} from "./openai-runtime.js"
import type { GatewayBillingCoordinator } from "../billing/index.js"

import {
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import { parseArchitectOutcome } from "./architect-outcome.js"
import { createCodebaseTools } from "./codebase-tools.js"
import { emitPlanLine, emitToolCall } from "./plan-events.js"
import { decideExecutionMode, resolvePlannerModelName } from "./planner-openai.js"
import { heuristicModeContract, type ModeContract } from "./planner-prompts.js"

export interface RunArchitectOpenAIOptions {
    goal: string
    cwd: string
    model?: string
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
    /** Present only for an explicitly trusted Baro Gateway process. */
    billingCoordinator?: GatewayBillingCoordinator
    /** Deterministic no-network seam used by the architect state-machine tests. */
    testRuntime?: ArchitectOpenAITestRuntime
    outcomeMode?: boolean
    /** Excludes the bash tool; remaining tools are project-contained reads. */
    readOnly?: boolean
}

export interface ArchitectOpenAITestRuntime {
    model: GenerativeModel
    tools: Tool[]
    inferRound: typeof runInferenceRound
}

function pickModel(name: string): GenerativeModel {
    switch (name) {
        case "gpt-5.5":
            return new Gpt55()
        case "gpt-5.4":
            return new Gpt54()
        case "gpt-5.4-mini":
            return new Gpt54Mini()
        case "gpt-5.4-nano":
            return new Gpt54Nano()
        default:
            process.stderr.write(
                `[pickModel] Using model "${name}" as-is with the OpenAI API.\n`,
            )
            return new GenericOpenAIModel(name)
    }
}

export async function runArchitectOpenAI(
    opts: RunArchitectOpenAIOptions,
): Promise<string> {
    // Intake first (cheap classifier via BARO_INTAKE_MODEL), then route the
    // architect model off the resolved mode — a pre-decided contract skips intake.
    const intake = opts.modeContract ?? await decideExecutionMode(opts, pickModel(opts.model ?? "gpt-5.5")).catch((e) => {
        process.stderr.write(`[architect-openai] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    const architectModelName = resolvePlannerModelName(intake.mode, opts.model)
    process.stderr.write(`[architect-openai] architect model=${architectModelName} (${intake.mode === "focused" ? "floor" : "ceiling"}, mode=${intake.mode})\n`)
    emitPlanLine("designing the architecture")

    const model = opts.testRuntime?.model ?? pickModel(architectModelName)
    const tools = opts.testRuntime?.tools ?? createCodebaseTools(opts.cwd, {
        includeBash: opts.readOnly !== true,
    })
    const inferRound = opts.testRuntime?.inferRound ?? runInferenceRound
    setModelTools(model, tools)

    let context = ModelContext.create("architect")
        .addContextItem(SystemMessageItem.create(
            opts.outcomeMode
                ? ARCHITECT_OUTCOME_SYSTEM_PROMPT
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
    const perRoundTimeoutMs = (opts.perRoundTimeoutSecs ?? 600) * 1000
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
        const roundPromise = inferRound(
            context,
            model,
            opts.billingCoordinator
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
                : {},
        )
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`round ${round} timed out after ${perRoundTimeoutMs}ms`)), perRoundTimeoutMs)
        })
        const result = await Promise.race([roundPromise, timeoutPromise]).finally(() => clearTimeout(timer))
        usage.add(result.usage)

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
                    normalizedOutcome = JSON.stringify(parseArchitectOutcome(doc))
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
