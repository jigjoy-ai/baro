import type { RunVerificationEvidence } from "../semantic-events.js"

export interface RunSummary {
    /** True only when every original story passed and nothing was dropped. */
    success: boolean
    /** Why the run terminated early; null on a clean completion. */
    abortReason: string | null
    /**
     * Machine-readable classification of the abort, present when every
     * incomplete story's terminal failure shared one code — an external
     * consumer maps it without parsing prose (e.g. token_ceiling).
     */
    abortCode?: string
    completedStories: string[]
    failedStories: string[]
    /**
     * Stories the Surgeon dropped without a replacement. The PRD no
     * longer contains them, but the run did not complete the original
     * goal — these count against the success verdict.
     */
    droppedStories: string[]
    totalDurationSecs: number
    totalAttempts: number
    /** Present when an objective run-level verification gate was requested. */
    verificationStatus?: "passed" | "failed" | "skipped"
    /** Full correlated evidence behind verificationStatus. */
    verification?: RunVerificationEvidence
}
