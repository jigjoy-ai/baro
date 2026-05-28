/**
 * OpenAI inference runtime — drives multi-round chat completions via
 * the official OpenAI SDK. The SDK reads `OPENAI_API_KEY` and
 * `OPENAI_BASE_URL` from the environment, so this automatically
 * supports any OpenAI-compatible endpoint (Xiaomi MiMo, OpenRouter,
 * vLLM, etc.).
 *
 * Background: in Mozaik 3.9.x this file wrapped `OpenAIResponses`
 * (the lower-level ModelRuntime) so baro could drive its own multi-
 * round inference loops while still receiving per-call `TokenUsage`
 * — usage data that `OpenAIInferenceRunner` (the convenience layer)
 * deliberately discards.
 *
 * Mozaik 3.10 consolidated the public OpenAI inference API: it
 * removed `OpenAIResponses`, `InferenceRequest`, `InferenceResponse`,
 * and `InputStream` from the public exports. Rather than waiting for
 * Mozaik to re-expose those internals, this file now calls the
 * OpenAI Chat Completions API directly via the `openai` SDK.
 *
 * `UsageAccumulator` is still useful (it just sums TokenUsage shapes,
 * doesn't depend on the removed classes) and stays exported so its
 * call sites don't break.
 */

import OpenAI from "openai"
import {
    ContextItem,
    FunctionCallItem,
    ModelMessageItem,
    TokenUsage,
    type GenerativeModel,
    type ModelContext,
    type Tool,
} from "@mozaik-ai/core"

export interface InferenceRound {
    items: ContextItem[]
    usage: TokenUsage | undefined
}

/**
 * A minimal `GenerativeModel` implementation for arbitrary model
 * names that aren't shipped by Mozaik. The model name is forwarded
 * as-is to the OpenAI Chat Completions API, which makes this work
 * with any OpenAI-compatible endpoint.
 */
export class GenericOpenAIModel {
    specification: { name: string }
    private _tools: Tool[] = []

    constructor(name: string) {
        this.specification = { name }
    }

    setTools(tools: Tool[]): void {
        this._tools = tools
    }

    getTools(): Tool[] {
        return this._tools
    }
}

/**
 * One inference round against the OpenAI Chat Completions API.
 *
 * Converts the Mozaik `ModelContext` items into OpenAI message
 * format, calls `chat.completions.create`, and converts the
 * response back into Mozaik `ContextItem`-s so the caller's
 * multi-round loop keeps working unchanged.
 */
export async function runInferenceRound(
    context: ModelContext,
    model: GenerativeModel,
): Promise<InferenceRound> {
    const client = new OpenAI()
    const modelName = model.specification.name

    // ── 1. Convert context items → OpenAI messages ───────────────
    const messages: OpenAI.ChatCompletionMessageParam[] = []

    for (const item of context.items) {
        const json = (item as any).toJSON()

        switch (item.type) {
            case "system": {
                const content = extractText(json)
                messages.push({ role: "system", content })
                break
            }
            case "user": {
                const content = extractText(json)
                messages.push({ role: "user", content })
                break
            }
            case "message": {
                // Assistant text message
                const text = json?.content?.[0]?.text ?? ""
                if (text) {
                    messages.push({ role: "assistant", content: text })
                }
                break
            }
            case "function_call": {
                // Previous assistant tool call
                const fc = item as unknown as {
                    callId: string
                    name: string
                    args: string
                }
                messages.push({
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: fc.callId,
                            type: "function",
                            function: {
                                name: fc.name,
                                arguments: fc.args,
                            },
                        },
                    ],
                })
                break
            }
            case "function_call_output": {
                // Tool result
                const fco = item as unknown as {
                    callId: string
                    content: string
                }
                messages.push({
                    role: "tool",
                    tool_call_id: fco.callId,
                    content: fco.content,
                })
                break
            }
            case "reasoning": {
                // Reasoning items are not part of the chat message
                // format — skip them silently.
                break
            }
            // Unknown item types are silently skipped.
        }
    }

    // ── 2. Convert Mozaik tools → OpenAI function tools ──────────
    const mozaikTools: Tool[] =
        (model as any).getTools?.() ?? []

    const openaiTools: OpenAI.ChatCompletionTool[] = mozaikTools.map(
        (t: any) => ({
            type: "function" as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                ...(t.strict !== undefined ? { strict: t.strict } : {}),
            },
        }),
    )

    // ── 3. Call the API ──────────────────────────────────────────
    const response = await client.chat.completions.create({
        model: modelName,
        messages,
        ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
    })

    const choice = response.choices[0]
    if (!choice) {
        throw new Error(
            `OpenAI returned no choices for model "${modelName}"`,
        )
    }

    const assistant = choice.message

    // ── 4. Convert response → Mozaik ContextItems ────────────────
    const items: ContextItem[] = []

    if (assistant.content) {
        items.push(
            ModelMessageItem.rehydrate({ text: assistant.content }),
        )
    }

    if (assistant.tool_calls) {
        for (const tc of assistant.tool_calls) {
            items.push(
                FunctionCallItem.rehydrate({
                    callId: tc.id,
                    name: tc.function.name,
                    args: tc.function.arguments,
                }),
            )
        }
    }

    // ── 5. Extract token usage ───────────────────────────────────
    const usage: TokenUsage | undefined = response.usage
        ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
              inputTokenDetails: {
                  cached_tokens:
                      (response.usage as any).prompt_tokens_details
                          ?.cached_tokens ?? 0,
              },
              outputTokenDetails: {
                  reasoning_tokens:
                      (response.usage as any).completion_tokens_details
                          ?.reasoning_tokens ?? 0,
              },
          }
        : undefined

    return { items, usage }
}

/** Extract plain text from a Mozaik item's toJSON() payload. */
function extractText(json: any): string {
    if (typeof json === "string") return json
    if (typeof json?.content === "string") return json.content
    if (Array.isArray(json?.content) && json.content[0]?.text)
        return json.content[0].text
    if (typeof json?.text === "string") return json.text
    return ""
}

/**
 * Sums per-round `TokenUsage`-s into a final report. Multi-turn
 * coding loops (Architect, Planner, StoryAgent) accumulate across
 * rounds; one-shot evaluators (Critic, Surgeon) snap a single round
 * directly into a fresh accumulator and call `.toJSON()`.
 */
export class UsageAccumulator {
    private input = 0
    private output = 0
    private total = 0
    private cached = 0
    private reasoning = 0
    private rounds = 0

    add(usage: TokenUsage | undefined): void {
        if (!usage) return
        this.rounds += 1
        this.input += usage.inputTokens ?? 0
        this.output += usage.outputTokens ?? 0
        this.total += usage.totalTokens ?? 0
        this.cached += usage.inputTokenDetails?.cached_tokens ?? 0
        this.reasoning += usage.outputTokenDetails?.reasoning_tokens ?? 0
    }

    get isEmpty(): boolean {
        return this.rounds === 0
    }

    /**
     * Plain-object snapshot suitable for embedding in
     * `AgentResultItem.usage` (which is typed `any` to allow per-
     * provider shapes). Keys are snake_case to line up with what the
     * Claude side's stream-json mapper produces from Anthropic
     * usage frames.
     */
    toJSON() {
        return {
            input_tokens: this.input,
            output_tokens: this.output,
            total_tokens: this.total,
            cached_input_tokens: this.cached,
            reasoning_tokens: this.reasoning,
            rounds: this.rounds,
        }
    }

    /** One-line summary for the stderr / log path. */
    summary(): string {
        if (this.isEmpty) return "(no token usage reported)"
        return (
            `${this.total} total tokens ` +
            `(${this.input} in, ${this.output} out` +
            `${this.cached ? `, ${this.cached} cached` : ""}` +
            `${this.reasoning ? `, ${this.reasoning} reasoning` : ""}` +
            `) across ${this.rounds} round(s)`
        )
    }
}
