/**
 * Shared validation for conversation text that reaches the intake and the
 * front door. Each failed rule throws its own message so the user learns
 * which rule refused the text, and a too-long text names its length and the
 * limit.
 */

export const MAX_CONVERSATION_TEXT_CHARS = 8_000

const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

export function boundedConversationTextOrThrow(value: unknown, label: string): string {
    if (typeof value !== "string") throw new TypeError("conversation text must be a string")
    const text = value.replace(/\r\n?/g, "\n").trim()
    if (text.length === 0) throw new TypeError(`${label} is empty`)
    if (text.length > MAX_CONVERSATION_TEXT_CHARS) {
        throw new TypeError(
            `${label} is ${formatCount(text.length)} characters; ` +
                `the limit is ${formatCount(MAX_CONVERSATION_TEXT_CHARS)}`,
        )
    }
    const unsafe = UNSAFE_CONTROL_CHARACTER.exec(text)
    if (unsafe) {
        const code = unsafe[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
        throw new TypeError(
            `${label} contains an unsafe control character U+${code} at position ${unsafe.index + 1}`,
        )
    }
    return text
}

function formatCount(n: number): string {
    return n.toLocaleString("en-US")
}
