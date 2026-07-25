/**
 * Deterministic final gates belong to RunVerifier, after every implementation
 * commit has been integrated. Sending a separate LLM worker to merely run the
 * same commands is expensive and, worse, lets it speculate about failures that
 * do not exist yet.
 *
 * This classifier is deliberately narrow. A story must be phrased as a
 * verification action, name a conventional final gate, and contain no request
 * to implement or change product/test code. Stories that add or modify tests
 * are implementation work and must never be removed by this policy.
 */

type StoryLike = {
    id: string
    title: string
    description: string
    dependsOn: readonly string[]
}

// Package managers can run arbitrary, mutating scripts. Keep this list closed
// to conventional deterministic gates; a title such as `npm run deploy` must
// remain implementation/release work. Likewise, bare `cargo fmt` edits files
// and is deliberately not classified as verification-only.
const PACKAGE_FINAL_GATE_SCRIPT =
    String.raw`(?:test(?:[:.-](?:unit|integration|e2e|smoke|regression|coverage|ci))?|type-?check(?:[:.-](?:strict|ci))?|check(?::(?:types?|type-?check|lint|test|build|ci))?|lint(?:[:.-]ci)?|build(?:[:.-](?:prod|production|ci))?|compile(?:[:.-]ci)?|clippy|fmt:check)`

const FINAL_GATE_ITEM = new RegExp(
    String.raw`^(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+${PACKAGE_FINAL_GATE_SCRIPT}|cargo\s+(?:test|check|clippy|build)|tests?|test suite|unit tests?|integration tests?|type[ -]?check|lint|build|compile|compilation)(?:\s*\((?:tsup|tsc|vite|webpack|rollup|esbuild|swc)\))?$`,
    "i",
)

const BOUNDED_INSPECTION_CLAUSE =
    /^(?:run|execute|check|verify|validate|audit)\s+(?:(?:the|all|existing|final|full|merged|project)\s+)*(?:tests?|test suite|type[ -]?check|lint|build|build output|compile|compilation|gates?|commands?|suite|results?|output)(?:\s+against\s+(?:(?:the|all|existing|final|merged)\s+)*(?:code|worktree|branch))?(?:\s+(?:and\s+)?(?:report|summarize|record)\s+(?:(?:the|their)\s+)?(?:results?|status|failures?))?$/i

const TEST_IMPLEMENTATION =
    /\b(?:add(?:ing)?|writ(?:e|ing)|creat(?:e|ing)|implement(?:ing)?|extend(?:ing)?|updat(?:e|ing)|refactor(?:ing)?)\b[^.\n]{0,80}\btests?\b/i

const SUBSTANTIVE_CHANGE =
    /\b(?:add(?:ing)?|writ(?:e|ing)|creat(?:e|ing)|implement(?:ing)?|extend(?:ing)?|updat(?:e|ing)|refactor(?:ing)?|migrat(?:e|ing)|wir(?:e|ing)|introduc(?:e|ing)|fix(?:ing)?|repair(?:s|ed|ing)?|replac(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|correct(?:s|ed|ing)?|consum(?:e|es|ed|ing)|propagat(?:e|es|ed|ing)|forward(?:s|ed|ing)?|handl(?:e|es|ed|ing)|enforc(?:e|es|ed|ing)|persist(?:s|ed|ing)?|expos(?:e|es|ed|ing)|integrat(?:e|es|ed|ing)|adapt(?:s|ed|ing)?|convert(?:s|ed|ing)?|switch(?:es|ed|ing)?|rout(?:e|es|ed|ing)|prevent(?:s|ed|ing)?|support(?:s|ed|ing)?|preserv(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|configur(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing)|ensur(?:e|es|ed|ing)|allow(?:s|ed|ing)?|enabl(?:e|es|ed|ing)|disabl(?:e|es|ed|ing)|rework(?:s|ed|ing)?|revis(?:e|es|ed|ing)|optim(?:ize|izes|ized|izing)|complet(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|guarantee(?:s|d|ing)?|resolv(?:e|es|ed|ing)|improv(?:e|es|ed|ing)|document(?:s|ed|ing)?|generat(?:e|es|ed|ing)|stor(?:e|es|ed|ing)|us(?:e|es|ed|ing)|mak(?:e|ing)(?!\s+sure\b)|modif(?:y|ying)|change(?:s|d|ing)?)\b/i

export function isVerificationOnlyStory(story: Pick<StoryLike, "title" | "description">): boolean {
    // Free-form "verify/check/audit X" titles are product requirements as
    // often as they are final gates. Only a whole-title Run/Execute command
    // over a closed list of deterministic gates is eligible for pruning.
    if (!isBoundedFinalGateTitle(story.title)) return false
    if (!isBoundedFinalGateDescription(story.description)) return false

    const text = `${story.title}\n${story.description}`
    if (TEST_IMPLEMENTATION.test(text)) return false

    // These phrases describe a verification worker's bounded response to a
    // failed gate, not planned implementation scope. Remove them before
    // looking for a substantive change verb. A real request such as "fix the
    // cancellation protocol" remains visible and therefore remains a story.
    const scope = text
        .replace(/\bdo not\s+(?:introduce|add|implement|create)\s+(?:any\s+)?new\s+(?:features?|dependencies)\b/gi, "")
        .replace(/\bdo not\s+modify\s+(?:the\s+)?(?:implementation|product)(?:\s+code)?\b/gi, "")
        .replace(/\bdo not\s+replace\s+product\s+behavio(?:u)?r\b/gi, "")
        .replace(/\bno new (?:features?|dependencies|changes?)\b/gi, "")
        .replace(/\bonly (?:incidental|integration) fixes?\b/gi, "")
        .replace(/\b(?:fix(?:ing)?|repair(?:ing)?|correct(?:ing)?)\s+(?:(?:any|new)\s+)?(?=[^.\n]{0,100}\b(?:test|type(?:check)?|build|lint|compile|compilation|integration)\b)[^.\n]{0,100}\b(?:failures?|errors?|warnings?|issues?)\b/gi, "")
        .replace(/\b(?:fix(?:ing)?|repair(?:ing)?|correct(?:ing)?)\s+(?:(?:any|new)\s+)?(?:failures?|errors?|warnings?|issues?)\b/gi, "")
        .replace(/\brevert(?:ing)?\s+(?:any\s+)?(?:incidental\s+)?deviations?\b/gi, "")
        .replace(/\b(?:the\s+)?only\s+public\s+export\s+change\s+is\b/gi, "")

    return !SUBSTANTIVE_CHANGE.test(scope)
}

function isBoundedFinalGateTitle(title: string): boolean {
    if (!/^\s*(?:run|execute)\b/i.test(title)) return false

    let command = title.replace(/^\s*(?:run|execute)\s+/i, "").trim()
    // These suffixes are bounded reactions to deterministic gate output.
    command = command
        .replace(
            /\s+(?:and\s+)?(?:report|summarize)\s+(?:the\s+)?results?\s*$/i,
            "",
        )
        .replace(
            /\s*[,;:-]?\s*(?:and\s+)?(?:fix|repair|correct)\s+(?:(?:any|new|the)\s+)?(?:(?:test|type[ -]?check|build|lint|compile|compilation|integration)\s+)?(?:failures?|errors?|warnings?|issues?)\s*$/i,
            "",
        )
        .trim()

    const items = command
        .split(/\s*(?:,|;|\band\b|&|\+)\s*/i)
        .map((item) =>
            item
                .replace(
                    /^\s*(?:and\s+)?(?:(?:the|all|existing|final|full|project)\s+)+/i,
                    "",
                )
                .replace(/\s+commands?\s*$/i, "")
                .trim(),
        )
        .filter(Boolean)

    return items.length > 0 && items.every((item) => FINAL_GATE_ITEM.test(item))
}

function isBoundedFinalGateDescription(description: string): boolean {
    const clauses = description
        .split(/[.;\n]+/)
        .map((clause) => clause.trim())
        .filter(Boolean)
    if (clauses.length === 0) return false

    return clauses.every((clause) => {
        if (isBoundedFinalGateTitle(clause)) return true
        if (BOUNDED_INSPECTION_CLAUSE.test(clause)) return true
        if (isBoundedRepairClause(clause)) return true
        if (
            /^(?:report|summarize|record)\s+(?:(?:the|their)\s+)?(?:results?|outcomes?|failures?|status)$/i.test(
                clause,
            )
        ) return true
        return /^(?:do not\s+(?:(?:introduce|add|implement|create)\s+(?:any\s+)?new\s+(?:features?|dependencies)|modify\s+(?:the\s+)?(?:implementation|product)(?:\s+code)?|replace\s+product\s+behavio(?:u)?r)|no new (?:features?|dependencies|changes?)|only (?:incidental|integration) fixes?|revert(?:ing)?\s+(?:any\s+)?(?:incidental\s+)?deviations?)\s*(?:[—-]\s*only (?:incidental|integration) fixes?)?$/i.test(
            clause,
        )
    })
}

function isBoundedRepairClause(clause: string): boolean {
    const match = /^(?:fix|repair|correct)\s+(.+)$/i.exec(clause)
    if (!match) return false
    let scope = match[1]!
        .replace(
            /\s+caused by\s+(?:(?:cross-story|merged)\s+)?integration\s+issues?$/i,
            "",
        )
        .replace(/^(?:(?:any|new|the)\s+)+/i, "")
        .replace(/\s+(?:failures?|errors?|warnings?|issues?)$/i, "")
        .trim()
    if (!scope) return true
    const items = scope
        .split(/\s*(?:,|\band\b|\bor\b|&|\+)\s*/i)
        .map((item) => item.trim())
        .filter(Boolean)
    return items.length > 0 && items.every((item) => FINAL_GATE_ITEM.test(item))
}

export interface VerificationStoryPruneResult<T> {
    stories: T[]
    removedIds: string[]
}

/**
 * Remove verification-only nodes and replace every dependency on one with the
 * removed node's own prerequisites. This preserves the implementation DAG:
 * A -> verify -> B becomes A -> B, including chains of verification nodes.
 */
export function pruneVerificationOnlyStories<T extends StoryLike>(
    stories: readonly T[],
): VerificationStoryPruneResult<T> {
    const removed = new Set(
        stories.filter(isVerificationOnlyStory).map((story) => story.id),
    )
    if (removed.size === 0) {
        return { stories: [...stories], removedIds: [] }
    }

    const byId = new Map(stories.map((story) => [story.id, story]))
    const memo = new Map<string, string[]>()

    const expand = (storyId: string, visiting: Set<string>): string[] => {
        if (!removed.has(storyId)) return [storyId]
        const cached = memo.get(storyId)
        if (cached) return cached
        if (visiting.has(storyId)) {
            throw new Error(
                `invalid planner DAG: dependency cycle through verification story '${storyId}'`,
            )
        }
        const story = byId.get(storyId)
        if (!story) return [storyId]
        const nextVisiting = new Set(visiting).add(storyId)
        const dependencies = unique(
            story.dependsOn.flatMap((dependency) =>
                expand(dependency, nextVisiting),
            ),
        )
        memo.set(storyId, dependencies)
        return dependencies
    }

    const kept = stories
        .filter((story) => !removed.has(story.id))
        .map((story) => ({
            ...story,
            dependsOn: unique(
                story.dependsOn.flatMap((dependency) =>
                    expand(dependency, new Set([story.id])),
                ),
            ).filter((dependency) => dependency !== story.id),
        }))

    return { stories: kept, removedIds: [...removed] }
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)]
}
