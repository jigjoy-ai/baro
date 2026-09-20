/**
 * Whether re-running a failed run-level verification command can change the
 * verdict, and what to repair first.
 *
 * `classifyFailureTail` says what a tail MEANS; this says what the gate DOES
 * about it. Splitting the two keeps the signal table inert data while the
 * policy — refusals included — stays in one place, so verify.ts has exactly
 * one retry decision site and no call site has to re-derive the rules.
 */

import { classifyFailureTail } from "./failure-classifier.js"
import type { FailureBucket, FailureRemedy } from "./failure-signals.js"

export type { FailureBucket, FailureRemedy } from "./failure-signals.js"

export interface RetryHints {
    /** The command was killed at its ceiling rather than failing on its own. */
    readonly timedOut?: boolean
    /** The harness broke — e.g. the cwd vanished (stamped by runCmd). */
    readonly environment?: boolean
    readonly retryable?: boolean
    /** Unknown counts as busy: an absent reading must not license a retry. */
    readonly storyExecutorsActive?: boolean
}

export type RetryRefusal =
    | "classified-regression"
    | "not-retryable"
    | "story-executors-active"

export interface RetryDecision {
    readonly retry: boolean
    readonly bucket: FailureBucket
    /** The repair to apply before the retry; "none" whenever retry is false. */
    readonly remedy: FailureRemedy
    readonly signalId: string | null
    /** Null exactly when `retry` is true. */
    readonly refusal: RetryRefusal | null
}

export function decideRetry(
    tail: string,
    hints: RetryHints = {},
): RetryDecision {
    const { bucket, remedy, signalId } = classifyFailureTail(tail, {
        timedOut: hints.timedOut,
        environment: hints.environment,
    })
    const refuse = (refusal: RetryRefusal): RetryDecision => ({
        retry: false,
        bucket,
        remedy: "none",
        signalId,
        refusal,
    })
    if (hints.retryable === false) return refuse("not-retryable")
    // Re-running a ceiling kill while stories still load the machine only
    // doubles the wait, so an unknown load counts as busy.
    if (bucket === "time-ceiling" && hints.storyExecutorsActive !== false) {
        return refuse("story-executors-active")
    }
    // A regression's tail is the story agent's evidence; re-running only
    // delays handing it back.
    if (bucket === "regression") return refuse("classified-regression")
    return {
        retry: true,
        bucket,
        remedy:
            bucket === "time-ceiling"
                ? "lift-ceiling"
                : remedy === "none"
                  ? "install-dependencies"
                  : remedy,
        signalId,
        refusal: null,
    }
}
