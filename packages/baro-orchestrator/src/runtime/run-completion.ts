/**
 * Pure run-completion projections extracted from the Board: which stories a
 * failure transitively blocks, and whether the attested goal evidence still
 * authorizes a successful finish.
 */

import type { PrdFile } from "../prd.js"
import { deriveGoalContract } from "./goal-contract.js"

/** Stories that cannot start because a dependency failed (transitively). */
export function blockedStoryIds(
    prd: Pick<PrdFile, "userStories"> | null,
    failed: ReadonlySet<string>,
): Set<string> {
    if (!prd || failed.size === 0) return new Set()
    const blocked = new Set<string>()
    let changed = true
    while (changed) {
        changed = false
        for (const story of prd.userStories) {
            if (story.passes || failed.has(story.id) || blocked.has(story.id)) {
                continue
            }
            if (story.dependsOn.some((id) => failed.has(id) || blocked.has(id))) {
                blocked.add(story.id)
                changed = true
            }
        }
    }
    return blocked
}

/**
 * Null when the run may finish successfully: either no goal contract exists,
 * or the durable completion receipt attests the exact current contract and
 * goal revision as satisfied. Any drift after attestation fails closed.
 */
export function goalCompletionFailure(
    prd: Pick<PrdFile, "goalEnvelope" | "runtimeGraph"> | null,
): string | null {
    if (!prd) return "global goal state is unavailable"
    const contract = deriveGoalContract(prd.goalEnvelope)
    if (!contract) return null
    const completion = prd.runtimeGraph?.protocol?.completion
    if (
        completion?.contractId === contract.contractId &&
        completion.goalRevision ===
            prd.runtimeGraph?.protocol?.goal.revision &&
        completion.status === "satisfied"
    ) return null
    return "global goal evidence changed after completion attestation"
}
