/**
 * Thin wrapper over Mozaik 3.9's `OpenAIResponses` ModelRuntime.
 *
 * Why not `OpenAIInferenceRunner`? Both are Mozaik public exports.
 * The runner is a convenience for callers who plug into
 * `BaseAgentParticipant`'s inference loop — it yields items as an
 * AsyncIterable and discards the `TokenUsage` from each response.
 * Our participants drive their own multi-round loops directly, so
 * we use the lower-level `OpenAIResponses` (which Mozaik's
 * `ModelRuntime` interface formalises) to keep the usage data
 * Mozaik already extracts on every call.
 *
 * Same HTTP call either way; same item deserialisation. Just one
 * more field in the return value.
 */

import {
    ContextItem,
    InferenceRequest,
    OpenAIResponses,
    TokenUsage,
    type GenerativeModel,
    type ModelContext,
} from "@mozaik-ai/core"

/**
 * Lazy because `new OpenAIResponses()` chains to `new OpenAI()`
 * which throws if `OPENAI_API_KEY` isn't set. Module-level init
 * would mean a Claude-mode run that just imports this file (planner
 * / architect / story-agent all do, regardless of --llm) fails at
 * bundle load. Constructing only on first call defers the check to
 * the moment we actually need OpenAI — which by definition is also
 * the moment the key is available.
 */
let _runtime: OpenAIResponses | null = null
function getRuntime(): OpenAIResponses {
    if (_runtime === null) _runtime = new OpenAIResponses()
    return _runtime
}

export interface InferenceRound {
    items: ContextItem[]
    usage: TokenUsage | undefined
}

/**
 * One inference call against the OpenAI Responses API. Returns both
 * the deserialised context items (function calls, model messages,
 * reasoning) and the token usage Mozaik extracted from the response.
 */
export async function runInferenceRound(
    context: ModelContext,
    model: GenerativeModel,
): Promise<InferenceRound> {
    const response = await getRuntime().infer(new InferenceRequest(model, context))
    return {
        items: response.contextItems,
        usage: response.tokenUsage,
    }
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
