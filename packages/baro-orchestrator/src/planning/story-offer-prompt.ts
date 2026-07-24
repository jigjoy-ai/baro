/**
 * Pure assembly of the worker prompt for one story offer: the global goal
 * contract, the Architect's shared decision baseline, accepted runtime
 * amendments, and the story's own work order. Extracted from the Board so
 * the A20 failure surface (prompt projection) is a testable function of
 * (prd, story) rather than live scheduler state.
 */

import {
    buildDefaultStoryPrompt,
    type PrdFile,
    type PrdStory,
} from "../prd.js"
import {
    deriveGoalContract,
    renderGoalContractPrompt,
} from "../runtime/goal-contract.js"
import { renderRuntimeAmendmentsForPrompt } from "./runtime-amendments.js"

export function buildStoryOfferPrompt(
    prd: Pick<PrdFile, "goalEnvelope" | "decisionDocument" | "runtimeGraph"> | null,
    story: PrdStory,
): string {
    const sections: string[] = []
    const contract = deriveGoalContract(prd?.goalEnvelope)
    if (contract) {
        sections.push(
            "## Global goal contract",
            "",
            renderGoalContractPrompt(contract, story.goalInvariantIds ?? []),
            "",
            "---",
            "",
        )
    }
    const document = prd?.decisionDocument?.trim()
    if (document) {
        sections.push(
            "## Current shared design decision",
            "",
            "This is the Architect's evidence-backed baseline, not an override of the global goal. Preserve it unless repository evidence proves an amendment is required; propose that amendment through the collective rather than silently diverging.",
            "",
            document,
            "",
            "---",
            "",
        )
    }
    const runtimeAmendments = renderRuntimeAmendmentsForPrompt(prd)
    if (runtimeAmendments) {
        sections.push(
            runtimeAmendments.trim(),
            "",
            "---",
            "",
        )
    }
    sections.push(buildDefaultStoryPrompt(story))
    return sections.join("\n")
}

export interface StoryRecoveryContext {
    kind: string
    reason: string
    branch?: string | null
}

/** Prefix section for an offer that resumes or retries earlier work. */
export function buildRecoveryPromptSection(
    recovery: StoryRecoveryContext,
): string {
    return [
        recovery.kind === "dependency"
            ? "## Resumed after dependency integration"
            : "## Recovery attempt",
        "",
        recovery.kind === "dependency"
            ? `The previous attempt cooperatively paused: ${recovery.reason}`
            : `The previous ${recovery.kind} attempt failed: ${recovery.reason}`,
        recovery.branch
            ? `This fresh worktree starts at the latest integrated run branch. The rejected attempt is preserved at ${recovery.branch}. Inspect \`git diff HEAD...${recovery.branch}\` and \`git show ${recovery.branch}\`, then reapply its intent while preserving already-integrated work. Do not merge or cherry-pick the backup wholesale. Run the required checks and commit the reconciled result.`
            : "Re-run the story from the current integrated repository state, address the failure, run the required checks, and commit the corrected work.",
    ].join("\n")
}
