/**
 * Private planner-process protocol for the opt-in progressive collective.
 *
 * This module is deliberately provider-free. It owns CLI flag correlation,
 * lifecycle wire records, and the trusted bootstrap metadata projection; the
 * Planner backends only decide whether they can publish provisional stories.
 */

import { writeFileSync, writeSync } from "node:fs"

import { normalizePrd, type PrdExecutionMode, type PrdFile } from "../prd.js"
import {
    assertCorrelationId,
    type GoalEnvelope,
    validateGoalEnvelope,
} from "../session/conversation-contract.js"
import type { BaroCommand } from "../tui-protocol.js"
import {
    openProgressivePlanSession,
    type ProgressivePlanSession,
} from "./progressive-plan.js"

export type PlanningOpenWireEvent = Extract<
    BaroCommand,
    { type: "planning_open" }
>
export type PlanFragmentWireEvent = Extract<
    BaroCommand,
    { type: "plan_fragment" }
>
export type PlanCompleteWireEvent = Extract<
    BaroCommand,
    { type: "plan_complete" }
>
export type PlanFailedWireEvent = Extract<
    BaroCommand,
    { type: "plan_failed" }
>
export type ProgressivePlannerWireEvent =
    | PlanningOpenWireEvent
    | PlanFragmentWireEvent
    | PlanCompleteWireEvent
    | PlanFailedWireEvent

export interface ProgressivePlannerFlagInput {
    progressiveRunId?: string
    progressivePlanningId?: string
    progressiveBootstrapFile?: string
    resultFile?: string
}

export interface ProgressivePlannerConfig {
    runId: string
    planningId: string
    bootstrapFile: string
}

/**
 * Resolve the all-or-nothing private flag group. A partial group is never
 * interpreted as a legacy run, and stdout must already be freed by a result
 * file before lifecycle records can be published.
 */
export function resolveProgressivePlannerConfig(
    input: ProgressivePlannerFlagInput,
): ProgressivePlannerConfig | undefined {
    const supplied = [
        input.progressiveRunId,
        input.progressivePlanningId,
        input.progressiveBootstrapFile,
    ].some((value) => value !== undefined)
    if (!supplied) return undefined

    const runId = requiredFlagValue(
        input.progressiveRunId,
        "--progressive-run-id",
    )
    const planningId = requiredFlagValue(
        input.progressivePlanningId,
        "--progressive-planning-id",
    )
    const bootstrapFile = requiredFlagValue(
        input.progressiveBootstrapFile,
        "--progressive-bootstrap-file",
    )
    if (typeof input.resultFile !== "string" || !input.resultFile.trim()) {
        throw new Error(
            "progressive planning requires --result-file so stdout remains the event stream",
        )
    }
    return { runId, planningId, bootstrapFile }
}

function requiredFlagValue(value: string | undefined, flag: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(
            `${flag} is required when any progressive-planning flag is set`,
        )
    }
    return value.trim()
}

export type ProgressivePlannerWireSink = (
    event: ProgressivePlannerWireEvent,
) => void

/**
 * Exactly one correlated writer for one planner process. `fail` is best-effort
 * and idempotent so nested error boundaries cannot duplicate plan_failed.
 */
export class ProgressivePlannerLifecycle {
    private opened = false
    private completePublished = false
    private failedPublished = false
    private readonly planSession: ProgressivePlanSession

    constructor(
        readonly config: ProgressivePlannerConfig,
        private readonly sink: ProgressivePlannerWireSink = writeWireEvent,
    ) {
        this.planSession = openProgressivePlanSession({
            schemaVersion: 1,
            planningSessionId: config.planningId,
        })
    }

    open(): void {
        if (this.opened) return
        this.sink({
            type: "planning_open",
            run_id: this.config.runId,
            planning_id: this.config.planningId,
        })
        this.opened = true
    }

    /** Accept the provider's direct snake_case fragment wire record. */
    publish(event: unknown): void {
        if (!this.opened) {
            throw new Error("progressive planning must open before publishing a fragment")
        }
        if (this.completePublished || this.failedPublished) {
            throw new Error("progressive planning stream is already closed")
        }
        const fragment = validateFragmentWireEvent(event, this.config)
        // This provider-independent copy of the contract remains open through
        // post-processing. Native planners validate too, but mode enforcement
        // runs later and CLI planners may gain fragment support independently.
        this.planSession.admit({
            schemaVersion: 1,
            planningSessionId: fragment.planning_id,
            fragmentId: fragment.fragment_id,
            ordinal: fragment.ordinal,
            stories: fragment.stories,
        })
        this.sink(fragment)
    }

    validateFinalCandidate(finalPrd: unknown): void {
        if (!this.opened) {
            throw new Error("progressive planning must open before final validation")
        }
        if (this.failedPublished) {
            throw new Error("progressive planning stream is already failed")
        }
        // Planner JSON intentionally omits execution-owned fields
        // (passes/completedAt/durationSecs). Reconcile the same canonical
        // projection the Board loads, otherwise every real provider fragment
        // would succeed in-adapter and then fail again at result persistence.
        this.planSession.reconcile(
            normalizePrd(
                finalPrd as Partial<PrdFile>,
                "progressive planner final candidate",
            ),
        )
    }

    complete(finalPrd: unknown): void {
        if (!this.opened) {
            throw new Error("progressive planning must open before completion")
        }
        if (this.failedPublished) return
        // Reconcile the actual persisted candidate, after mode enforcement and
        // trusted bootstrap stamping. This is the last point at which a
        // post-processor could have removed or mutated an admitted prefix.
        this.validateFinalCandidate(finalPrd)
        if (this.completePublished) return
        this.sink({
            type: "plan_complete",
            run_id: this.config.runId,
            planning_id: this.config.planningId,
            final_prd: finalPrd,
        })
        this.completePublished = true
    }

    fail(code: string, reason: string): void {
        if (!this.opened || this.completePublished || this.failedPublished) return
        const event: PlanFailedWireEvent = {
            type: "plan_failed",
            run_id: this.config.runId,
            planning_id: this.config.planningId,
            code: safeFailureText(code, "planner_failed"),
            reason: safeFailureText(reason, "planner failed without a reason"),
        }
        this.failedPublished = true
        this.sink(event)
    }
}

export type ProgressivePlannerResultWriter = (
    path: string,
    contents: string,
) => void

/**
 * The Rust host treats a successful result file as the Planner's authoritative
 * completion. Persist it first; only then may the live stream announce the
 * same decoded PRD to the collective.
 */
export function persistProgressivePlannerResult(
    resultFile: string,
    prdJson: string,
    lifecycle: ProgressivePlannerLifecycle,
    writeResult: ProgressivePlannerResultWriter = (path, contents) =>
        writeFileSync(path, contents),
): void {
    const finalPrd = JSON.parse(prdJson) as unknown
    lifecycle.validateFinalCandidate(finalPrd)
    writeResult(resultFile, prdJson)
    lifecycle.complete(finalPrd)
}

function validateFragmentWireEvent(
    value: unknown,
    expected: ProgressivePlannerConfig,
): PlanFragmentWireEvent {
    if (!isPlainRecord(value) || value.type !== "plan_fragment") {
        throw new Error("progressive publisher emitted a non-fragment record")
    }
    if (
        value.run_id !== expected.runId ||
        value.planning_id !== expected.planningId
    ) {
        throw new Error("progressive fragment correlation mismatch")
    }
    const fragmentId = nonBlank(value.fragment_id, "progressive fragment_id")
    if (!Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 1) {
        throw new Error("progressive fragment ordinal must be a positive safe integer")
    }
    if (!Array.isArray(value.stories) || value.stories.length === 0) {
        throw new Error("progressive fragment stories must be a non-empty array")
    }
    return {
        type: "plan_fragment",
        run_id: expected.runId,
        planning_id: expected.planningId,
        fragment_id: fragmentId,
        ordinal: Number(value.ordinal),
        stories: structuredClone(value.stories),
    }
}

function writeWireEvent(event: ProgressivePlannerWireEvent): void {
    // Failure paths may terminate immediately after publishing. A synchronous
    // fd write guarantees the private lifecycle record reached the pipe first.
    writeSync(process.stdout.fd, JSON.stringify(event) + "\n")
}

export interface ProgressiveBootstrapMetadata {
    project: string
    branchName: string
    description: string
    decisionDocument?: string
    executionMode?: PrdExecutionMode
    conversationSessionId?: string
    goalEnvelope?: GoalEnvelope
}

/** Strictly validate and canonicalize only run-owned bootstrap metadata. */
export function parseProgressiveBootstrapMetadata(
    raw: string,
    source = "progressive bootstrap",
): ProgressiveBootstrapMetadata {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch (error) {
        throw new Error(`${source} is not valid JSON: ${messageOf(error)}`)
    }
    if (!isPlainRecord(value)) {
        throw new Error(`${source} must be a JSON object`)
    }
    nonBlank(value.project, `${source} project`)
    nonBlank(value.branchName, `${source} branchName`)
    nonBlank(value.description, `${source} description`)
    validateOptionalDecisionDocument(value.decisionDocument, source)
    validateOptionalExecutionMode(value.executionMode, source)
    if (value.conversationSessionId !== undefined) {
        assertCorrelationId(
            value.conversationSessionId,
            `${source} conversationSessionId`,
        )
    }
    if (value.goalEnvelope !== undefined) {
        validateGoalEnvelope(value.goalEnvelope)
    }

    // Use the same canonicalization as the Board's loadPrd() boundary (most
    // notably the doubled `baro/baro/` branch repair and conversation schema).
    const normalized = normalizePrd(
        { ...(value as Partial<PrdFile>), userStories: [] },
        source,
    )
    return metadataOf(normalized)
}

/**
 * Replace every planner-controlled run-level field with the trusted bootstrap
 * projection. Stories remain provider output; absent optional bootstrap fields
 * remove any value the provider tried to manufacture.
 */
export function applyProgressiveBootstrapMetadata(
    finalPrdJson: string,
    bootstrap: ProgressiveBootstrapMetadata,
): string {
    const parsed = JSON.parse(finalPrdJson) as unknown
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.userStories)) {
        throw new Error("final PRD must be an object with a userStories array")
    }
    const result: Record<string, unknown> = { ...parsed }
    result.project = bootstrap.project
    result.branchName = bootstrap.branchName
    result.description = bootstrap.description
    overwriteOptional(result, "decisionDocument", bootstrap.decisionDocument)
    overwriteOptional(result, "executionMode", bootstrap.executionMode)
    overwriteOptional(
        result,
        "conversationSessionId",
        bootstrap.conversationSessionId,
    )
    overwriteOptional(result, "goalEnvelope", bootstrap.goalEnvelope)
    // Runtime graph state belongs to the live Board, never to provider output.
    delete result.runtimeGraph
    return JSON.stringify(result)
}

function metadataOf(prd: PrdFile): ProgressiveBootstrapMetadata {
    return {
        project: prd.project,
        branchName: prd.branchName,
        description: prd.description,
        ...(prd.decisionDocument === undefined
            ? {}
            : { decisionDocument: prd.decisionDocument }),
        ...(prd.executionMode === undefined
            ? {}
            : { executionMode: structuredClone(prd.executionMode) }),
        ...(prd.conversationSessionId === undefined
            ? {}
            : { conversationSessionId: prd.conversationSessionId }),
        ...(prd.goalEnvelope === undefined
            ? {}
            : { goalEnvelope: structuredClone(prd.goalEnvelope) }),
    }
}

function validateOptionalDecisionDocument(value: unknown, source: string): void {
    if (value !== undefined) nonBlank(value, `${source} decisionDocument`)
}

function validateOptionalExecutionMode(value: unknown, source: string): void {
    if (value === undefined) return
    if (!isPlainRecord(value)) {
        throw new Error(`${source} executionMode must be an object`)
    }
    if (
        value.mode !== "focused" &&
        value.mode !== "sequential" &&
        value.mode !== "parallel"
    ) {
        throw new Error(`${source} executionMode mode is invalid`)
    }
    nonBlank(value.reason, `${source} executionMode reason`)
    if (
        value.confidence !== undefined &&
        (typeof value.confidence !== "number" ||
            !Number.isFinite(value.confidence) ||
            value.confidence < 0 ||
            value.confidence > 1)
    ) {
        throw new Error(`${source} executionMode confidence must be between 0 and 1`)
    }
    for (const field of ["maxStories", "parallelism"] as const) {
        const candidate = value[field]
        if (
            candidate !== undefined &&
            (!Number.isSafeInteger(candidate) || Number(candidate) < 1)
        ) {
            throw new Error(`${source} executionMode ${field} must be a positive integer`)
        }
    }
    if (value.source !== undefined) {
        nonBlank(value.source, `${source} executionMode source`)
    }
}

function overwriteOptional(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
): void {
    if (value === undefined) delete target[key]
    else target[key] = structuredClone(value)
}

function nonBlank(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} must be a non-empty string`)
    }
    return value.trim()
}

function safeFailureText(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
