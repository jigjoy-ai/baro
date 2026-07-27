/**
 * Chat harnesses (notably Claude CLI backends) nondeterministically wrap a
 * requested JSON object in a markdown fence or a sentence of prose, even
 * when the prompt demands bare JSON. Unwrap exactly one top-level object so
 * strict schema/correlation validation can run against what the model
 * actually produced; content validation stays fail-closed at every caller.
 *
 * A reply that ends OUTSIDE a string with containers still open is closed
 * here. Models drop trailing closers on JSON whose final strings are heavily
 * escaped (shell/regex evidence) and report the turn as complete
 * (stop_reason=end_turn, far below any output cap); the completion is
 * unambiguous because only closers can follow, while a repair round trip
 * reproduces the same quirk. A reply cut INSIDE a string is genuinely
 * truncated and stays broken for the caller to detect.
 */
export function extractModelJsonObject(text: string): string {
    const trimmed = text.trim()
    const fence = trimmed.startsWith("{")
        ? null
        : trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/u)
    const candidate = fence ? fence[1]! : trimmed
    const start = candidate.indexOf("{")
    if (start < 0) return candidate

    const open: string[] = []
    let inString = false
    let escaped = false
    for (let index = start; index < candidate.length; index += 1) {
        const char = candidate[index]
        if (escaped) {
            escaped = false
        } else if (char === "\\") {
            escaped = inString
        } else if (char === '"') {
            inString = !inString
        } else if (inString) {
            continue
        } else if (char === "{" || char === "[") {
            open.push(char)
        } else if (char === "}" || char === "]") {
            open.pop()
            if (open.length === 0) return candidate.slice(start, index + 1)
        }
    }
    if (inString || open.length === 0) return candidate
    const closers = open
        .reverse()
        .map((char) => (char === "{" ? "}" : "]"))
        .join("")
    return candidate.slice(start) + closers
}
