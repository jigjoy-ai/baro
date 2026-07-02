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

import { createCodebaseTools } from "./codebase-tools.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildIntakePrompt,
    buildPlannerUserMessage,
    extractJsonObject,
    parseModeContract,
    renderModeContract,
    type ModeContract,
} from "./planner-prompts.js"

export interface RunPlannerOpenAIOptions {
    goal: string
    cwd: string
    model?: string
    projectContext?: string
    decisionDocument?: string
    /** `--quick` hard override: exactly 1 story. */
    quick?: boolean
    /** Cap on inference rounds; errors if exceeded. */
    maxRounds?: number
    /** How many tool-using rounds the Planner may spend exploring before it must finalize. */
    maxExplorationRounds?: number
    /** Token budget for planning. After this, tools are disabled and the Planner must finalize. */
    maxTokens?: number
    /** Default 600 s — reasoning models routinely need minutes per round;
     *  the old 120 s killed planning mid-round. */
    perRoundTimeoutSecs?: number
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

export async function runPlannerOpenAI(
    opts: RunPlannerOpenAIOptions,
): Promise<string> {
    const model = pickModel(opts.model ?? "gpt-5.5")
    const intake = await decideExecutionMode(opts, model).catch((e) => {
        process.stderr.write(`[planner-openai] intake failed (${(e as Error)?.message ?? String(e)}) — defaulting to focused\n`)
        return {
            mode: "focused" as const,
            confidence: 0,
            reason: "Intake failed, so Baro uses the conservative focused mode instead of unsafe parallel decomposition.",
            maxStories: 1,
            parallelism: 1,
        }
    })
    process.stderr.write(`[planner-openai] intake mode=${intake.mode} confidence=${intake.confidence} reason=${oneLine(intake.reason).slice(0, 180)}\n`)
    const tools = createCodebaseTools(opts.cwd)
    setModelTools(model, tools)

    let context = ModelContext.create("planner")
        .addContextItem(SystemMessageItem.create(PLANNER_SYSTEM_PROMPT))
        .addContextItem(
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
    const defaultExploration = opts.decisionDocument?.trim() ? 1 : 2
    const maxExplorationRounds = Math.max(1, Math.min(opts.maxExplorationRounds ?? numberEnv("BARO_PLANNER_MAX_EXPLORATION_ROUNDS", defaultExploration), maxRounds - 1))
    const maxTokens = Math.max(50_000, opts.maxTokens ?? numberEnv("BARO_PLANNER_MAX_TOKENS", 150_000))
    const perRoundTimeoutMs = (opts.perRoundTimeoutSecs ?? 600) * 1000
    const usage = new UsageAccumulator()
    let finalRequested = false

    for (let round = 1; round <= maxRounds; round++) {
        const newItems: Array<{
            type: string
            callId?: string
            name?: string
            args?: string
            text?: string
        }> = []

        if (finalRequested) setModelTools(model, [])
        const roundPromise = runInferenceRound(context, model)
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
        for (const call of calls) {
            const tool = tools.find((t) => t.name === call.name)
            const output = tool
                ? await runToolSafely(tool, call.args ?? "{}")
                : `Error: tool '${call.name}' not registered`
            context = context.addContextItem(
                FunctionCallOutputItem.create(call.callId ?? "", output),
            )
        }

        if (calls.length > 0) {
            if (!finalRequested && (round >= maxExplorationRounds || usage.totalTokens >= maxTokens)) {
                finalRequested = true
                setModelTools(model, [])
                context = context.addContextItem(UserMessageItem.create(finalPlanInstruction(usage.summary(), round, maxExplorationRounds, maxTokens)))
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
                return extractJsonObject(raw)
            } catch (e) {
                process.stderr.write(`[planner-openai] invalid final JSON (${(e as Error)?.message ?? String(e)}) — using fallback PRD\n`)
                return fallbackPrdJson(opts.goal, "Planner returned invalid JSON after exploration.")
            }
        }
    }

    process.stderr.write(`[planner-openai] ${usage.summary()} — exceeded maxRounds=${maxRounds}, using fallback PRD\n`)
    return fallbackPrdJson(opts.goal, `Planner exceeded maxRounds=${maxRounds} without producing a final plan.`)
}

async function decideExecutionMode(
    opts: RunPlannerOpenAIOptions,
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
    const result = await runInferenceRound(context, intakeModel)
    const raw = result.items
        .filter((i) => i.type === "message")
        .map((i) => ((i.toJSON() as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""))
        .join("\n")
        .trim()
    return parseModeContract(raw)
}

function numberEnv(name: string, fallback: number): number {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? n : fallback
}

function finalPlanInstruction(summary: string, round: number, maxExplorationRounds: number, maxTokens: number): string {
    return [
        "You have explored enough. Stop calling tools.",
        `Exploration round ${round}/${maxExplorationRounds}; planning budget ${maxTokens} tokens; usage so far: ${summary}.`,
        "Now output ONLY the final PRD JSON matching the required schema. No markdown, no prose, no more inspection.",
        "If some details remain uncertain, encode them as acceptance criteria/tests inside the relevant story instead of continuing exploration.",
    ].join("\n")
}

export function fallbackPrdJson(goal: string, reason: string): string {
    const title = oneLine(goal).slice(0, 80) || "Implement requested change"
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
                model: "opus",
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
