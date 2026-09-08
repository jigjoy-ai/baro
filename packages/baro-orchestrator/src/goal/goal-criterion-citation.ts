/* Resolving how an evaluator cites a criterion back to the exact criterion it
   was shown. The contract stays exact — an unresolvable or ambiguous citation
   is still a violation — but a model no longer fails the whole run-level
   review by citing "[G-A3]" instead of the full sentence, or by rendering a
   Serbian sentence with a straightened quote or an ASCII ellipsis. */

const TAG = /^\s*\[?([A-Z]+-[A-Z]*\d+)\]?\s*(?:[:.\-–—]\s*)?/u
const NUMBER_PREFIX = /^\d+\s*[.)]\s*/u

/** Every cited criterion mapped onto the exact prompt string, or `null` when any citation cannot be resolved uniquely. */
export function resolveCitedCriteria(
    cited: readonly string[],
    criteria: readonly string[],
    invariantIds: readonly string[],
): readonly string[] | null {
    const byId = new Map(invariantIds.map((id, index) => [id, criteria[index]!] as const))
    const byNormalized = new Map<string, string[]>()
    criteria.forEach((criterion, index) => {
        const key = normalizeCriterion(criterion, invariantIds[index])
        byNormalized.set(key, [...(byNormalized.get(key) ?? []), criterion])
    })
    const resolved: string[] = []
    for (const raw of cited) {
        const match = resolveOne(raw, criteria, byId, byNormalized)
        if (match === null) return null
        resolved.push(match)
    }
    return resolved
}

function resolveOne(
    raw: string,
    criteria: readonly string[],
    byId: ReadonlyMap<string, string>,
    byNormalized: ReadonlyMap<string, readonly string[]>,
): string | null {
    if (criteria.includes(raw)) return raw
    // The prompt numbers the list; a model may echo the number with the citation.
    const trimmed = raw.trim().replace(NUMBER_PREFIX, "")
    if (criteria.includes(trimmed)) return trimmed
    const tag = TAG.exec(trimmed)
    if (tag) {
        const criterion = byId.get(tag[1]!)
        if (criterion !== undefined) {
            const rest = trimmed.slice(tag[0].length)
            // A bare tag, or a tag followed by that criterion's own text; a tag
            // followed by another criterion's text is a contradiction, not a cite.
            if (rest.trim().length === 0) return criterion
            if (normalizeText(rest) === normalizeText(stripTag(criterion))) return criterion
            return null
        }
    }
    const candidates = byNormalized.get(normalizeCriterion(trimmed)) ?? []
    return candidates.length === 1 ? candidates[0]! : null
}

function stripTag(criterion: string): string {
    return criterion.replace(TAG, "")
}

function normalizeCriterion(criterion: string, invariantId?: string): string {
    const unnumbered = criterion.trim().replace(NUMBER_PREFIX, "")
    const body = invariantId && unnumbered.startsWith(`[${invariantId}]`)
        ? unnumbered.slice(invariantId.length + 2)
        : stripTag(unnumbered)
    return normalizeText(body)
}

/** Unicode-normalised, case-folded, whitespace-collapsed, with the typographic
 *  variants a model rewrites most (quotes, ellipsis, dashes) folded to ASCII and
 *  trailing punctuation dropped. Letters with diacritics are kept: "č" and "c"
 *  are different words in the languages this shows up in. */
export function normalizeText(text: string): string {
    return text
        .normalize("NFKC")
        .replace(/[‘’‚‛′`´]/gu, "'")
        .replace(/[“”„‟″]/gu, '"')
        .replace(/…/gu, "...")
        .replace(/[–—−]/gu, "-")
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/^\d+\s*[.)]\s*/u, "")
        // One terminal punctuation mark, never an ellipsis the criterion spells out.
        .replace(/(?<!\.)[.。;:,]$/u, "")
        .trim()
        .toLowerCase()
}
