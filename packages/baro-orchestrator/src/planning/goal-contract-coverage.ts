import type {
    GoalContract,
    GoalStoryInvariantMapping,
} from "../runtime/goal-contract.js"

export type GoalContractCoverageMode = "partial" | "complete"

export type GoalContractCoverageErrorCode =
    | "unknown_invariant"
    | "incomplete_coverage"

export interface GoalContractCoverageResult {
    coveredInvariantIds: readonly string[]
    missingInvariantIds: readonly string[]
}

/** Structural planning error independent of any planner or runtime transport. */
export class GoalContractCoverageError extends Error {
    constructor(
        readonly code: GoalContractCoverageErrorCode,
        message: string,
    ) {
        super(message)
        this.name = "GoalContractCoverageError"
    }
}

/**
 * Validate story-to-invariant mappings against an active GoalContract.
 *
 * Partial plans may leave invariants for later fragments, but may never claim
 * an invariant outside the contract. Complete plans must cover the union of
 * every contract invariant at least once. A missing contract deliberately
 * keeps legacy/no-envelope plans outside this governance boundary.
 */
export function validateGoalContractCoverage(
    contract: GoalContract | null | undefined,
    mappings: readonly GoalStoryInvariantMapping[],
    mode: GoalContractCoverageMode,
): GoalContractCoverageResult {
    if (!contract) {
        return {
            coveredInvariantIds: [],
            missingInvariantIds: [],
        }
    }

    const knownIds = new Set(contract.invariants.map(({ id }) => id))
    const coveredIds = new Set<string>()
    const unknownMappings: string[] = []

    for (const mapping of mappings) {
        const unknownIds = mapping.invariantIds.filter(
            (invariantId) => !knownIds.has(invariantId),
        )
        if (unknownIds.length > 0) {
            unknownMappings.push(
                `${mapping.storyId}: ${[...new Set(unknownIds)].join(", ")}`,
            )
        }
        for (const invariantId of mapping.invariantIds) {
            if (knownIds.has(invariantId)) coveredIds.add(invariantId)
        }
    }

    if (unknownMappings.length > 0) {
        throw new GoalContractCoverageError(
            "unknown_invariant",
            `GoalContract mappings reference unknown invariant id(s): ${unknownMappings.join("; ")}`,
        )
    }

    const coveredInvariantIds = contract.invariants
        .map(({ id }) => id)
        .filter((id) => coveredIds.has(id))
    const missingInvariantIds = contract.invariants
        .map(({ id }) => id)
        .filter((id) => !coveredIds.has(id))

    if (mode === "complete" && missingInvariantIds.length > 0) {
        throw new GoalContractCoverageError(
            "incomplete_coverage",
            `GoalContract coverage is incomplete; no story owns invariant(s): ${missingInvariantIds.join(", ")}`,
        )
    }

    return { coveredInvariantIds, missingInvariantIds }
}
