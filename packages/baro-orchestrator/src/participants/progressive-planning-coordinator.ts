import type { SemanticEvent } from "@mozaik-ai/core"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
    normalizePrd,
    type PrdFile,
    type PrdProgressivePlanningState,
    type PrdStory,
} from "../prd.js"
import {
    ConductorState,
    PlanFragmentAdmitted,
    PlanFragmentProposed,
    PlanFragmentRejected,
    PlanningStreamClosed,
    PlanningStreamCompleted,
    PlanningStreamFailed,
    PlanningStreamOpened,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    type PlanFragmentProposedData,
    type PlanFragmentRejectionCode,
    type PlanningStreamCompletedData,
    type PlanningStreamFailedData,
    type RuntimeReplanProposedData,
} from "../semantic-events.js"
import {
    ProgressivePlanContractError,
    progressivePlanFragmentFingerprint,
    reconcileProgressivePlanStories,
    validateProgressivePlanFragment,
} from "../planning/progressive-plan.js"
import { validateGoalContractCoverage } from "../planning/goal-contract-coverage.js"
import {
    architectureObligationsFromDecision,
    obligationMappingsForStories,
    validateArchitectureObligationCoverage,
} from "../planning/architecture-obligation-contract.js"
import { deriveGoalContract } from "../runtime/goal-contract.js"
import type { RuntimeReplanDecisionOutcome } from "./runtime-replan-coordinator.js"

export type ProgressivePlanningBoardPhase =
    | "idle"
    | "preparing"
    | "running"
    | "verifying"
    | "pushing"
    | "done"

export interface ProgressivePlanningBoardSnapshot {
    phase: ProgressivePlanningBoardPhase
    prd: PrdFile | null
    graphVersion: number
    wave: { ordinal: number; storyIds: readonly string[] } | null
}

export interface ProgressivePlanningGraphAdmission {
    proposal: RuntimeReplanProposedData
    planningState: PrdProgressivePlanningState
    maxAddedStories: number
}

/**
 * Narrow authority bridge back to CollectiveBoard. The coordinator validates
 * and reconciles planner messages, while Board remains the sole event source,
 * durable PRD committer, graph decision authority, and scheduler.
 */
export interface ProgressivePlanningCoordinatorHost {
    snapshot(): ProgressivePlanningBoardSnapshot
    commitPrd(prd: PrdFile): void
    admitGraph(
        admission: ProgressivePlanningGraphAdmission,
    ): RuntimeReplanDecisionOutcome
    emit(event: SemanticEvent<unknown>): void
    afterAdmission(): void
    afterClose(): void
    terminate(reason: string): void
}

export interface ProgressivePlanningCoordinatorOptions {
    runId: string
    planningId?: string
    host: ProgressivePlanningCoordinatorHost
}

export type ProgressivePlanningScheduleLatch =
    | { status: "open"; nextOrdinal: number }
    | { status: "failed"; reason: string }
    | null

/** Planner-stream protocol state machine composed into CollectiveBoard. */
export class ProgressivePlanningCoordinator {
    constructor(private readonly opts: ProgressivePlanningCoordinatorOptions) {}

    initialize(prd: PrdFile): PrdFile {
        const planningId = this.opts.planningId
        if (!planningId) return prd
        if (!safeControlId(planningId)) {
            throw new Error("progressive planning id is malformed")
        }
        const existing = prd.runtimeGraph?.planning
        if (existing) {
            if (
                existing.runId !== this.opts.runId ||
                existing.planningId !== planningId
            ) {
                throw new Error(
                    "progressive planning state belongs to a different run or planning session",
                )
            }
            return prd
        }
        if (prd.userStories.length > 0) {
            throw new Error(
                "progressive planning requires an empty bootstrap PRD; use the existing full-plan path for a populated PRD",
            )
        }
        const planning: PrdProgressivePlanningState = {
            schemaVersion: 1,
            runId: this.opts.runId,
            planningId,
            status: "open",
            nextOrdinal: 1,
            admittedStoryIds: [],
            fragments: [],
        }
        const initialized: PrdFile = {
            ...prd,
            runtimeGraph: {
                runId: this.opts.runId,
                version: 1,
                dynamicStories: 0,
                policyStories: 0,
                appliedDecisions: [],
                planning,
                ...(prd.runtimeGraph?.protocol
                    ? {
                          protocol: {
                              schemaVersion: 1,
                              goal: structuredClone(
                                  prd.runtimeGraph.protocol.goal,
                              ),
                          },
                      }
                    : {}),
            },
        }
        this.opts.host.commitPrd(initialized)
        return initialized
    }

    handleEvent(event: SemanticEvent<unknown>): boolean {
        if (
            PlanningStreamOpened.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            this.onPlanningStreamOpened(event.data.planningId)
            return true
        }
        if (
            PlanFragmentProposed.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            this.onPlanFragmentProposed(event.data)
            return true
        }
        if (
            PlanningStreamCompleted.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            this.onPlanningStreamCompleted(event.data)
            return true
        }
        if (
            PlanningStreamFailed.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            this.onPlanningStreamFailed(event.data)
            return true
        }
        return false
    }

    scheduleLatch(): ProgressivePlanningScheduleLatch {
        const planning = this.opts.host.snapshot().prd?.runtimeGraph?.planning
        if (planning?.status === "open") {
            return { status: "open", nextOrdinal: planning.nextOrdinal }
        }
        if (planning?.status === "failed") {
            return {
                status: "failed",
                reason: planning.terminalReason ?? "planner stream failed",
            }
        }
        return null
    }

    isFailed(): boolean {
        return this.scheduleLatch()?.status === "failed"
    }

    private onPlanningStreamOpened(planningId: string): void {
        const state = this.opts.host.snapshot()
        const planning = state.prd?.runtimeGraph?.planning
        if (!planning) {
            this.rejectPlanFragment(
                { runId: this.opts.runId, planningId },
                "planning_not_open",
                "this run was not bootstrapped for progressive planning",
            )
            return
        }
        if (planning.planningId !== planningId) {
            this.rejectPlanFragment(
                { runId: this.opts.runId, planningId },
                "planning_id_mismatch",
                `planning session ${planningId || "(missing)"} does not match ${planning.planningId}`,
            )
            return
        }
        this.opts.host.emit(
            ConductorState.create({
                phase: "loading",
                detail:
                    `progressive planner stream ${planningId} is ${planning.status}; ` +
                    `next fragment is ${planning.nextOrdinal}`,
                currentLevel: state.wave?.ordinal,
                storyIds: state.wave?.storyIds,
            }),
        )
    }

    private onPlanFragmentProposed(fragment: PlanFragmentProposedData): void {
        const state = this.opts.host.snapshot()
        if (
            !state.prd ||
            (state.phase !== "preparing" && state.phase !== "running")
        ) {
            this.rejectPlanFragment(
                fragment,
                "planning_not_open",
                "the collective run is not accepting planner fragments",
            )
            return
        }
        const planning = state.prd.runtimeGraph?.planning
        if (!planning) {
            this.rejectPlanFragment(
                fragment,
                "planning_not_open",
                "the run has no progressive-planning latch",
            )
            return
        }
        if (fragment.planningId !== planning.planningId) {
            this.rejectPlanFragment(
                fragment,
                "planning_id_mismatch",
                `fragment session ${fragment.planningId || "(missing)"} does not match ${planning.planningId}`,
            )
            return
        }

        let validated
        let fingerprint: string
        try {
            const envelope = {
                schemaVersion: 1,
                planningSessionId: fragment.planningId,
                fragmentId: fragment.fragmentId,
                ordinal: fragment.ordinal,
                stories: fragment.stories,
            }
            validated = validateProgressivePlanFragment(envelope)
            const goalContract = deriveGoalContract(state.prd.goalEnvelope)
            validateGoalContractCoverage(
                goalContract,
                goalContractMappings(validated.stories),
                "partial",
            )
            const fragmentIds = new Set(validated.stories.map(({ id }) => id))
            validateArchitectureObligationCoverage(
                architectureObligationsFromDecision(
                    state.prd.decisionDocument,
                    goalContract,
                ),
                obligationMappingsForStories([
                    ...state.prd.userStories.filter(
                        ({ id }) => !fragmentIds.has(id),
                    ),
                    ...validated.stories,
                ]),
                "partial",
            )
            fingerprint = progressivePlanFragmentFingerprint(envelope)
        } catch (error) {
            this.rejectPlanFragment(fragment, "invalid_fragment", messageOf(error))
            return
        }

        const remembered = planning.fragments.find(
            (entry) => entry.fragmentId === validated.fragmentId,
        )
        if (remembered) {
            if (
                remembered.fingerprint !== fingerprint ||
                remembered.ordinal !== validated.ordinal
            ) {
                this.rejectPlanFragment(
                    fragment,
                    "fragment_id_conflict",
                    `fragment id ${validated.fragmentId} was already admitted with different content`,
                )
                return
            }
            this.opts.host.emit(
                PlanFragmentAdmitted.create({
                    runId: this.opts.runId,
                    planningId: planning.planningId,
                    fragmentId: remembered.fragmentId,
                    ordinal: remembered.ordinal,
                    graphVersion: remembered.graphVersion,
                    storyIds: [...remembered.storyIds],
                    replay: true,
                }),
            )
            return
        }
        if (planning.status !== "open") {
            this.rejectPlanFragment(
                fragment,
                "planning_not_open",
                `planning session is already ${planning.status}`,
            )
            return
        }
        if (validated.ordinal !== planning.nextOrdinal) {
            this.rejectPlanFragment(
                fragment,
                "ordinal_gap",
                `fragment ordinal ${validated.ordinal} does not match expected ${planning.nextOrdinal}`,
            )
            return
        }

        const predictedGraphVersion = state.graphVersion + 1
        const nextPlanning: PrdProgressivePlanningState = {
            ...planning,
            nextOrdinal: planning.nextOrdinal + 1,
            admittedStoryIds: [
                ...planning.admittedStoryIds,
                ...validated.stories.map((story) => story.id),
            ],
            fragments: [
                ...planning.fragments,
                {
                    fragmentId: validated.fragmentId,
                    ordinal: validated.ordinal,
                    fingerprint,
                    storyIds: validated.stories.map((story) => story.id),
                    graphVersion: predictedGraphVersion,
                },
            ],
        }
        const proposal: RuntimeReplanProposedData = {
            runId: this.opts.runId,
            proposalId: `${this.opts.runId}:planner:${fingerprint}`,
            sourceStoryId: `planner:${planning.planningId}`,
            leaseId: `${this.opts.runId}:planning:${planning.planningId}`,
            generation: validated.ordinal,
            baseGraphVersion: state.graphVersion,
            reason: `progressive planner admitted fragment ${validated.fragmentId}`,
            mutation: {
                addedStories: validated.stories.map((story) => ({
                    id: story.id,
                    priority: story.priority,
                    title: story.title,
                    description: story.description,
                    dependsOn: [...story.dependsOn],
                    retries: story.retries,
                    acceptance: [...story.acceptance],
                    tests: [...story.tests],
                    ...(story.goalInvariantIds
                        ? { goalInvariantIds: [...story.goalInvariantIds] }
                        : {}),
                    model: story.model,
                })),
                removedStoryIds: [],
                modifiedDeps: {},
            },
        }
        const maxPlannerStories = state.prd.executionMode?.maxStories ?? 128
        const outcome = this.opts.host.admitGraph({
            proposal,
            planningState: nextPlanning,
            maxAddedStories: Math.max(
                0,
                maxPlannerStories - planning.admittedStoryIds.length,
            ),
        })
        if (!outcome.applied || !RuntimeReplanApplied.is(outcome.event)) {
            this.opts.host.emit(outcome.event)
            this.rejectPlanFragment(
                fragment,
                "graph_rejected",
                RuntimeReplanRejected.is(outcome.event)
                    ? outcome.event.data.reason
                    : "planner fragment was not admitted",
            )
            return
        }

        this.opts.host.emit(outcome.event)
        this.opts.host.emit(
            PlanFragmentAdmitted.create({
                runId: this.opts.runId,
                planningId: planning.planningId,
                fragmentId: validated.fragmentId,
                ordinal: validated.ordinal,
                graphVersion: outcome.event.data.graphVersion,
                storyIds: [...outcome.applied.addedStoryIds],
                replay: false,
            }),
        )
        const current = this.opts.host.snapshot()
        this.opts.host.emit(
            ConductorState.create({
                phase: "running_level",
                detail:
                    `progressive planner admitted ${outcome.applied.addedStoryIds.join(", ")} ` +
                    `at graph v${outcome.event.data.graphVersion}`,
                currentLevel: current.wave?.ordinal,
                storyIds: current.wave?.storyIds,
            }),
        )
        this.opts.host.afterAdmission()
    }

    private onPlanningStreamCompleted(
        completion: PlanningStreamCompletedData,
    ): void {
        const state = this.opts.host.snapshot()
        if (!state.prd) return
        const planning = state.prd.runtimeGraph?.planning
        if (!planning || completion.planningId !== planning.planningId) {
            this.rejectPlanFragment(
                completion,
                planning ? "planning_id_mismatch" : "planning_not_open",
                planning
                    ? `completion session ${completion.planningId || "(missing)"} does not match ${planning.planningId}`
                    : "the run has no progressive-planning latch",
            )
            return
        }

        // Terminal state is monotonic. A failed stream ignores completion;
        // a completed stream only acknowledges an exact final-PRD replay.
        if (planning.status === "failed") return

        let finalStories: PrdStory[]
        try {
            const finalPrd = normalizePrd(
                completion.finalPrd as Partial<PrdFile>,
                "progressive planner final PRD",
            )
            if (!progressiveMetadataMatches(state.prd, finalPrd)) {
                throw new ProgressivePlanContractError(
                    "final_prd_mismatch",
                    "final PRD metadata differs from the bootstrap contract",
                )
            }
            const admittedStories = plannerStorySnapshots(
                state.prd,
                planning.admittedStoryIds,
            )
            finalStories = reconcileProgressivePlanStories(
                admittedStories,
                finalPrd,
            ).finalStories
            const goalContract = deriveGoalContract(state.prd.goalEnvelope)
            validateGoalContractCoverage(
                goalContract,
                goalContractMappings(finalStories),
                // Unknown claims are never admissible. Incomplete coverage is
                // intentionally allowed at this live boundary: closing the
                // planning latch lets GoalGuardian publish exact missing-
                // invariant remediation through the normal Mozaik DAG path.
                "partial",
            )
            validateArchitectureObligationCoverage(
                architectureObligationsFromDecision(
                    state.prd.decisionDocument,
                    goalContract,
                ),
                obligationMappingsForStories(finalStories),
                "complete",
            )
            if (
                planning.status === "completed" &&
                finalStories.length !== planning.admittedStoryIds.length
            ) {
                throw new ProgressivePlanContractError(
                    "final_prd_conflict",
                    "completed planning session received a different final story sequence",
                )
            }
        } catch (error) {
            if (planning.status === "completed") {
                this.rejectPlanFragment(
                    completion,
                    "final_plan_mismatch",
                    messageOf(error),
                )
            } else {
                this.failPlanning(planning, "invalid_final_plan", messageOf(error))
            }
            return
        }

        if (planning.status === "completed") {
            this.opts.host.emit(
                PlanningStreamClosed.create({
                    runId: this.opts.runId,
                    planningId: planning.planningId,
                    status: "completed",
                    graphVersion: state.graphVersion,
                }),
            )
            return
        }

        const tail = finalStories.slice(planning.admittedStoryIds.length)
        if (tail.length > 0) {
            const ordinal = planning.nextOrdinal
            this.onPlanFragmentProposed({
                runId: this.opts.runId,
                planningId: planning.planningId,
                fragmentId: `final-${progressiveFinalFingerprint(finalStories)}`,
                ordinal,
                stories: tail,
            })
            const afterAdmission =
                this.opts.host.snapshot().prd?.runtimeGraph?.planning
            if (!afterAdmission || afterAdmission.nextOrdinal !== ordinal + 1) {
                this.failPlanning(
                    afterAdmission ?? planning,
                    "final_tail_rejected",
                    "the final planner tail could not be durably admitted",
                )
                return
            }
        }
        const current = this.opts.host.snapshot().prd?.runtimeGraph?.planning
        if (!current || current.status !== "open") return
        this.closePlanning(current, "completed")
    }

    private onPlanningStreamFailed(failure: PlanningStreamFailedData): void {
        const state = this.opts.host.snapshot()
        const planning = state.prd?.runtimeGraph?.planning
        if (!planning || failure.planningId !== planning.planningId) {
            this.rejectPlanFragment(
                failure,
                planning ? "planning_id_mismatch" : "planning_not_open",
                "planner failure does not match the active planning session",
            )
            return
        }
        if (planning.status === "completed") return
        if (planning.status === "failed") {
            this.opts.host.emit(
                PlanningStreamClosed.create({
                    runId: this.opts.runId,
                    planningId: planning.planningId,
                    status: "failed",
                    graphVersion: state.graphVersion,
                    reason: planning.terminalReason,
                }),
            )
            return
        }
        this.failPlanning(planning, failure.code, failure.reason)
    }

    private failPlanning(
        planning: PrdProgressivePlanningState,
        code: string,
        reason: string,
    ): void {
        const safeCode = controlText(code, "planner_failed")
        const safeReason = controlText(reason, "planner stream failed")
        this.closePlanning(planning, "failed", `${safeCode}: ${safeReason}`)
    }

    private closePlanning(
        planning: PrdProgressivePlanningState,
        status: "completed" | "failed",
        reason?: string,
    ): void {
        const state = this.opts.host.snapshot()
        const current = state.prd?.runtimeGraph?.planning
        if (!state.prd?.runtimeGraph || !current || current.status !== "open") {
            return
        }
        if (
            current.runId !== planning.runId ||
            current.planningId !== planning.planningId
        ) {
            return
        }
        const nextPlanning: PrdProgressivePlanningState = {
            ...current,
            status,
            ...(status === "failed" && reason ? { terminalReason: reason } : {}),
        }
        const nextPrd: PrdFile = {
            ...state.prd,
            runtimeGraph: {
                ...state.prd.runtimeGraph,
                planning: nextPlanning,
            },
        }
        try {
            this.opts.host.commitPrd(nextPrd)
        } catch (error) {
            this.opts.host.terminate(
                `could not persist progressive planning terminal state: ${messageOf(error)}`,
            )
            return
        }
        this.opts.host.emit(
            PlanningStreamClosed.create({
                runId: this.opts.runId,
                planningId: planning.planningId,
                status,
                graphVersion: state.graphVersion,
                ...(reason ? { reason } : {}),
            }),
        )
        this.opts.host.afterClose()
    }

    private rejectPlanFragment(
        correlation: {
            runId: string
            planningId: string
            fragmentId?: string
            ordinal?: number
        },
        code: PlanFragmentRejectionCode,
        reason: string,
    ): void {
        this.opts.host.emit(
            PlanFragmentRejected.create({
                runId: correlation.runId,
                planningId: correlation.planningId,
                ...(correlation.fragmentId
                    ? { fragmentId: correlation.fragmentId }
                    : {}),
                ...(correlation.ordinal !== undefined
                    ? { ordinal: correlation.ordinal }
                    : {}),
                code,
                reason,
            }),
        )
    }
}

function messageOf(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}

function safeControlId(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
}

function controlText(value: string, fallback: string): string {
    if (typeof value !== "string") return fallback
    const normalized = value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 2_048)
    return normalized || fallback
}

function plannerStorySnapshots(
    prd: PrdFile,
    storyIds: readonly string[],
): PrdStory[] {
    const byId = new Map(prd.userStories.map((story) => [story.id, story]))
    return storyIds.map((storyId) => {
        const story = byId.get(storyId)
        if (!story) {
            throw new Error(
                `admitted planner story ${storyId} is missing from the runtime graph`,
            )
        }
        return {
            ...structuredClone(story),
            passes: false,
            completedAt: null,
            durationSecs: null,
        }
    })
}

function progressiveMetadataMatches(current: PrdFile, finalPrd: PrdFile): boolean {
    const metadata = (prd: PrdFile) => ({
        project: prd.project,
        branchName: prd.branchName,
        description: prd.description,
        conversationSessionId: prd.conversationSessionId,
        goalEnvelope: prd.goalEnvelope,
        decisionDocument: prd.decisionDocument,
        executionMode: prd.executionMode,
    })
    return isDeepStrictEqual(metadata(current), metadata(finalPrd))
}

function progressiveFinalFingerprint(stories: readonly PrdStory[]): string {
    return createHash("sha256")
        .update(JSON.stringify(stories), "utf8")
        .digest("hex")
}

function goalContractMappings(stories: readonly PrdStory[]) {
    return stories.map((story) => ({
        storyId: story.id,
        invariantIds: story.goalInvariantIds ?? [],
    }))
}
