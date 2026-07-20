/**
 * PlannerOpenAI — Mozaik-native Planner: multi-turn tool loop that ends
 * on an assistant message carrying the PRD JSON. Same prompt as
 * PlannerClaude so providers produce comparable DAGs. Returns the raw
 * JSON string; the Rust caller parses it.
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
import { deriveGoalContract } from "../runtime/goal-contract.js"
import type { GoalEnvelope } from "../session/conversation-contract.js"

import { createCodebaseTools } from "./codebase-tools.js"
import { emitPlanLine, emitToolCall } from "./plan-events.js"
import {
    createPlannerOpenAIProgressiveSupport,
    type PlannerOpenAIProgressiveConfig,
    type PlannerOpenAIProgressiveSupport,
} from "./planner-openai-progressive.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildIntakePrompt,
    buildPlannerUserMessage,
    extractJsonObjects,
    heuristicModeContract,
    parseModeContract,
    renderModeContract,
    type ExecutionMode,
    type ModeContract,
} from "./planner-prompts.js"
import { assertRunnablePlannerPrdJson } from "./planner-validation.js"

export type {
    PlannerOpenAIPlanFragmentEvent,
    PlannerOpenAIProgressiveConfig,
} from "./planner-openai-progressive.js"

export interface RunPlannerOpenAIOptions {
    goal: string
    /** Confirmed host-owned contract; provider JSON never supplies authority. */
    goalEnvelope?: GoalEnvelope
    cwd: string
    model?: string
    projectContext?: string
    decisionDocument?: string
    /** `--quick` hard override: exactly 1 story. */
    quick?: boolean
    /** Pre-decided contract (user pick or run-intake step); skips this planner's own intake. */
    modeContract?: ModeContract
    /** Cap on inference rounds; errors if exceeded. */
    maxRounds?: number
    /** How many tool-using rounds the Planner may spend exploring before it must finalize. */
    maxExplorationRounds?: number
    /** Token budget for planning. After this, tool execution closes and the Planner must finalize. */
    maxTokens?: number
    /** Invalid final responses that may be repaired before the deterministic fallback. */
    maxFinalizationRetries?: number
    /** Default 600 s — reasoning models routinely need minutes per round;
     *  the old 120 s killed planning mid-round. */
    perRoundTimeoutSecs?: number
    /** Present only for an explicitly trusted Baro Gateway process. */
    billingCoordinator?: GatewayBillingCoordinator
    /** Optional collective-only early-plan transport. No config preserves the
     * historical one-shot final-PRD behavior byte-for-byte. */
    progressive?: PlannerOpenAIProgressiveConfig
    /** Deterministic no-network seam used by the planner state-machine tests. */
    testRuntime?: PlannerOpenAITestRuntime
}

export interface PlannerOpenAITestRuntime {
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

/**
 * Complexity-route the planner. Focused runs use the cheap floor model even on
 * high tiers; sequential/parallel burn the tier ceiling on genuine decomposition.
 * Focused precedence: BARO_PLANNER_FOCUSED_MODEL, else the passed ceiling (no
 * surprise downgrade for a local `--model`), else a cheap default.
 */
export function resolvePlannerModelName(mode: ExecutionMode, ceiling: string | undefined): string {
    if (mode === "focused") {
        return process.env.BARO_PLANNER_FOCUSED_MODEL || ceiling || "deepseek-v4-pro"
    }
    return ceiling ?? "gpt-5.5"
}

export async function runPlannerOpenAI(
    opts: RunPlannerOpenAIOptions,
): Promise<string> {
    // Intake first (cheap classifier via BARO_INTAKE_MODEL), then route the
    // planner model off the resolved mode — a pre-decided contract skips intake.
    // Same fallback as the CLI planners so intake failure behaves identically.
    const intake = opts.modeContract ?? await decideExecutionMode(opts, pickModel(opts.model ?? "gpt-5.5")).catch((e) => {
        process.stderr.write(`[planner-openai] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    process.stderr.write(`[planner-openai] intake mode=${intake.mode} confidence=${intake.confidence} reason=${oneLine(intake.reason).slice(0, 180)}\n`)

    const plannerModelName = resolvePlannerModelName(intake.mode, opts.model)
    process.stderr.write(`[planner-openai] planner model=${plannerModelName} (${intake.mode === "focused" ? "floor" : "ceiling"}, mode=${intake.mode})\n`)
    emitPlanLine(`planning approach: ${intake.mode}`)
    const model = opts.testRuntime?.model ?? pickModel(plannerModelName)

    const progressive = createPlannerOpenAIProgressiveSupport(opts.progressive)
    const baseTools = opts.testRuntime?.tools ?? createCodebaseTools(opts.cwd)
    const tools = progressive.extraTools.length > 0
        ? [...baseTools, ...progressive.extraTools]
        : baseTools
    const inferRound = opts.testRuntime?.inferRound ?? runInferenceRound
    setModelTools(model, tools)

    let context = ModelContext.create("planner")
        .addContextItem(SystemMessageItem.create(PLANNER_SYSTEM_PROMPT))
    if (progressive.systemInstruction) {
        context = context.addContextItem(
            SystemMessageItem.create(progressive.systemInstruction),
        )
    }
    context = context.addContextItem(
        UserMessageItem.create(
            buildPlannerUserMessage({
                goal: opts.goal,
                decisionDocument: opts.decisionDocument,
                quick: opts.quick,
                projectContext: opts.projectContext,
                modeContract: renderModeContract(intake),
            }),
        ),
    )

    const maxRounds = opts.maxRounds ?? 8
    // Cheap OpenAI-compatible planners usually inspect fewer files per round
    // than frontier OpenAI models. Two rounds was too short for cross-cutting
    // work and forced GLM into finalization while it was still reading code.
    const defaultExploration = opts.decisionDocument?.trim() ? 2 : 4
    const maxExplorationRounds = Math.max(1, Math.min(opts.maxExplorationRounds ?? numberEnv("BARO_PLANNER_MAX_EXPLORATION_ROUNDS", defaultExploration), maxRounds - 1))
    const maxTokens = Math.max(50_000, opts.maxTokens ?? numberEnv("BARO_PLANNER_MAX_TOKENS", 150_000))
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

        // Keep tool schemas installed even after the execution budget closes.
        // GLM/OpenRouter emits attempted calls as literal <tool_call> text when
        // schemas disappear mid-conversation; keeping them makes those calls
        // protocol-visible so we can answer them without executing anything.
        const roundPromise = inferRound(
            context,
            model,
            opts.billingCoordinator
                ? billingRoundOptions(opts.billingCoordinator, "planner", round)
                : {},
        )
        // Clear the timer once the round settles — a pending setTimeout keeps the
        // process alive for the full 600s after the work is done (see architect-openai).
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
            throw new Error(`PlannerOpenAI: round ${round} returned no items. Aborting.`)
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
                context = context.addContextItem(UserMessageItem.create(finalPlanInstruction(usage.summary(), round, maxExplorationRounds, maxTokens)))
                emitPlanLine("exploration budget reached — finalizing the PRD")
            } else if (finalRequested) {
                context = context.addContextItem(UserMessageItem.create(finalRepairInstruction(
                    "The previous response requested another tool after the exploration budget closed.",
                )))
                emitPlanLine("tool request refused after exploration budget — retrying final PRD")
            }
        } else {
            const messages = newItems.filter((i) => i.type === "message")
            if (messages.length === 0) {
                throw new Error(
                    `PlannerOpenAI: round ${round} had no tool calls and no message — stuck.`,
                )
            }
            const raw = messages.map((m) => m.text ?? "").join("\n").trim()
            if (!raw) throw new Error("PlannerOpenAI: empty final response")
            process.stderr.write(`[planner-openai] ${usage.summary()}\n`)
            try {
                return extractRunnablePlannerPrd(
                    raw,
                    progressive,
                    opts.goalEnvelope,
                )
            } catch (e) {
                invalidFinalResponses += 1
                const reason = (e as Error)?.message ?? String(e)
                if (round < maxRounds && invalidFinalResponses <= maxFinalizationRetries) {
                    finalRequested = true
                    context = context.addContextItem(UserMessageItem.create(finalRepairInstruction(reason)))
                    process.stderr.write(`[planner-openai] invalid final JSON (${reason}) — repair ${invalidFinalResponses}/${maxFinalizationRetries}\n`)
                    emitPlanLine(`invalid final PRD — repair ${invalidFinalResponses}/${maxFinalizationRetries}`)
                    continue
                }
                if (progressive.hasEarlyPlan()) {
                    process.stderr.write(
                        `[planner-openai] invalid final JSON (${reason}) — ` +
                            "repair budget exhausted; rejecting because an immutable prefix was published\n",
                    )
                    emitPlanLine("planner final PRD changed or omitted its published prefix — rejecting")
                    throw new Error(
                        `PlannerOpenAI: final PRD rejected after bounded repair attempts: ${reason}`,
                    )
                }
                process.stderr.write(`[planner-openai] invalid final JSON (${reason}) — repair budget exhausted, using fallback PRD\n`)
                emitPlanLine("planner could not produce valid PRD JSON — using one-story fallback")
                return extractRunnablePlannerPrd(
                    fallbackPrdJson(
                        opts.goal,
                        "Planner returned invalid JSON after bounded repair attempts.",
                        opts.goalEnvelope,
                    ),
                    progressive,
                    opts.goalEnvelope,
                )
            }
        }
    }

    if (progressive.hasEarlyPlan()) {
        throw new Error(
            `PlannerOpenAI: exceeded maxRounds=${maxRounds} after publishing an immutable plan prefix`,
        )
    }
    process.stderr.write(`[planner-openai] ${usage.summary()} — exceeded maxRounds=${maxRounds}, using fallback PRD\n`)
    return extractRunnablePlannerPrd(
        fallbackPrdJson(
            opts.goal,
            `Planner exceeded maxRounds=${maxRounds} without producing a final plan.`,
            opts.goalEnvelope,
        ),
        progressive,
        opts.goalEnvelope,
    )
}

function extractRunnablePlannerPrd(
    raw: string,
    progressive: PlannerOpenAIProgressiveSupport,
    goalEnvelope?: GoalEnvelope,
): string {
    const candidates = extractJsonObjects(raw)
    if (candidates.length === 0) {
        throw new Error(`no valid JSON object in response: ${raw.trim().slice(0, 200)}`)
    }
    let lastError: unknown
    for (const candidate of candidates) {
        try {
            assertRunnablePlannerPrdJson(candidate, goalEnvelope)
            progressive.reconcileFinalCandidate(candidate)
            return candidate
        } catch (error) {
            lastError = error
        }
    }
    throw lastError ?? new Error("response contained no runnable PRD object")
}

/** Standalone intake for scripts/run-intake.ts — no planner run required. */
export async function runOpenAIIntake(
    opts: Pick<RunPlannerOpenAIOptions, "goal" | "cwd" | "model" | "quick" | "projectContext" | "decisionDocument" | "billingCoordinator">,
): Promise<ModeContract> {
    return decideExecutionMode(opts, pickModel(opts.model ?? "gpt-5.5"))
}

export async function decideExecutionMode(
    opts: Pick<RunPlannerOpenAIOptions, "goal" | "quick" | "projectContext" | "decisionDocument" | "billingCoordinator">,
    plannerModel: GenerativeModel,
): Promise<ModeContract> {
    if (opts.quick) {
        return {
            mode: "focused",
            confidence: 1,
            reason: "The user explicitly invoked quick mode.",
            maxStories: 1,
            parallelism: 1,
        }
    }

    const intakeModel = pickModel(process.env.BARO_INTAKE_MODEL || plannerModel.specification.name)
    setModelTools(intakeModel, [])
    const prompt = buildIntakePrompt(opts)

    const context = ModelContext.create("intake")
        .addContextItem(SystemMessageItem.create("You classify software tasks for an autonomous PR workflow. Output JSON only."))
        .addContextItem(UserMessageItem.create(prompt))
    const result = await runInferenceRound(
        context,
        intakeModel,
        opts.billingCoordinator
            ? billingRoundOptions(opts.billingCoordinator, "intake", 1)
            : {},
    )
    const raw = result.items
        .filter((i) => i.type === "message")
        .map((i) => ((i.toJSON() as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""))
        .join("\n")
        .trim()
    return parseModeContract(raw)
}

function billingRoundOptions(
    coordinator: GatewayBillingCoordinator,
    phase: "intake" | "planner",
    round: number,
) {
    return {
        billing: {
            coordinator,
            context: {
                runId: null,
                phase,
                storyId: null,
                leaseId: null,
                generation: null,
                attempt: 1,
                turn: round,
                round,
            },
        },
    } as const
}

function numberEnv(name: string, fallback: number): number {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? n : fallback
}

function finalPlanInstruction(summary: string, round: number, maxExplorationRounds: number, maxTokens: number): string {
    return [
        "You have explored enough. Stop calling tools.",
        `Exploration round ${round}/${maxExplorationRounds}; planning budget ${maxTokens} tokens; usage so far: ${summary}.`,
        "Tool schemas remain visible only for protocol compatibility. Any further tool request will be refused.",
        "Now output ONLY the final PRD JSON matching the required schema. No markdown, no prose, no more inspection.",
        "Before emitting it, silently confirm every explicit user and ADR requirement maps to a story description and observable acceptance criterion, with no contradictions.",
        "If some details remain uncertain, encode them as acceptance criteria/tests inside the relevant story instead of continuing exploration.",
    ].join("\n")
}

function finalRepairInstruction(reason: string): string {
    return [
        `Your previous response was not an acceptable final PRD: ${oneLine(reason).slice(0, 300)}`,
        "Do not call tools and do not emit <tool_call> tags; tool execution is closed.",
        "Output ONLY one valid JSON object matching the PRD schema from the system prompt. No markdown or prose.",
    ].join("\n")
}

function closedToolOutput(): string {
    return "Tool exploration budget is closed. This call was not executed. Output the final PRD JSON now."
}

export function fallbackPrdJson(
    goal: string,
    reason: string,
    goalEnvelope?: GoalEnvelope,
): string {
    const title = oneLine(goal).slice(0, 80) || "Implement requested change"
    const goalInvariantIds = deriveGoalContract(goalEnvelope)
        ?.invariants.map(({ id }) => id) ?? []
    return JSON.stringify({
        project: "baro-run",
        branchName: `baro/${slug(title)}`,
        description: title,
        userStories: [
            {
                id: "S1",
                priority: 1,
                title,
                description: `${goal.trim()}\n\nPlanner fallback: ${reason}`,
                dependsOn: [],
                retries: 2,
                acceptance: ["The requested change is implemented without regressing existing behavior."],
                tests: ["echo \"planner fallback: run the project's relevant checks\""],
                goalInvariantIds,
                model: "heavy",
            },
        ],
    })
}

function oneLine(s: string): string {
    return s.replace(/\s+/g, " ").trim()
}

function slug(s: string): string {
    const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
    return out || "planner-fallback"
}

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

function setModelTools(model: GenerativeModel, tools: Tool[]): void {
    const m = model as unknown as { setTools?: (t: Tool[]) => void }
    if (typeof m.setTools !== "function") {
        throw new Error(
            `PlannerOpenAI: model ${model.specification.name} does not implement ToolCallingCapability`,
        )
    }
    m.setTools(tools)
}
