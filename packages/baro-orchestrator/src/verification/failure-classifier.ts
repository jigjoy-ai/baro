/**
 * Policy for what a verification failure means and whether re-running it can
 * change the verdict. The table it reads lives in ./failure-signals.js.
 *
 * The retry budget stays at one attempt per command in every bucket: a second
 * retry has never turned a red gate green and doubles the gate's wall clock.
 */

import {
    loadFailureSignals,
    type FailureBucket,
    type FailureRemedy,
    type FailureSignal,
} from "./failure-signals.js"

export interface FailureClassification {
    bucket: FailureBucket
    remedy: FailureRemedy
    /** Null when the bucket came from a hint or from the regression default. */
    signalId: string | null
}

export interface FailureHints {
    /** The command was killed at its ceiling rather than failing on its own. */
    timedOut?: boolean
    /** The harness broke — e.g. the cwd vanished (stamped by runCmd). */
    environment?: boolean
    /** Set once a command has already used its single retry. */
    alreadyRetried?: boolean
}

export interface RetryDecision {
    retry: boolean
    classification: FailureClassification
    /** Raise the absolute ceiling for this one command on the retry. */
    liftCeiling: boolean
    /** Applied once before the retry; "none" when the bucket needs no repair. */
    remedy: FailureRemedy
}

const REGRESSION_DEFAULT: FailureClassification = Object.freeze({
    bucket: "regression",
    remedy: "none",
    signalId: null,
})

/**
 * Precedence is fixed: an explicit environment hint, then a timeout hint, then
 * the first matching signal, then regression. The hints outrank the table
 * because they are facts the runner observed, not text it guessed from.
 */
export function classifyFailureTail(
    tail: string,
    hints: FailureHints = {},
): FailureClassification {
    const signals = loadFailureSignals()
    if (hints.environment) {
        // Bucket is settled by the hint; the table only supplies the sharper
        // remedy (a vanished cwd needs the worktree back, not an install).
        const signal = firstMatch(signals, tail, "environment")
        return {
            bucket: "environment",
            remedy: signal?.remedy ?? "rematerialize-worktree",
            signalId: signal?.id ?? null,
        }
    }
    if (hints.timedOut) {
        return { bucket: "time-ceiling", remedy: "lift-ceiling", signalId: null }
    }
    const signal = firstMatch(signals, tail)
    if (signal) {
        return { bucket: signal.bucket, remedy: signal.remedy, signalId: signal.id }
    }
    return { ...REGRESSION_DEFAULT }
}

/**
 * The retry verdict for one failed attempt. `alreadyRetried` is what makes
 * "at most once" a property of this module rather than of each call site.
 */
export function decideRetry(
    tail: string,
    hints: FailureHints = {},
): RetryDecision {
    const classification = classifyFailureTail(tail, hints)
    if (hints.alreadyRetried) {
        return { retry: false, classification, liftCeiling: false, remedy: "none" }
    }
    switch (classification.bucket) {
        case "environment":
            return {
                retry: true,
                classification,
                liftCeiling: false,
                remedy: classification.remedy,
            }
        case "time-ceiling":
            return {
                retry: true,
                classification,
                liftCeiling: true,
                remedy: "lift-ceiling",
            }
        default:
            // A regression's tail is the story agent's evidence; re-running
            // only delays handing it back.
            return { retry: false, classification, liftCeiling: false, remedy: "none" }
    }
}

function firstMatch(
    signals: readonly FailureSignal[],
    tail: string,
    bucket?: FailureBucket,
): FailureSignal | undefined {
    const haystack = tail.toLowerCase()
    return signals.find(
        (signal) =>
            (bucket === undefined || signal.bucket === bucket) &&
            haystack.includes(signal.match.toLowerCase()),
    )
}
