/**
 * One owner for "which obligations are still unowned" and how an id list is
 * rendered, so the retry prompt, the publish receipt and the empty-tail
 * failure message can never disagree about either.
 */

import type { PrdStory } from "../../prd.js"
import {
    obligationMappingsForStories,
    validateArchitectureObligationCoverage,
    type ArchitectureObligationContractV1,
} from "./architecture-obligation-contract.js"

const MAX_RENDERED_IDS = 40

export function unownedObligationIds(
    contract: ArchitectureObligationContractV1 | null | undefined,
    stories: readonly Pick<PrdStory, "id" | "acceptance" | "goalInvariantIds">[],
): readonly string[] {
    if (!contract || contract.obligations.length === 0) return []
    try {
        return validateArchitectureObligationCoverage(
            contract,
            obligationMappingsForStories(stories),
            "partial",
        ).missingObligationIds
    } catch {
        // A malformed claim must read as a full gap, never as coverage.
        return contract.obligations.map((obligation) => obligation.id)
    }
}

export function formatObligationIdList(ids: readonly string[]): string {
    if (ids.length === 0) return ""
    const head = ids.slice(0, MAX_RENDERED_IDS).join(", ")
    return ids.length > MAX_RENDERED_IDS
        ? `${head} … (+${ids.length - MAX_RENDERED_IDS} more)`
        : head
}

export function obligationGapSummary(
    unowned: readonly string[],
    total: number,
): string {
    const counts = `${unowned.length}/${total}`
    return unowned.length === 0
        ? counts
        : `${counts}: ${formatObligationIdList(unowned)}`
}
