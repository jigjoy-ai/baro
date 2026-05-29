/**
 * Mozaik-native inference runtime for the OpenAI-compatible backend —
 * the single chokepoint every non-CLI phase (Architect, Planner, Story,
 * Critic, Surgeon) routes its per-round inference through.
 *
 * Inference goes through Mozaik's `OpenAICompatibleChatCompletions`
 * runtime, which speaks the OpenAI **Chat Completions** dialect against
 * a configurable base URL. The OpenAI SDK inside Mozaik reads
 * `OPENAI_API_KEY` and `OPENAI_BASE_URL` from the environment (baro's
 * Rust layer forwards both), so the same code path serves real OpenAI
 * and any OpenAI-compatible endpoint — DeepSeek, OpenRouter, vLLM,
 * Ollama, Xiaomi MiMo, etc.
 *
 * Mozaik owns the `ModelContext` ⇄ chat-message conversion (including
 * the tricky bits: merging consecutive/parallel tool calls into one
 * assistant message, tool-result mapping, token-usage extraction), so
 * baro no longer hand-rolls any of it. Provider-only request fields
 * (e.g. DeepSeek's `thinking`) would be passed via the runtime's
 * `extraBody` config if/when needed.
 *
 * `UsageAccumulator` sums per-round `TokenUsage`-s and is provider-
 * agnostic.
 */

import {
    ContextItem,
    InferenceRequest,
    OpenAICompatibleChatCompletions,
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
 * A minimal `GenerativeModel` for arbitrary model names that aren't
 * shipped by Mozaik. The name is forwarded as-is to the Chat
 * Completions API, which makes any OpenAI-compatible endpoint usable
 * via `--story-model <name>` (e.g. `deepseek-chat`, `llama3`,
 * `anthropic/claude-3.5-sonnet` on OpenRouter).
 */
export class GenericOpenAIModel implements GenerativeModel {
    readonly specification: GenerativeModel["specification"]
    private _tools: Tool[] = []
    private _reasoningEffort = "medium"
    private _streaming = false

    constructor(name: string) {
        this.specification = {
            name,
            supportReasoningEffort: false,
            defaultReasoningEffort: undefined,
            supportStreaming: false,
            contextWindowSize: 128_000,
            maxOutputTokens: 16_384,
            supportFunctionCalling: true,
        }
    }

    setTools(tools: Tool[]): void {
        this._tools = tools
    }

    getTools(): Tool[] {
        return this._tools
    }

    // Capability methods are no-ops: a generic chat model carries no
    // Mozaik-side reasoning-effort or streaming state. With
    // `supportReasoningEffort: false`, the runtime sends no
    // reasoning_effort field for it.
    setReasoningEffort(effort: string): void {
        this._reasoningEffort = effort
    }

    getReasoningEffort(): string {
        return this._reasoningEffort
    }

    setStreaming(streaming: boolean): void {
        this._streaming = streaming
    }

    getStreaming(): boolean {
        return this._streaming
    }
}

// Cached module-level: the runtime is stateless aside from its vendor
// SDK client, which reads the API key + base URL from the env once at
// construction. Re-instantiating per round would rebuild the client
// (and re-read the env) on every call.
let runtime: OpenAICompatibleChatCompletions | undefined

/**
 * One inference round against the configured OpenAI-compatible endpoint.
 * Delegates the heavy lifting (message conversion, tool-call round-trip,
 * usage extraction) to Mozaik's runtime and returns the new context
 * items plus this round's `TokenUsage`.
 */
export async function runInferenceRound(
    context: ModelContext,
    model: GenerativeModel,
): Promise<InferenceRound> {
    runtime ??= new OpenAICompatibleChatCompletions()
    const response = await runtime.infer(new InferenceRequest(model, context))
    return { items: response.contextItems, usage: response.tokenUsage }
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
