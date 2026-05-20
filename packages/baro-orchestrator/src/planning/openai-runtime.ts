/**
 * OpenAI inference runtime wrapper — temporarily stubbed during the
 * Mozaik 3.10 migration.
 *
 * Background: in Mozaik 3.9.x this file wrapped `OpenAIResponses`
 * (the lower-level ModelRuntime) so baro could drive its own multi-
 * round inference loops while still receiving per-call `TokenUsage`
 * — usage data that `OpenAIInferenceRunner` (the convenience layer)
 * deliberately discards.
 *
 * Mozaik 3.10 consolidated the public OpenAI inference API: it
 * removed `OpenAIResponses`, `InferenceRequest`, `InferenceResponse`,
 * and `InputStream` from the public exports. The migration plan
 * (memory: mozaik-3-10-blocker.md, "Blocker 2") is to either:
 *   (a) ask Mozaik to re-expose those internals, or
 *   (b) rewrite this file against the new `OpenAIInferenceRunner`
 *       once Mozaik exposes a per-call `TokenUsage` channel for it.
 *
 * Until that decision is made, calling `runInferenceRound` throws.
 * This is an explicit gap, not a workaround — the `--llm claude`
 * path through `claude-cli-participant.ts` is unaffected.
 *
 * `UsageAccumulator` is still useful (it just sums TokenUsage shapes,
 * doesn't depend on the removed classes) and stays exported so its
 * call sites don't break.
 */

import {
    ContextItem,
    TokenUsage,
    type GenerativeModel,
    type ModelContext,
} from "@mozaik-ai/core"

export interface InferenceRound {
    items: ContextItem[]
    usage: TokenUsage | undefined
}

/**
 * One inference call against the OpenAI Responses API. Throws during
 * the Mozaik 3.10 migration — see file header.
 */
export async function runInferenceRound(
    _context: ModelContext,
    _model: GenerativeModel,
): Promise<InferenceRound> {
    throw new Error(
        "OpenAI inference path is temporarily disabled during the " +
            "Mozaik 3.10 migration (see Blocker 2). Use `--llm claude` " +
            "until OpenAIResponses / InferenceRequest are restored to " +
            "the @mozaik-ai/core public API.",
    )
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
