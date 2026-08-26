/**
 * `--resume` story selection. Resume never re-plans: it reads the plan the
 * previous run persisted and executes only what has not landed yet.
 */

import type { PrdFile, PrdStory } from "../prd.js"

export const RESUME_WITHOUT_STATUS_WARNING =
    "prd.json carries no per-story status; resuming with legacy behavior (all stories will be executed)"

export interface ResumeSelection {
    /** "legacy" means the PRD predates per-story status and tells us nothing. */
    mode: "statuses" | "legacy"
    skipped: string[]
    remaining: PrdStory[]
    warning?: string
}

/** A story is finished iff the run recorded it as passed or merged. */
function isFinished(story: PrdStory): boolean {
    return story.passes === true || story.mergeStatus === "merged"
}

export function selectResumeStories(prd: PrdFile): ResumeSelection {
    const stories = prd.userStories ?? []
    const carriesStatus = stories.some(
        (story) => story.passes === true || story.mergeStatus !== undefined,
    )
    if (!carriesStatus) {
        return {
            mode: "legacy",
            skipped: [],
            remaining: [...stories],
            warning: RESUME_WITHOUT_STATUS_WARNING,
        }
    }
    return {
        mode: "statuses",
        skipped: stories.filter(isFinished).map((story) => story.id),
        // A story whose merge failed is unfinished work, so resume retries it.
        remaining: stories.filter((story) => !isFinished(story)),
    }
}
