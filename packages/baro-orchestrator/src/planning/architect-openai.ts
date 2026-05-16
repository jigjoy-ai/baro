/**
 * ArchitectOpenAI — one-shot Architect via Mozaik 3.9's native OpenAI
 * inference runner. Multi-turn inference loop with our codebase tools
 * (read_file, list_files, file_tree, grep, glob, bash) until the
 * model emits a final assistant message with no tool calls — that
 * message is the design document.
 *
 * Same system prompt as ArchitectClaude so the two providers produce
 * comparable decision documents.
 *
 * Why a hand-rolled loop instead of `BaseAgentParticipant`:
 * `BaseAgentParticipant` is built around an `AgenticEnvironment` that
 * fans events out to subscribers. The Architect is a one-shot call
 * with no peers to react to — direct iteration over the inference
 * runner is half the code and the right granularity for the use case.
 * Phase 6 (StoryAgent OpenAI) is where the participant pattern earns
 * its keep.
 */

import {
    FunctionCallOutputItem,
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    ModelContext,
    OpenAIInferenceRunner,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
    type Tool,
} from "@mozaik-ai/core"

import {
    ARCHITECT_SYSTEM_PROMPT,
    buildArchitectUserMessage,
} from "./architect-prompts.js"
import { createCodebaseTools } from "./codebase-tools.js"

export interface RunArchitectOpenAIOptions {
    /** The user's goal — verbatim. */
    goal: string
    /** Working directory the Architect explores in. */
    cwd: string
    /** Mozaik model name. Default: "gpt-5.5" — Architect is one-shot but consequential. */
    model?: string
    /** Optional CLAUDE.md / project-context blob to prepend. */
    projectContext?: string
    /**
     * Cap on inference rounds (each round = one model response, optionally
     * with tool calls + their outputs in the next round). Default: 12 —
     * generous since Architect needs to read multiple files but not so
     * generous that a runaway loop costs a fortune. Triggers an error
     * if exceeded.
     */
    maxRounds?: number
    /** Per-round inference timeout in seconds (passed via AbortSignal). Default: 120. */
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
                `ArchitectOpenAI: unknown model "${name}" — Mozaik 3.9 ships ` +
                `gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano`,
            )
    }
}

export async function runArchitectOpenAI(
    opts: RunArchitectOpenAIOptions,
): Promise<string> {
    const model = pickModel(opts.model ?? "gpt-5.5")
    const tools = createCodebaseTools(opts.cwd)
    setModelTools(model, tools)

    const runner = new OpenAIInferenceRunner()
    let context = ModelContext.create("architect")
        .addContextItem(SystemMessageItem.create(ARCHITECT_SYSTEM_PROMPT))
        .addContextItem(
            UserMessageItem.create(buildArchitectUserMessage(opts.goal, opts.projectContext)),
        )

    const maxRounds = opts.maxRounds ?? 12
    const perRoundTimeoutMs = (opts.perRoundTimeoutSecs ?? 120) * 1000

    for (let round = 1; round <= maxRounds; round++) {
        // Per-round abort so a single hung inference can't lock the whole
        // architect call. The next round will resume from the same context
        // if anything had been emitted; otherwise we propagate the error.
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), perRoundTimeoutMs)

        const newItems: Array<{
            type: string
            callId?: string
            name?: string
            args?: string
            text?: string
        }> = []

        try {
            for await (const item of runner.run(context, model, ac.signal)) {
                if (item.type === "function_call") {
                    newItems.push({
                        type: "function_call",
                        callId: item.callId,
                        name: item.name,
                        args: item.args,
                    })
                    context = context.addContextItem(item)
                } else if (item.type === "message" && item.role === "assistant") {
                    const json = item.toJSON() as { content: Array<{ text: string }> }
                    const text = json.content?.[0]?.text ?? ""
                    newItems.push({ type: "message", text })
                    context = context.addContextItem(item)
                } else if (item.type === "reasoning") {
                    context = context.addContextItem(item)
                }
            }
        } finally {
            clearTimeout(timer)
        }

        // If the model produced no items at all, we're stuck — error out.
        if (newItems.length === 0) {
            throw new Error(
                `ArchitectOpenAI: round ${round} returned no items. Aborting.`,
            )
        }

        // Execute every function call this round produced, in order,
        // and feed the outputs back into the context for the next round.
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

        // If no tool calls AND we got at least one assistant message,
        // we're done. The last assistant text is the design document.
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
            return doc
        }
    }

    throw new Error(
        `ArchitectOpenAI: exceeded maxRounds=${maxRounds} without producing a final ` +
        `document. Increase maxRounds or simplify the goal.`,
    )
}

/** Run a tool's invoke() while turning any throw into a string the model can read. */
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

/**
 * Mozaik models implement `ToolCallingCapability` (setTools/getTools).
 * Older versions of `GenerativeModel` didn't, so we duck-type rather
 * than `instanceof` to keep the failure mode obvious if a future
 * model omits the capability.
 */
function setModelTools(model: GenerativeModel, tools: Tool[]): void {
    const m = model as unknown as { setTools?: (t: Tool[]) => void }
    if (typeof m.setTools !== "function") {
        throw new Error(
            `ArchitectOpenAI: model ${model.specification.name} does not implement ToolCallingCapability`,
        )
    }
    m.setTools(tools)
}
