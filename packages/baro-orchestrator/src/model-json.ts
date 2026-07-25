/**
 * Chat harnesses (notably Claude CLI backends) nondeterministically wrap a
 * requested JSON object in a markdown fence or a sentence of prose, even
 * when the prompt demands bare JSON. Unwrap exactly one top-level object so
 * strict schema/correlation validation can run against what the model
 * actually produced; content validation stays fail-closed at every caller.
 */
export function extractModelJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/u)
    if (fence) return fence[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) return trimmed
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < trimmed.length; index += 1) {
        const char = trimmed[index]
        if (escaped) {
            escaped = false
        } else if (char === "\\") {
            escaped = inString
        } else if (char === '"') {
            inString = !inString
        } else if (!inString && char === "{") {
            depth += 1
        } else if (!inString && char === "}") {
            depth -= 1
            if (depth === 0) return trimmed.slice(start, index + 1)
        }
    }
    return trimmed
}
