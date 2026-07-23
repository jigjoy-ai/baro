/** Final run verification requests and evidence. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

export type RunVerificationStatus = "passed" | "failed" | "skipped"

export type VerificationCommandStatus = "passed" | "failed" | "skipped"

export interface VerificationCommandEvidence {
    command: string
    status: VerificationCommandStatus
    durationMs: number
    /** Tail of stderr/stdout for failed commands, or a skip explanation. */
    tail?: string
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
