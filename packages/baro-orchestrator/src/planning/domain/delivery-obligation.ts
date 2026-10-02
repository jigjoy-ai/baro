const DELIVERY_WORD = /\b(push|pushe[sd]|pushing|publish|publishe[sd]|publishing)\b/giu
const NEGATION_WORD =
    /\b(no|not|nothing|none|neither|nor|never|\w+n't|do not|without|deny|denied|refuse[sd]?)\b/iu
// "push-free", "publish-less": the negation is welded onto the word itself.
const NEGATING_SUFFIX = /^[-\s]?(free|less)\b/iu
// A prohibition stated after the word: "pushing is forbidden", "push must not happen".
const PROHIBITION_AFTER =
    /\b(?:is|are|was|were|be|being|stays?|remains?|must|shall|should|may|can|will|does|do)\s+(?:not|never)\b|n't\b|\b(?:forbidden|prohibited|disallowed|banned|excluded|refused|denied|blocked|out of scope|off limits)\b/iu

// Where code is delivered to. "Publish" and "push" are also what applications
// do (SNS publish, publishing an event, a push notification), and eight live
// Architect runs died on exactly that reading (#211). Only a sentence that
// names one of these is about delivering the work. Deliberately narrow: the
// shell guard is what actually stops a story from pushing.
const DELIVERY_TARGET =
    /\b(?:git|branch(?:es)?|pull[- ]requests?|merge[- ]requests?|github|gitlab|bitbucket|npm|pypi|crates\.io|maven central|docker hub|(?:package|container|docker|npm) registry)\b|\bPRs?\b/iu

/**
 * Delivery (push/publish) is the user's to do, never a story's or the
 * operator's. A sentence that negates the trigger word states a constraint
 * against delivery, not an obligation to perform it, and stays admissible:
 * "stories do not run git push", "nothing is pushed, tagged, or published"
 * (#183), "push-free local scope" (#205), "pushing is forbidden".
 */
export function deliveryObligationViolation(text: string): string | null {
    const sentences = String(text)
        .split(/(?<=[.!?])\s+|\n+/u)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0)
    for (const sentence of sentences) {
        if (!DELIVERY_TARGET.test(sentence)) continue
        for (const match of sentence.matchAll(DELIVERY_WORD)) {
            const before = sentence.slice(0, match.index)
            const after = sentence.slice(match.index + match[0].length)
            if (
                NEGATION_WORD.test(before) ||
                NEGATING_SUFFIX.test(after) ||
                PROHIBITION_AFTER.test(after)
            ) continue
            return sentence
        }
    }
    return null
}
