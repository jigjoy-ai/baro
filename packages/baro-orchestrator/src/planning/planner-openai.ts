/**
 * PlannerOpenAI — Mozaik-native Planner. Multi-turn inference loop
 * with our codebase tools, terminating on an assistant message that
 * carries the PRD JSON. Same prompt as PlannerClaude so the two
 * providers produce comparable DAGs.
 *
 * Returns the raw JSON string (the body of the model's final
 * message). The Rust caller parses it; this layer doesn't reparse.
 *
 * Replaces the legacy `packages/baro-app/src/core/openai-planner.ts`
 * + standalone `node openai-planner.js` subprocess. That path used a
 * raw OpenAI Chat Completions client; this one rides Mozaik 3.9's
 * native runner so it shares model wrappers, reasoning-effort, and
 * tool-calling shapes with the Architect / Critic / Surgeon.
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
    UsageAccumulator,
    runInferenceRound,
} from "./openai-runtime.js"

import { createCodebaseTools } from "./codebase-tools.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
} from "./planner-prompts.js"

export interface RunPlannerOpenAIOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory the Planner explores in. */
    cwd: string
    /** Mozaik model name. Default: "gpt-5.5" — flagship reasoning across all five OpenAI phases. */
    model?: string
    /** Optional CLAUDE.md / project-context blob to prepend. */
    projectContext?: string
    /** Architect's DecisionDocument, prepended as authoritative spec. */
    decisionDocument?: string
    /** `--quick` hard override: 1 story, regardless of triage. */
    quick?: boolean
    /**
     * Cap on inference rounds. Each round = one model response,
     * optionally with tool calls + their outputs in the next round.
     * Planner generally needs fewer rounds than Architect (no schema
     * to design) — 8 is generous. Triggers an error if exceeded.
     */
    maxRounds?: number
    /** Per-round inference timeout in seconds. Default: 120. */
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
            throw new Error(
                `PlannerOpenAI: unknown model "${name}" — Mozaik 3.9 ships ` +
                `gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano`,
            )
    }
}

export async function runPlannerOpenAI(
    opts: RunPlannerOpenAIOptions,
): Promise<string> {
    const model = pickModel(opts.model ?? "gpt-5.5")
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
                }),
            ),
        )

    const maxRounds = opts.maxRounds ?? 8
    const perRoundTimeoutMs = (opts.perRoundTimeoutSecs ?? 120) * 1000
    const usage = new UsageAccumulator()

    for (let round = 1; round <= maxRounds; round++) {
        const newItems: Array<{
            type: string
            callId?: string
            name?: string
            args?: string
            text?: string
        }> = []

        const roundPromise = runInferenceRound(context, model)
        const timeoutPromise = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`round ${round} timed out after ${perRoundTimeoutMs}ms`)), perRoundTimeoutMs),
        )
        const result = await Promise.race([roundPromise, timeoutPromise])
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

        if (calls.length === 0) {
            const messages = newItems.filter((i) => i.type === "message")
            if (messages.length === 0) {
                throw new Error(
                    `PlannerOpenAI: round ${round} had no tool calls and no message — stuck.`,
                )
            }
            const raw = messages.map((m) => m.text ?? "").join("\n").trim()
            if (!raw) throw new Error("PlannerOpenAI: empty final response")
            process.stderr.write(`[planner-openai] ${usage.summary()}\n`)
            return extractJsonObject(raw)
        }
    }

    throw new Error(
        `PlannerOpenAI: exceeded maxRounds=${maxRounds} without producing a final ` +
        `plan. Increase maxRounds or simplify the goal.`,
    )
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

/** Tolerate markdown fences or leading prose around the PRD JSON. */
function extractJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fence) return fence[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(`PlannerOpenAI: no JSON object in response: ${trimmed.slice(0, 200)}`)
    }
    let depth = 0
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (ch === "{") depth++
        else if (ch === "}") {
            depth--
            if (depth === 0) return trimmed.slice(start, i + 1)
        }
    }
    throw new Error(`PlannerOpenAI: unbalanced JSON in response: ${trimmed.slice(0, 200)}`)
}
