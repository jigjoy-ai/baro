/**
 * The run tail protocol, extracted from the Board: request objective
 * verification, classify its evidence, escalate to the goal-completion
 * check, and settle the attestation — including the fail-closed ledger
 * match and the incomplete-verification remediation detour. The host
 * remains the phase authority and durable committer; this gate owns the
 * correlation state and both watchdogs.
 */

import { randomUUID } from "node:crypto"

import type { SemanticEvent } from "../runtime/mozaik.js"

import type { PrdCollectiveProtocolState, PrdFile } from "../prd.js"
import { deriveGoalContract } from "../runtime/goal-contract.js"
import { envNonNegativeInt } from "../runtime/env-int.js"
import { NamedTimers } from "../runtime/named-timers.js"
import {
    ConductorState,
    GoalCompletionCheckRequested,
    RunVerificationRequested,
    RunVerificationTimedOut,
    defineSemanticEvent,
    type GoalCompletionAttestedData,
    type RunVerificationCompletedData,
    type RunVerificationEvidence,
} from "../semantic-events.js"

export interface GoalCompletionCheckTimedOutData {
    runId: string
    checkId: string
    contractId: string | null
    verificationId: string
    timeoutMs: number
}

export const GoalCompletionCheckTimedOut =
    defineSemanticEvent<GoalCompletionCheckTimedOutData>(
        "goal_completion_check_timed_out",
    )

export interface VerificationGoalGateHost {
    emit(event: SemanticEvent<unknown>): void
    phase(): string
    /** running → verifying; the host stays the only phase authority. */
    enterVerifying(): void
    requestPush(reason: string | null): void
    prd(): PrdFile | null
    persistGoalProtocol(protocol: PrdCollectiveProtocolState): void
    waveOrdinal(): number
}

export interface VerificationGoalGateOptions {
    runId: string
    verifyBeforePush: boolean
    verificationTimeoutMs?: number
    goalCompletionTimeoutMs?: number
    hasGoalCompletionAuthority: boolean
    host: VerificationGoalGateHost
}

export class VerificationGoalGate {
    private verificationSequence = 0
    private goalCheckSequence = 0
    private readonly verificationEpoch = randomUUID()
    private pendingVerificationId: string | null = null
    private pendingGoalCheck: {
        checkId: string
        contractId: string | null
        verificationId: string
        verificationIncompleteReason: string | null
    } | null = null
    private verificationStatus: "passed" | "failed" | "skipped" | undefined
    private verificationEvidence: RunVerificationEvidence | undefined
    private readonly timers = new NamedTimers<"verification" | "goalCompletion">()

    constructor(private readonly opts: VerificationGoalGateOptions) {}

    private get host(): VerificationGoalGateHost {
        return this.opts.host
    }

    status(): "passed" | "failed" | "skipped" | undefined {
        return this.verificationStatus
    }

    evidence(): RunVerificationEvidence | undefined {
        return this.verificationEvidence
    }

    matchesPendingVerification(verificationId: string): boolean {
        return this.pendingVerificationId === verificationId
    }

    /** Push/terminate settlement: drop watchdogs and correlation state but
     * keep the verification outcome for the run summary. */
    releasePendings(): void {
        this.timers.clearAll()
        this.pendingVerificationId = null
        this.pendingGoalCheck = null
    }

    /** A goal remediation invalidated the older verification snapshot. */
    abandonForRemediation(): void {
        this.releasePendings()
        this.verificationStatus = undefined
        this.verificationEvidence = undefined
    }

    requestVerification(reason: string | null): void {
        if (reason !== null) {
            this.host.requestPush(reason)
            return
        }
        if (!this.opts.verifyBeforePush) {
            this.requestGoalCompletion("verification-disabled")
            return
        }
        if (this.host.phase() !== "running") return
        const verificationId =
            `${this.opts.runId}:verification:${this.verificationEpoch}:${++this.verificationSequence}`
        this.pendingVerificationId = verificationId
        this.host.enterVerifying()
        const timeoutMs =
            this.opts.verificationTimeoutMs ??
            envNonNegativeInt("BARO_RUN_VERIFICATION_TIMEOUT_SECS", 21 * 60) * 1_000
        if (timeoutMs > 0) {
            this.timers.arm("verification", timeoutMs, () => {
                this.host.emit(
                    RunVerificationTimedOut.create({
                        runId: this.opts.runId,
                        verificationId,
                        timeoutMs,
                    }),
                )
            })
        }
        this.host.emit(
            ConductorState.create({
                phase: "level_complete",
                detail: "collective work integrated; verifying merged result",
                currentLevel: this.host.waveOrdinal(),
            }),
        )
        this.host.emit(
            RunVerificationRequested.create({
                runId: this.opts.runId,
                verificationId,
            }),
        )
    }

    onVerificationCompleted(result: RunVerificationCompletedData): void {
        this.timers.clear("verification")
        this.pendingVerificationId = null
        const hasPassedCommand = result.commands.some(
            (command) => command.status === "passed",
        )
        const failedCommand = result.commands.find(
            (command) => command.status === "failed",
        )
        const skippedCommands = result.commands
            .filter((command) => command.status === "skipped")
            .map((command) => command.command)
        const effectiveStatus =
            failedCommand || result.status === "failed"
                ? "failed"
                : result.status === "passed" &&
                      hasPassedCommand &&
                      skippedCommands.length === 0
                  ? "passed"
                  : "skipped"
        this.verificationStatus = effectiveStatus
        this.verificationEvidence = {
            verificationId: result.verificationId,
            status: effectiveStatus,
            commands: result.commands.map((command) => ({ ...command })),
            durationMs: result.durationMs,
        }
        if (effectiveStatus === "failed") {
            this.host.requestPush(
                `verification failed: ${failedCommand?.command ?? "build/test"}`,
            )
            return
        }
        if (effectiveStatus === "skipped") {
            const incoherentPass = result.status === "passed"
            const reason = incoherentPass
                ? "objective verification incomplete: verifier reported passed without complete passing command evidence"
                : skippedCommands.length > 0
                  ? `objective verification incomplete: skipped ${skippedCommands.join(", ")}`
                  : hasPassedCommand
                    ? "objective verification incomplete: verifier reported skipped despite passing command evidence"
                  : "objective verification incomplete: no applicable build/test/typecheck/lint commands ran"
            const prd = this.host.prd()
            const hasGoalContract = Boolean(
                prd && deriveGoalContract(prd.goalEnvelope),
            )
            if (
                hasPassedCommand &&
                hasGoalContract &&
                this.opts.hasGoalCompletionAuthority
            ) {
                this.requestGoalCompletion(result.verificationId, reason)
                return
            }
            this.host.requestPush(reason)
            return
        }
        this.requestGoalCompletion(result.verificationId)
    }

    onVerificationTimedOut(verificationId: string, timeoutMs: number): void {
        const reason = `verification timed out after ${Math.ceil(timeoutMs / 1_000)}s`
        this.timers.clear("verification")
        this.verificationStatus = "failed"
        this.verificationEvidence = {
            verificationId,
            status: "failed",
            commands: [
                {
                    command: "baro run verifier",
                    status: "failed",
                    durationMs: timeoutMs,
                    tail: reason,
                },
            ],
            durationMs: timeoutMs,
        }
        this.host.requestPush(reason)
    }

    private requestGoalCompletion(
        verificationId: string,
        verificationIncompleteReason: string | null = null,
    ): void {
        const prd = this.host.prd()
        if (!prd) return
        if (!this.opts.hasGoalCompletionAuthority) {
            this.host.requestPush(null)
            return
        }
        const phase = this.host.phase()
        if (phase !== "running" && phase !== "verifying") return

        const contract = deriveGoalContract(prd.goalEnvelope)
        const checkId =
            `${this.opts.runId}:goal-check:${++this.goalCheckSequence}`
        this.host.enterVerifying()
        this.pendingGoalCheck = {
            checkId,
            contractId: contract?.contractId ?? null,
            verificationId,
            verificationIncompleteReason,
        }
        const configuredTimeoutMs =
            this.opts.goalCompletionTimeoutMs ??
            envNonNegativeInt("BARO_GOAL_COMPLETION_TIMEOUT_SECS", 30) * 1_000
        const timeoutMs = Math.max(
            1,
            Math.min(configuredTimeoutMs, 2_147_483_647),
        )
        const pending = this.pendingGoalCheck
        this.timers.arm("goalCompletion", timeoutMs, () => {
            this.host.emit(
                GoalCompletionCheckTimedOut.create({
                    runId: this.opts.runId,
                    checkId: pending.checkId,
                    contractId: pending.contractId,
                    verificationId: pending.verificationId,
                    timeoutMs,
                }),
            )
        })
        this.host.emit(
            ConductorState.create({
                phase: "level_complete",
                detail: verificationIncompleteReason
                    ? "objective verification is incomplete; checking global goal invariants for actionable remediation"
                    : contract
                      ? "objective verification passed; checking global goal invariants"
                      : "objective verification passed; goal governance is disabled for this legacy PRD",
                currentLevel: this.host.waveOrdinal(),
            }),
        )
        this.host.emit(
            GoalCompletionCheckRequested.create({
                runId: this.opts.runId,
                checkId,
                contractId: contract?.contractId ?? null,
                storyIds: prd.userStories
                    .filter((story) => story.passes)
                    .map((story) => story.id),
                verificationId,
            }),
        )
    }

    onGoalCompletionAttested(attestation: GoalCompletionAttestedData): void {
        const pending = this.pendingGoalCheck
        if (
            !pending ||
            attestation.checkId !== pending.checkId ||
            attestation.contractId !== pending.contractId ||
            attestation.verificationId !== pending.verificationId
        ) return
        this.timers.clear("goalCompletion")
        if (attestation.contractId !== null) {
            const protocol = this.host.prd()?.runtimeGraph?.protocol
            if (
                !protocol ||
                protocol.goal.contractId !== attestation.contractId ||
                protocol.goal.revision !== attestation.goalRevision
            ) {
                throw new Error(
                    "goal attestation does not match its durable ledger projection",
                )
            }
            if (pending.verificationIncompleteReason === null) {
                this.host.persistGoalProtocol({
                    ...protocol,
                    completion: structuredClone(attestation),
                })
            }
        }
        this.pendingGoalCheck = null
        if (
            attestation.status === "satisfied" ||
            attestation.status === "disabled"
        ) {
            this.host.requestPush(pending.verificationIncompleteReason)
            return
        }
        const unresolved = [
            ...attestation.openInvariantIds,
            ...attestation.rejectedInvariantIds,
        ]
        const goalReason = `global goal is not satisfied${
                unresolved.length > 0
                    ? ` (${unresolved.join(", ")})`
                    : ""
            }: ${attestation.reason}`
        this.host.requestPush(
            pending.verificationIncompleteReason
                ? `${pending.verificationIncompleteReason}; ${goalReason}`
                : goalReason,
        )
    }

    onGoalCompletionCheckTimedOut(
        timeout: GoalCompletionCheckTimedOutData,
    ): void {
        const pending = this.pendingGoalCheck
        if (
            this.host.phase() !== "verifying" ||
            !pending ||
            timeout.checkId !== pending.checkId ||
            timeout.contractId !== pending.contractId ||
            timeout.verificationId !== pending.verificationId
        ) return
        this.timers.clear("goalCompletion")
        this.host.requestPush(
            `goal completion attestation timed out after ` +
                `${Math.ceil(timeout.timeoutMs / 1_000)}s`,
        )
    }
}
