/**
 * Resolved model id from the Claude CLI's per-model usage map. With several
 * models in one process (e.g. a haiku sub-turn), the one with the most
 * output tokens is the invocation's primary model.
 */
export function primaryClaudeModel(modelUsage: unknown): string | null {
    if (
        !modelUsage ||
        typeof modelUsage !== "object" ||
        Array.isArray(modelUsage)
    ) {
        return null
    }
    let best: string | null = null
    let bestOutput = -1
    for (const [model, raw] of Object.entries(modelUsage)) {
        const usage =
            raw && typeof raw === "object" && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : {}
        const output =
            typeof usage.outputTokens === "number"
                ? usage.outputTokens
                : typeof usage.output_tokens === "number"
                  ? usage.output_tokens
                  : 0
        if (output > bestOutput) {
            best = model
            bestOutput = output
        }
    }
    return best
}
