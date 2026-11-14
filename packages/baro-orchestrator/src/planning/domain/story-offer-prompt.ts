/**
 * Pure assembly of the worker prompt for one story offer: the global goal
 * contract, the Architect's shared decision baseline, accepted runtime
 * amendments, and the story's own work order. Extracted from the Board so
 * the A20 failure surface (prompt projection) is a testable function of
 * (prd, story) rather than live scheduler state.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
    buildDefaultStoryPrompt,
    type PrdFile,
    type PrdStory,
} from "../../prd.js"
import {
    deriveGoalContract,
    renderGoalContractPrompt,
} from "../../goal/goal-contract.js"
import { renderRuntimeAmendmentsForPrompt } from "./runtime-amendments.js"

export function buildStoryOfferPrompt(
    prd: Pick<PrdFile, "goalEnvelope" | "decisionDocument" | "runtimeGraph"> | null,
    story: PrdStory,
    fullGoal: string | null = null,
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
    const goalText = fullGoal?.trim()
    if (goalText) {
        sections.push(
            "## Full goal text",
            "",
            "The intake saw only the head of this goal; this is the complete text the user supplied.",
            "",
            goalText,
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

/** File beside prd.json holding the full text of a long --goal-file goal. */
const RUN_GOAL_FILE = "goal.md"

/**
 * Reads the full goal text the CLI keeps beside prd.json when the intake saw
 * only a bounded head of it. Returns null when there is no such file or it
 * holds only whitespace; any other read error is rethrown.
 */
export function readRunGoalText(prdPath: string): string | null {
    let text: string
    try {
        text = readFileSync(join(dirname(prdPath), RUN_GOAL_FILE), "utf8")
    } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) return null
        throw error
    }
    return text.trim() ? text : null
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code
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
