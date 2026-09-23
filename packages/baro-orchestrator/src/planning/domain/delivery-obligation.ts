const DELIVERY_WORD = /\b(push|pushe[sd]|pushing|publish|publishe[sd]|publishing)\b/iu
const NEGATION_WORD =
    /\b(no|not|nothing|none|neither|nor|never|don't|do not|without|deny|denied|refuse[sd]?)\b/iu

/**
 * Delivery (push/publish) is the user's to do, never a story's or the
 * operator's. A negation before the trigger word in the same sentence marks
 * a constraint against delivery, not an obligation to perform it, and stays
 * admissible — e.g. "stories do not run git push", or an architect obligation
 * asserting "nothing is pushed, tagged, or published" (#183).
 */
export function deliveryObligationViolation(text: string): string | null {
    const sentences = String(text)
        .split(/(?<=[.!?])\s+|\n+/u)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0)
    for (const sentence of sentences) {
        const match = DELIVERY_WORD.exec(sentence)
        if (!match) continue
        const before = sentence.slice(0, match.index)
        if (NEGATION_WORD.test(before)) continue
        return sentence
    }
    return null
}
