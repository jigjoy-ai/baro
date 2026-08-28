/**
 * Whether a board-rejected final planner tail may be discarded instead of
 * failing the run: the admitted stories have all settled successfully and the
 * admitted set *alone* already owns every architecture obligation and every
 * GoalContract invariant, so the tail carried nothing the goal still needs.
 *
 * Fail-closed by construction — the obligation check runs over admitted
 * stories only and its failure is a blocker, never a tolerance.
 */

import type { GoalContract } from "../../goal/goal-contract.js"
import type { PrdFile, PrdStory } from "../../prd.js"
import {
    architectureObligationsFromDecision,
    obligationMappingsForStories,
    validateArchitectureObligationCoverage,
} from "./architecture-obligation-contract.js"
import { validateGoalContractCoverage } from "./goal-contract-coverage.js"

export interface FinalTailToleranceInput {
    prd: PrdFile
    admittedStoryIds: readonly string[]
    goalContract: GoalContract | null | undefined
}

export type FinalTailTolerance =
    | { tolerated: true }
    | {
          tolerated: false
          blocker:
              | "unsettled_stories"
              | "obligation_unowned"
              | "goal_contract_incomplete"
          detail: string
      }

/** First blocker wins; only an unblocked evaluation may discard the tail. */
export function evaluateFinalTailTolerance(
    input: FinalTailToleranceInput,
): FinalTailTolerance {
    const byId = new Map(
        (input.prd.userStories ?? []).map((story) => [story.id, story]),
    )
    const admittedStories: PrdStory[] = []
    const unsettled: string[] = []
    for (const storyId of input.admittedStoryIds) {
        const story = byId.get(storyId)
        if (!story || !isSettled(story)) {
            unsettled.push(storyId)
            continue
        }
        admittedStories.push(story)
    }
    if (unsettled.length > 0) {
        return {
            tolerated: false,
            blocker: "unsettled_stories",
            detail: unsettled.join(", "),
        }
    }

    try {
        const { missingObligationIds } = validateArchitectureObligationCoverage(
            architectureObligationsFromDecision(
                input.prd.decisionDocument,
                input.goalContract,
            ),
            obligationMappingsForStories(admittedStories),
            "complete",
        )
        if (missingObligationIds.length > 0) {
            return {
                tolerated: false,
                blocker: "obligation_unowned",
                detail: `no admitted story owns: ${missingObligationIds.join(", ")}`,
            }
        }
    } catch (error) {
        return {
            tolerated: false,
            blocker: "obligation_unowned",
            detail: messageOf(error),
        }
    }

    try {
        validateGoalContractCoverage(
            input.goalContract,
            admittedStories.map((story) => ({
                storyId: story.id,
                invariantIds: story.goalInvariantIds ?? [],
            })),
            "complete",
        )
    } catch (error) {
        return {
            tolerated: false,
            blocker: "goal_contract_incomplete",
            detail: messageOf(error),
        }
    }

    return { tolerated: true }
}

/**
 * src/prd.ts exports no terminal-status predicate and PrdStory carries no
 * `status` field; settlement is `passes` plus host-owned `mergeStatus`. This
 * mirrors the repository's only definition, the private `isFinished` in
 * src/execution/resume-selection.ts:19-22 — a merge that *failed* is unfinished
 * work, so it is deliberately not settled here either.
 */
function isSettled(story: PrdStory): boolean {
    return story.passes === true || story.mergeStatus === "merged"
}

function messageOf(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}
