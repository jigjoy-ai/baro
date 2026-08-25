/** Final run verification requests and evidence. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

export type RunVerificationStatus = "passed" | "failed" | "skipped"

export type VerificationCommandStatus = "passed" | "failed" | "skipped"

/**
 * Bounded capture of a command's real streams, kept for every executed
 * command (passing ones included) so downstream reviewers judge on output,
 * not status labels. Bounded once at capture; byte counts record what the
 * command actually produced before the tail was taken.
 */
export interface VerificationCommandOutput {
    stdout: string
    stderr: string
    stdoutBytes: number
    stderrBytes: number
    truncated: boolean
}

export interface VerificationCommandEvidence {
    command: string
    status: VerificationCommandStatus
    durationMs: number
    /** Tail of stderr/stdout for failed commands, or a skip explanation. */
    tail?: string
    /** Absent when the command never executed (preflight/containment/ENOENT). */
    output?: VerificationCommandOutput
    /** A failed test command was re-run once; this status is the retry's. */
    retriedAfterFailure?: true
    /** Evidence of the first attempt when a retry decided the status. */
    firstFailureTail?: string
}

/** The coordinator has integrated all candidate work and requests an objective gate. */
export interface RunVerificationRequestedData {
    runId: string
    verificationId: string
}

export const RunVerificationRequested =
    defineSemanticEvent<RunVerificationRequestedData>("run_verification_requested")

/** The coordinator's verification deadline elapsed; active work must cancel. */
export interface RunVerificationTimedOutData {
    runId: string
    verificationId: string
    timeoutMs: number
}

export const RunVerificationTimedOut =
    defineSemanticEvent<RunVerificationTimedOutData>("run_verification_timed_out")

export interface RunVerificationEvidence {
    verificationId: string
    status: RunVerificationStatus
    commands: readonly VerificationCommandEvidence[]
    durationMs: number
}

/** Objective build/test evidence for the fully integrated run branch. */
export interface RunVerificationCompletedData extends RunVerificationEvidence {
    runId: string
}

export const RunVerificationCompleted =
    defineSemanticEvent<RunVerificationCompletedData>("run_verification_completed")
