import type { ReplanData, ReplanStoryAdd } from "../semantic-events.js"

export interface ReservedPolicyReplan {
    replan: ReplanData
    /** Proposal-local aliases assigned by the Board at the safe boundary. */
    storyIdAliases: Readonly<Record<string, string>>
}

/**
 * Reserve concrete story ids for a batch of independent Surgeon proposals.
 *
 * Surgeons can inspect the same graph version concurrently and therefore
 * propose the same next ids. The first proposal keeps each id; later
 * proposals in this safe-boundary batch receive fresh ids. Existing PRD ids
 * remain strict validation errors because their intent is ambiguous, and
 * duplicate ids inside one proposal remain malformed for the same reason.
 *
 * All raw ids and references are reserved before allocation. A generated id
 * can consequently never turn a later proposal's valid id or invalid unknown
 * dependency into something with different semantics.
 */
export function reservePolicyReplanBatchIds(
    currentStoryIds: Iterable<string>,
    replans: readonly ReplanData[],
): ReservedPolicyReplan[] {
    const current = new Set(currentStoryIds)
    const unavailable = new Set(current)
    for (const replan of replans) reserveMutationIds(unavailable, replan)

    let nextNumericId = nextStoryNumber(unavailable)
    const claimedByEarlierProposal = new Set<string>()

    return replans.map((replan) => {
        const aliases = new Map<string, string>()
        const localCounts = countAddedIds(replan.addedStories)

        for (const story of replan.addedStories) {
            const id = story.id
            if (
                current.has(id) ||
                (localCounts.get(id) ?? 0) > 1
            ) {
                continue
            }
            if (!claimedByEarlierProposal.has(id)) {
                claimedByEarlierProposal.add(id)
                continue
            }

            let reserved: string
            do {
                reserved = `S${nextNumericId}`
                nextNumericId += 1n
            } while (unavailable.has(reserved))
            unavailable.add(reserved)
            aliases.set(id, reserved)
        }

        if (aliases.size === 0) {
            return {
                replan: snapshotReplan(replan),
                storyIdAliases: {},
            }
        }
        return {
            replan: rebaseReplan(replan, aliases),
            storyIdAliases: Object.fromEntries(aliases),
        }
    })
}

function reserveMutationIds(ids: Set<string>, replan: ReplanData): void {
    for (const story of replan.addedStories) {
        ids.add(story.id)
        for (const dependency of story.dependsOn) ids.add(dependency)
    }
    for (const storyId of replan.removedStoryIds) ids.add(storyId)
    for (const [storyId, dependencies] of Object.entries(replan.modifiedDeps)) {
        ids.add(storyId)
        for (const dependency of dependencies) ids.add(dependency)
    }
}

function nextStoryNumber(ids: Iterable<string>): bigint {
    let maximum = 0n
    for (const id of ids) {
        const match = /^S(\d+)$/.exec(id)
        if (!match) continue
        const numeric = BigInt(match[1]!)
        if (numeric > maximum) maximum = numeric
    }
    return maximum + 1n
}

function countAddedIds(stories: readonly ReplanStoryAdd[]): Map<string, number> {
    const counts = new Map<string, number>()
    for (const story of stories) {
        counts.set(story.id, (counts.get(story.id) ?? 0) + 1)
    }
    return counts
}

function rebaseReplan(
    replan: ReplanData,
    aliases: ReadonlyMap<string, string>,
): ReplanData {
    const aliasEntries = [...aliases]
    // JSON string escaping keeps arbitrary valid ids (including quotes,
    // brackets, and embedded newlines) data rather than Board-looking prose.
    // Tuples also retain deterministic allocation order without special object
    // keys such as "__proto__" acquiring accidental semantics in consumers.
    const aliasDetail = aliasAuditDetail(aliasEntries)
    return {
        ...snapshotReplan(replan),
        reason:
            `${replan.reason} ` +
            `[Board safe-boundary story-id aliases (JSON tuples): ${aliasDetail}]`,
        addedStories: replan.addedStories.map((story) => ({
            ...snapshotAddedStory(story),
            id: aliases.get(story.id) ?? story.id,
            description: appendAliasNote(story.description, aliasDetail),
            acceptance: [
                ...(story.acceptance ?? []),
                aliasAcceptanceContext(aliasDetail),
            ],
            dependsOn: story.dependsOn.map(
                (dependency) => aliases.get(dependency) ?? dependency,
            ),
        })),
        modifiedDeps: Object.fromEntries(
            Object.entries(replan.modifiedDeps).map(([storyId, dependencies]) => [
                storyId,
                dependencies.map(
                    (dependency) => aliases.get(dependency) ?? dependency,
                ),
            ]),
        ),
    }
}

function aliasAuditDetail(entries: readonly (readonly [string, string])[]): string {
    return JSON.stringify(entries).replace(
        /[^\x20-\x7e]/g,
        (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
}

function aliasAcceptanceContext(aliasDetail: string): string {
    return (
        `[Board identity context — not an additional product requirement: ` +
        `interpret proposal-local story ids using these canonical aliases ` +
        `(JSON tuples): ${aliasDetail}. Structured dependency fields are ` +
        `authoritative.]`
    )
}

function appendAliasNote(
    text: string,
    aliasDetail: string,
): string {
    return (
        `${text}\n\n` +
        `[Board canonical story-id aliases for this proposal (JSON tuples): ` +
        `${aliasDetail}. ` +
        `Structured dependency fields are authoritative.]`
    )
}

function snapshotReplan(replan: ReplanData): ReplanData {
    return {
        source: replan.source,
        reason: replan.reason,
        addedStories: replan.addedStories.map(snapshotAddedStory),
        removedStoryIds: [...replan.removedStoryIds],
        modifiedDeps: Object.fromEntries(
            Object.entries(replan.modifiedDeps).map(([storyId, dependencies]) => [
                storyId,
                [...dependencies],
            ]),
        ),
        ...(replan.recovery
            ? { recovery: { ...replan.recovery } }
            : {}),
    }
}

function snapshotAddedStory(story: ReplanStoryAdd): ReplanStoryAdd {
    return {
        ...story,
        dependsOn: [...story.dependsOn],
        ...(story.acceptance ? { acceptance: [...story.acceptance] } : {}),
        ...(story.tests ? { tests: [...story.tests] } : {}),
        ...(story.goalInvariantIds
            ? { goalInvariantIds: [...story.goalInvariantIds] }
            : {}),
    }
}
