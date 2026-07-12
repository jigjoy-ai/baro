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

const VERIFICATION_LEAD = /^\s*(?:run|verify|validate|check|audit|execute)\b/i
const FINAL_GATE =
    /\b(?:tests?|test suite|type[ -]?check|lint|build|compile|compilation|cargo check|cargo clippy)\b/i

const TEST_IMPLEMENTATION =
    /\b(?:add(?:ing)?|writ(?:e|ing)|creat(?:e|ing)|implement(?:ing)?|extend(?:ing)?|updat(?:e|ing)|refactor(?:ing)?)\b[^.\n]{0,80}\btests?\b/i

const SUBSTANTIVE_CHANGE =
    /\b(?:add(?:ing)?|writ(?:e|ing)|creat(?:e|ing)|implement(?:ing)?|extend(?:ing)?|updat(?:e|ing)|refactor(?:ing)?|migrat(?:e|ing)|wir(?:e|ing)|introduc(?:e|ing)|fix(?:ing)?|modif(?:y|ying)|change(?:ing)?)\b/i

export function isVerificationOnlyStory(story: Pick<StoryLike, "title" | "description">): boolean {
    if (!VERIFICATION_LEAD.test(story.title)) return false

    const text = `${story.title}\n${story.description}`
    if (!FINAL_GATE.test(text) || TEST_IMPLEMENTATION.test(text)) return false

    // These phrases describe a verification worker's bounded response to a
    // failed gate, not planned implementation scope. Remove them before
    // looking for a substantive change verb. A real request such as "fix the
    // cancellation protocol" remains visible and therefore remains a story.
    const scope = text
        .replace(/\bdo not\s+(?:add|write|create|implement|extend|update|refactor|migrate|wire|introduce|modify|change)\b[^.\n]*/gi, "")
        .replace(/\bno new (?:features?|dependencies|changes?)\b/gi, "")
        .replace(/\bonly (?:incidental|integration) fixes?\b/gi, "")
        .replace(/\bfix(?:ing)?\s+(?:(?:any|new)\s+)?(?=[^.\n]{0,100}\b(?:test|type(?:check)?|build|lint|compile|compilation|integration)\b)[^.\n]{0,100}\b(?:failures?|errors?|warnings?|issues?)\b/gi, "")
        .replace(/\bfix(?:ing)?\s+(?:(?:any|new)\s+)?(?:failures?|errors?|warnings?|issues?)\b/gi, "")
        .replace(/\brevert(?:ing)?\s+(?:any\s+)?(?:incidental\s+)?deviations?\b/gi, "")
        .replace(/\b(?:the\s+)?only\s+public\s+export\s+change\s+is\b/gi, "")

    return !SUBSTANTIVE_CHANGE.test(scope)
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
