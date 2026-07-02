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

import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import { createCodebaseTools } from "./codebase-tools.js"

export interface RunArchitectOpenAIOptions {
    goal: string
    cwd: string
    model?: string
    projectContext?: string
    /** Cap on inference rounds; errors if exceeded. */
    maxRounds?: number
    /** Default 600 s — reasoning models can need minutes per round. */
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

export async function runArchitectOpenAI(
    opts: RunArchitectOpenAIOptions,
): Promise<string> {
    const model = pickModel(opts.model ?? "gpt-5.5")
    const tools = createCodebaseTools(opts.cwd)
    setModelTools(model, tools)

    let context = ModelContext.create("architect")
        .addContextItem(SystemMessageItem.create(ARCHITECT_SYSTEM_PROMPT))
        .addContextItem(
            UserMessageItem.create(buildArchitectUserMessage(opts.goal, opts.projectContext)),
        )

    const maxRounds = opts.maxRounds ?? 12
    const perRoundTimeoutMs = (opts.perRoundTimeoutSecs ?? 600) * 1000
    const usage = new UsageAccumulator()

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
        const roundPromise = runInferenceRound(context, model)
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
                    `ArchitectOpenAI: round ${round} had no tool calls and no message — stuck.`,
                )
            }
            const doc = messages.map((m) => m.text ?? "").join("\n").trim()
            if (!doc) {
                throw new Error("ArchitectOpenAI: empty final document")
            }
            process.stderr.write(`[architect-openai] ${usage.summary()}\n`)
            return doc
        }
    }

    throw new Error(
        `ArchitectOpenAI: exceeded maxRounds=${maxRounds} without producing a final ` +
        `document. Increase maxRounds or simplify the goal.`,
    )
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
