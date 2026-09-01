/**
 * One owner for "which goal invariants are still unowned" and how an id list
 * is rendered, so the publish receipt, the coverage-gap warning and the
 * finalization repair prompt can never disagree about either.
 */

import type {
    GoalContract,
    GoalInvariant,
    GoalStoryInvariantMapping,
} from "../../goal/goal-contract.js"
import type { PrdStory } from "../../prd.js"
import { validateGoalContractCoverage } from "./goal-contract-coverage.js"

const MAX_RENDERED_IDS = 40

export function unownedInvariantIds(
    contract: GoalContract | null | undefined,
    stories: readonly Pick<PrdStory, "id" | "goalInvariantIds">[],
): readonly string[] {
    if (!contract || contract.invariants.length === 0) return []
    const mappings: GoalStoryInvariantMapping[] = stories.map((story) => ({
        storyId: story.id,
        invariantIds: story.goalInvariantIds ?? [],
    }))
    try {
        return validateGoalContractCoverage(contract, mappings, "partial")
            .missingInvariantIds
    } catch {
        // A malformed claim must read as a full gap, never as coverage.
        return contract.invariants.map((invariant) => invariant.id)
    }
}

export function formatInvariantIdList(ids: readonly string[]): string {
    if (ids.length === 0) return ""
    const head = ids.slice(0, MAX_RENDERED_IDS).join(", ")
    return ids.length > MAX_RENDERED_IDS
        ? `${head} … (+${ids.length - MAX_RENDERED_IDS} more)`
        : head
}

export function invariantGapSummary(
    unowned: readonly string[],
    total: number,
): string {
    const counts = `${unowned.length}/${total}`
    return unowned.length === 0
        ? counts
        : `${counts}: ${formatInvariantIdList(unowned)}`
}

export function unownedInvariantsWithText(
    contract: GoalContract | null | undefined,
    ids: readonly string[],
): readonly GoalInvariant[] {
    if (!contract) return []
    const wanted = new Set(ids)
    return contract.invariants.filter((invariant) => wanted.has(invariant.id))
}

export function renderUnownedInvariantLines(
    invariants: readonly GoalInvariant[],
): string {
    const lines = invariants
        .slice(0, MAX_RENDERED_IDS)
        .map((invariant) => `- [${invariant.id}] ${invariant.text}`)
    if (invariants.length > MAX_RENDERED_IDS) {
        lines.push(`- … (+${invariants.length - MAX_RENDERED_IDS} more)`)
    }
    return lines.join("\n")
}
