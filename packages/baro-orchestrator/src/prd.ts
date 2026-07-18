/**
 * PRD types and persistence. CONSTRAINT: must stay compatible with the
 * `prd.json` schema the planner produces (shared with the Rust side).
 */

import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"

import type {
    GoalCompletionAttestedData,
    ReplanData,
    ReplanStoryAdd,
    RuntimeReplanAppliedData,
} from "./semantic-events.js"
import { runtimeDecisionFingerprintMatches } from "./runtime/runtime-replan-fingerprint.js"
import {
    deriveGoalContract,
    normalizeGoalLedgerProjection,
    type GoalContract,
    type GoalLedgerProjection,
} from "./runtime/goal-contract.js"
import {
    assertCorrelationId,
    type GoalEnvelope,
    validateGoalEnvelope,
} from "./session/conversation-contract.js"

export interface PrdStory {
    id: string
    priority: number
    title: string
    description: string
    dependsOn: string[]
    retries: number
    acceptance: string[]
    tests: string[]
    /** Stable GoalContract invariant ids this work item is expected to
     * provide evidence for. Optional only for pre-governance PRDs. */
    goalInvariantIds?: string[]
    passes: boolean
    completedAt: string | null
    durationSecs: number | null
    model?: string
}

/** Intake's (or the user's) execution-mode decision, stamped by run-planner. */
export interface PrdExecutionMode {
    mode: "focused" | "sequential" | "parallel"
    reason: string
    confidence?: number
    maxStories?: number
    parallelism?: number
    /** "user" (explicit pick) | "llm" (intake) | "heuristic" (fallback). */
    source?: string
}

export interface PrdFile {
    project: string
    branchName: string
    description: string
    userStories: PrdStory[]
    /** Durable identity of the conversation that authorized this plan. */
    conversationSessionId?: string
    /** Provider-neutral user intent handed from conversation intake to planning. */
    goalEnvelope?: GoalEnvelope
    /**
     * Architect's DecisionDocument (file paths, schema shapes, naming).
     * Conductor prepends it verbatim to every story prompt so agents never
     * re-decide things upstream already pinned down.
     */
    decisionDocument?: string
    executionMode?: PrdExecutionMode
    /** Durable collective control-plane metadata. Planners may omit it. */
    runtimeGraph?: PrdRuntimeGraphState
}

export interface PrdRuntimeReplanDecision {
    fingerprint: string
    applied: RuntimeReplanAppliedData
}

export interface PrdRuntimeGraphState {
    runId: string
    version: number
    /** Worker-proposed stories charged against maxDynamicStories. */
    dynamicStories: number
    /** Board/Surgeon recovery stories committed at safe wave boundaries. */
    policyStories: number
    appliedDecisions: PrdRuntimeReplanDecision[]
    /** Present only for the opt-in collective progressive-planning lane. */
    planning?: PrdProgressivePlanningState
    /** Guardian-owned semantic evidence persisted by the serialized Board. */
    protocol?: PrdCollectiveProtocolState
}

export interface PrdCollectiveProtocolState {
    schemaVersion: 1
    goal: GoalLedgerProjection
    /** Last correlated completion decision; cleared whenever the ledger advances. */
    completion?: GoalCompletionAttestedData
}

export interface PrdPlanningFragmentDecision {
    fragmentId: string
    ordinal: number
    fingerprint: string
    storyIds: string[]
    graphVersion: number
}

/** Durable planner-stream latch and idempotency ledger. It lives beside the
 * runtime graph so fragment admission and graph-version advancement can cross
 * one atomic persistence boundary. */
export interface PrdProgressivePlanningState {
    schemaVersion: 1
    runId: string
    planningId: string
    status: "open" | "completed" | "failed"
    nextOrdinal: number
    admittedStoryIds: string[]
    fragments: PrdPlanningFragmentDecision[]
    terminalReason?: string
}

const STORY_DEFAULTS: Pick<PrdStory, "retries"> = { retries: 2 }
/** Hard cost/liveness ceiling at every PRD and runtime-replan boundary. */
export const MAX_STORY_RETRIES = 5
export const MIN_STORY_PRIORITY = -2_147_483_648
export const MAX_STORY_PRIORITY = 2_147_483_647

export function loadPrd(path: string): PrdFile {
    const raw = readFileSync(path, "utf8")
    const json = JSON.parse(raw) as Partial<PrdFile>
    return normalizePrd(json, path)
}

export function savePrd(path: string, prd: PrdFile): void {
    writeFileSync(path, JSON.stringify(prd, null, 2) + "\n")
}

/**
 * Persist a complete PRD snapshot with atomic path replacement. Runtime graph
 * transactions use this so a process never observes `Applied` after a partial
 * truncate/write. The temporary file is removed on every failed path.
 */
export function savePrdAtomic(path: string, prd: PrdFile): void {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
        writeFileSync(temporary, JSON.stringify(prd, null, 2) + "\n", {
            flag: "wx",
        })
        renameSync(temporary, path)
    } catch (error) {
        try {
            unlinkSync(temporary)
        } catch {}
        throw error
    }
}

export function normalizePrd(input: Partial<PrdFile>, source: string): PrdFile {
    if (!input || typeof input !== "object") {
        throw new Error(`PRD at ${source} is not a JSON object`)
    }
    const project = typeof input.project === "string" ? input.project : ""
    // Strip a doubled "baro/baro/…" prefix HERE, not just in
    // createOrCheckoutBranch: the Finalizer opens the PR from prd.branchName
    // verbatim, and a doubled (empty) head makes `gh pr create` fail with
    // "No commits between…". One canonical name → checkout, push, PR agree.
    let branchName = typeof input.branchName === "string" ? input.branchName : ""
    while (branchName.startsWith("baro/baro/")) branchName = branchName.slice("baro/".length)
    const description = typeof input.description === "string" ? input.description : ""
    const stories = Array.isArray(input.userStories) ? input.userStories : []
    const decisionDocument =
        typeof input.decisionDocument === "string" && input.decisionDocument.trim().length > 0
            ? input.decisionDocument
            : undefined
    const executionMode =
        input.executionMode && typeof input.executionMode === "object" && typeof input.executionMode.mode === "string"
            ? input.executionMode
            : undefined
    const conversationMetadata = normalizeConversationMetadata(input, source)
    const goalContract = deriveGoalContract(conversationMetadata.goalEnvelope)
    const runtimeGraph = normalizeRuntimeGraph(
        input.runtimeGraph,
        source,
        goalContract,
    )
    const userStories = stories.map((s, i) => normalizeStory(s, i, source))
    // Pre-governance focused PRDs had a GoalEnvelope but no explicit coverage
    // map. One story necessarily owns the whole focused goal, so this exact
    // migration is unambiguous. Multi-story plans fail closed at attestation
    // instead of guessing which agent owned a global invariant.
    if (
        conversationMetadata.goalEnvelope &&
        userStories.length === 1 &&
        userStories[0]?.goalInvariantIds === undefined
    ) {
        userStories[0].goalInvariantIds = deriveGoalContract(
            conversationMetadata.goalEnvelope,
        )!.invariants.map(({ id }) => id)
    }
    return {
        project,
        branchName,
        description,
        userStories,
        ...conversationMetadata,
        decisionDocument,
        executionMode,
        ...(runtimeGraph ? { runtimeGraph } : {}),
    }
}

function normalizeConversationMetadata(
    input: Partial<PrdFile>,
    source: string,
): Pick<PrdFile, "conversationSessionId" | "goalEnvelope"> {
    try {
        if (input.conversationSessionId !== undefined) {
            assertCorrelationId(
                input.conversationSessionId,
                "conversationSessionId",
            )
        }
        const goalEnvelope =
            input.goalEnvelope === undefined
                ? undefined
                : validateGoalEnvelope(input.goalEnvelope)
        return {
            ...(input.conversationSessionId !== undefined
                ? { conversationSessionId: input.conversationSessionId }
                : {}),
            ...(goalEnvelope ? { goalEnvelope } : {}),
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(
            `PRD at ${source} has invalid conversation metadata: ${reason}`,
        )
    }
}

function normalizeRuntimeGraph(
    value: unknown,
    source: string,
    goalContract: GoalContract | null,
): PrdRuntimeGraphState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const graph = value as Partial<PrdRuntimeGraphState>
    const malformed =
        typeof graph.runId !== "string" ||
        !Number.isSafeInteger(graph.version) ||
        Number(graph.version) < 1 ||
        !Number.isSafeInteger(graph.dynamicStories) ||
        Number(graph.dynamicStories) < 0 ||
        (graph.policyStories !== undefined &&
            (!Number.isSafeInteger(graph.policyStories) ||
                Number(graph.policyStories) < 0)) ||
        !Array.isArray(graph.appliedDecisions)
    if (malformed) {
        // A protocol snapshot may contain an open challenge. Silently dropping
        // it because an outer graph counter was corrupted could turn a resume
        // green, so protocol-bearing state always fails closed.
        if (graph.protocol !== undefined) {
            throw new Error(
                `PRD at ${source} has malformed runtime graph containing collective protocol state`,
            )
        }
        return undefined
    }
    const runId = graph.runId as string
    const decisions = graph.appliedDecisions as PrdRuntimeReplanDecision[]
    const validDecisions = decisions
        .filter((decision) =>
            validRuntimeDecision(
                decision,
                runId,
                Number(graph.version),
            ),
        )
    const proposalCounts = new Map<string, number>()
    for (const decision of validDecisions) {
        const proposalId = decision.applied.proposalId
        proposalCounts.set(proposalId, (proposalCounts.get(proposalId) ?? 0) + 1)
    }
    const appliedDecisions = validDecisions
        .filter(
            (decision) =>
                proposalCounts.get(decision.applied.proposalId) === 1,
        )
        .slice(-32)
        .map((decision) => structuredClone(decision))
    const planning = normalizeProgressivePlanning(
        graph.planning,
        runId,
        Number(graph.version),
        source,
    )
    const protocol = normalizeCollectiveProtocol(
        graph.protocol,
        runId,
        goalContract,
        source,
    )
    return {
        runId,
        version: Number(graph.version),
        dynamicStories: Number(graph.dynamicStories),
        // Backwards compatible with durable state written before recovery
        // adaptations had their own accounting lane.
        policyStories: Number(graph.policyStories ?? 0),
        appliedDecisions,
        ...(planning ? { planning } : {}),
        ...(protocol ? { protocol } : {}),
    }
}

function normalizeCollectiveProtocol(
    value: unknown,
    runtimeRunId: string,
    goalContract: GoalContract | null,
    source: string,
): PrdCollectiveProtocolState | undefined {
    if (value === undefined) return undefined
    if (!plainRecord(value) || value.schemaVersion !== 1 || !goalContract) {
        throw new Error(`PRD at ${source} has malformed collective protocol state`)
    }
    let goal: GoalLedgerProjection
    try {
        goal = normalizeGoalLedgerProjection(value.goal, goalContract)
    } catch (error) {
        throw new Error(
            `PRD at ${source} has malformed collective protocol state: ${messageOf(error)}`,
        )
    }
    const completion = value.completion === undefined
        ? undefined
        : normalizeGoalCompletion(
              value.completion,
              runtimeRunId,
              goal.contractId,
              goal.revision,
              source,
          )
    return {
        schemaVersion: 1,
        goal,
        ...(completion ? { completion } : {}),
    }
}

function normalizeGoalCompletion(
    value: unknown,
    runtimeRunId: string,
    contractId: string,
    goalRevision: number,
    source: string,
): GoalCompletionAttestedData {
    if (!plainRecord(value)) {
        throw new Error(`PRD at ${source} has malformed goal completion evidence`)
    }
    const validStatus =
        value.status === "satisfied" || value.status === "incomplete"
    if (
        value.runId !== runtimeRunId ||
        !nonBlank(value.checkId) ||
        value.contractId !== contractId ||
        value.goalRevision !== goalRevision ||
        !nonBlank(value.verificationId) ||
        !validStatus ||
        !stringArrayValue(value.satisfiedInvariantIds) ||
        !stringArrayValue(value.openInvariantIds) ||
        !stringArrayValue(value.rejectedInvariantIds) ||
        !Array.isArray(value.invariants) ||
        !nonBlank(value.reason)
    ) {
        throw new Error(`PRD at ${source} has malformed goal completion evidence`)
    }
    const invariants = value.invariants.map((item) => {
        if (
            !plainRecord(item) ||
            !nonBlank(item.invariantId) ||
            (item.status !== "satisfied" &&
                item.status !== "open" &&
                item.status !== "rejected") ||
            !stringArrayValue(item.mappedStoryIds) ||
            !stringArrayValue(item.integratedStoryIds) ||
            !stringArrayValue(item.independentlyReviewedStoryIds) ||
            (item.aggregateReviewId !== undefined &&
                !nonBlank(item.aggregateReviewId)) ||
            (item.aggregateReviewStatus !== undefined &&
                item.aggregateReviewStatus !== "passed" &&
                item.aggregateReviewStatus !== "failed" &&
                item.aggregateReviewStatus !== "inconclusive") ||
            !nonBlank(item.reason)
        ) {
            throw new Error(`PRD at ${source} has malformed goal completion evidence`)
        }
        return {
            invariantId: item.invariantId,
            status: item.status,
            mappedStoryIds: [...item.mappedStoryIds],
            integratedStoryIds: [...item.integratedStoryIds],
            independentlyReviewedStoryIds: [
                ...item.independentlyReviewedStoryIds,
            ],
            ...(item.aggregateReviewId
                ? { aggregateReviewId: item.aggregateReviewId }
                : {}),
            ...(item.aggregateReviewStatus
                ? { aggregateReviewStatus: item.aggregateReviewStatus }
                : {}),
            reason: item.reason,
        }
    })
    return structuredClone({
        runId: runtimeRunId,
        checkId: value.checkId,
        contractId,
        goalRevision,
        verificationId: value.verificationId,
        status: value.status,
        satisfiedInvariantIds: [...value.satisfiedInvariantIds],
        openInvariantIds: [...value.openInvariantIds],
        rejectedInvariantIds: [...value.rejectedInvariantIds],
        invariants,
        reason: value.reason,
    } as GoalCompletionAttestedData)
}

function normalizeProgressivePlanning(
    value: unknown,
    runtimeRunId: string,
    graphVersion: number,
    source: string,
): PrdProgressivePlanningState | undefined {
    if (value === undefined) return undefined
    if (!plainRecord(value)) {
        throw new Error(`PRD at ${source} has malformed progressive planning state`)
    }
    const state = value as Partial<PrdProgressivePlanningState>
    const validStatus =
        state.status === "open" ||
        state.status === "completed" ||
        state.status === "failed"
    if (
        state.schemaVersion !== 1 ||
        state.runId !== runtimeRunId ||
        !nonBlank(state.planningId) ||
        !validStatus ||
        !safeIntegerAtLeast(state.nextOrdinal, 0) ||
        !stringArrayValue(state.admittedStoryIds) ||
        !Array.isArray(state.fragments) ||
        state.fragments.length > 128 ||
        (state.status === "failed" && !nonBlank(state.terminalReason)) ||
        (state.status !== "failed" && state.terminalReason !== undefined)
    ) {
        throw new Error(`PRD at ${source} has malformed progressive planning state`)
    }
    const admittedIds = state.admittedStoryIds!
    if (new Set(admittedIds).size !== admittedIds.length) {
        throw new Error(`PRD at ${source} has duplicate progressive story ids`)
    }
    const fragments: PrdPlanningFragmentDecision[] = []
    const fragmentIds = new Set<string>()
    const ledgerStoryIds: string[] = []
    for (let index = 0; index < state.fragments.length; index += 1) {
        const fragment = state.fragments[index]
        if (
            !plainRecord(fragment) ||
            !nonBlank(fragment.fragmentId) ||
            fragmentIds.has(fragment.fragmentId) ||
        fragment.ordinal !== index + 1 ||
            !nonBlank(fragment.fingerprint) ||
            !stringArrayValue(fragment.storyIds) ||
            fragment.storyIds.length === 0 ||
            new Set(fragment.storyIds).size !== fragment.storyIds.length ||
            !safeIntegerAtLeast(fragment.graphVersion, 2) ||
            Number(fragment.graphVersion) > graphVersion
        ) {
            throw new Error(`PRD at ${source} has malformed progressive fragment ledger`)
        }
        fragmentIds.add(fragment.fragmentId)
        ledgerStoryIds.push(...fragment.storyIds)
        fragments.push(structuredClone(fragment as PrdPlanningFragmentDecision))
    }
    if (
        Number(state.nextOrdinal) !== fragments.length + 1 ||
        new Set(ledgerStoryIds).size !== ledgerStoryIds.length ||
        ledgerStoryIds.length !== admittedIds.length ||
        ledgerStoryIds.some((id, index) => id !== admittedIds[index])
    ) {
        throw new Error(`PRD at ${source} has inconsistent progressive planning ledger`)
    }
    return {
        schemaVersion: 1,
        runId: runtimeRunId,
        planningId: state.planningId!,
        status: state.status!,
        nextOrdinal: Number(state.nextOrdinal),
        admittedStoryIds: [...admittedIds],
        fragments,
        ...(state.terminalReason ? { terminalReason: state.terminalReason } : {}),
    }
}

function validRuntimeDecision(
    value: unknown,
    durableRunId: string,
    durableVersion: number,
): value is PrdRuntimeReplanDecision {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const decision = value as Partial<PrdRuntimeReplanDecision>
    const applied = decision.applied as Partial<RuntimeReplanAppliedData> | undefined
    return (
        typeof decision.fingerprint === "string" &&
        decision.fingerprint.length > 0 &&
        !!applied &&
        applied.runId === durableRunId &&
        nonBlank(applied.proposalId) &&
        nonBlank(applied.sourceStoryId) &&
        nonBlank(applied.leaseId) &&
        safeIntegerAtLeast(applied.generation, 0) &&
        safeIntegerAtLeast(applied.baseGraphVersion, 1) &&
        applied.baseGraphVersion === applied.previousGraphVersion &&
        applied.graphVersion === Number(applied.previousGraphVersion) + 1 &&
        Number(applied.graphVersion) <= durableVersion &&
        (applied.currentGraphVersion === undefined ||
            (safeIntegerAtLeast(applied.currentGraphVersion, applied.graphVersion!) &&
                Number(applied.currentGraphVersion) <= durableVersion)) &&
        nonBlank(applied.reason) &&
        validStoredRuntimeMutation(applied.mutation) &&
        runtimeDecisionFingerprintMatches(
            decision as PrdRuntimeReplanDecision,
        )
    )
}

function validStoredRuntimeMutation(value: unknown): boolean {
    if (!plainRecord(value)) return false
    if (!onlyKeys(value, ["addedStories", "removedStoryIds", "modifiedDeps"])) {
        return false
    }
    if (
        !Array.isArray(value.addedStories) ||
        !value.addedStories.every(validStoredRuntimeStory) ||
        !stringArrayValue(value.removedStoryIds) ||
        !plainRecord(value.modifiedDeps) ||
        !Object.values(value.modifiedDeps).every(stringArrayValue)
    ) return false
    return true
}

function validStoredRuntimeStory(value: unknown): boolean {
    if (!plainRecord(value)) return false
    if (
        !onlyKeys(value, [
            "id",
            "priority",
            "title",
            "description",
            "dependsOn",
            "retries",
            "acceptance",
            "tests",
            "goalInvariantIds",
            "model",
        ])
    ) return false
    return (
        nonBlank(value.id) &&
        typeof value.priority === "number" &&
        Number.isFinite(value.priority) &&
        nonBlank(value.title) &&
        nonBlank(value.description) &&
        stringArrayValue(value.dependsOn) &&
        (value.retries === undefined ||
            (safeIntegerAtLeast(value.retries, 0) &&
                Number(value.retries) <= MAX_STORY_RETRIES)) &&
        (value.acceptance === undefined || stringArrayValue(value.acceptance)) &&
        (value.tests === undefined || stringArrayValue(value.tests)) &&
        (value.goalInvariantIds === undefined ||
            (stringArrayValue(value.goalInvariantIds) &&
                value.goalInvariantIds.every((id) => /^G-[AC][1-9]\d*$/.test(id)))) &&
        (value.model === undefined || nonBlank(value.model))
    )
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function safeIntegerAtLeast(value: unknown, minimum: number): boolean {
    return Number.isSafeInteger(value) && Number(value) >= minimum
}

function nonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function stringArrayValue(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

function onlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const keys = new Set(allowed)
    return Object.keys(value).every((key) => keys.has(key))
}

function normalizeStory(
    input: Partial<PrdStory>,
    index: number,
    source: string,
): PrdStory {
    if (!input || typeof input !== "object") {
        throw new Error(`PRD story ${index} in ${source} is not an object`)
    }
    const id = typeof input.id === "string" ? input.id : `S${index + 1}`
    const priority =
        typeof input.priority === "number" && Number.isFinite(input.priority)
            ? Math.min(
                  MAX_STORY_PRIORITY,
                  Math.max(MIN_STORY_PRIORITY, Math.trunc(input.priority)),
              )
            : 0
    const title = typeof input.title === "string" ? input.title : ""
    const description =
        typeof input.description === "string" ? input.description : ""
    const dependsOn = Array.isArray(input.dependsOn)
        ? input.dependsOn.filter((d): d is string => typeof d === "string")
        : []
    const retries =
        typeof input.retries === "number" && Number.isFinite(input.retries)
            ? Math.min(
                  MAX_STORY_RETRIES,
                  Math.max(0, Math.floor(input.retries)),
              )
            : STORY_DEFAULTS.retries
    const acceptance = Array.isArray(input.acceptance)
        ? input.acceptance.filter((a): a is string => typeof a === "string")
        : []
    const tests = Array.isArray(input.tests)
        ? input.tests.filter((t): t is string => typeof t === "string")
        : []
    const goalInvariantIds = Array.isArray(input.goalInvariantIds)
        ? [
              ...new Set(
                  input.goalInvariantIds.filter(
                      (item): item is string =>
                          typeof item === "string" &&
                          /^G-[AC][1-9]\d*$/.test(item),
                  ),
              ),
          ]
        : undefined
    const passes = input.passes === true
    const completedAt =
        typeof input.completedAt === "string" ? input.completedAt : null
    const durationSecs =
        typeof input.durationSecs === "number" ? input.durationSecs : null
    const model = typeof input.model === "string" ? input.model : undefined
    return {
        id,
        priority,
        title,
        description,
        dependsOn,
        retries,
        acceptance,
        tests,
        ...(goalInvariantIds ? { goalInvariantIds } : {}),
        passes,
        completedAt,
        durationSecs,
        model,
    }
}

/** Immutable update; caller is responsible for persisting. */
export function markStoryPassed(
    prd: PrdFile,
    storyId: string,
    durationSecs: number,
): PrdFile {
    return {
        ...prd,
        userStories: prd.userStories.map((s) =>
            s.id === storyId
                ? {
                      ...s,
                      passes: true,
                      completedAt: new Date().toISOString(),
                      durationSecs,
                  }
                : s,
        ),
    }
}

export interface AppliedReplanResult {
    prd: PrdFile
    /** The exact mutation that changed `prd`; ignored proposal entries are absent. */
    applied: ReplanData
}

/**
 * Apply a legacy replan without mutating the current PRD snapshot and return
 * the exact effective mutation. Legacy replans intentionally tolerate stale
 * entries, so observers must never project the proposal itself as committed
 * state: passed removals, unknown rewires, and duplicate additions are no-ops.
 */
export function applyReplanWithEffectiveDelta(
    prd: PrdFile,
    replan: ReplanData,
): AppliedReplanResult {
    let stories = prd.userStories.slice()
    const removedStoryIds: string[] = []

    if (replan.removedStoryIds.length > 0) {
        const requested = new Set(replan.removedStoryIds)
        const removable = new Set(
            stories
                .filter((story) => requested.has(story.id) && !story.passes)
                .map((story) => story.id),
        )
        const recorded = new Set<string>()
        for (const storyId of replan.removedStoryIds) {
            if (removable.has(storyId) && !recorded.has(storyId)) {
                recorded.add(storyId)
                removedStoryIds.push(storyId)
            }
        }
        stories = stories.filter((story) => !removable.has(story.id))
    }

    const modifiedDeps: Record<string, readonly string[]> = {}
    if (Object.keys(replan.modifiedDeps).length > 0) {
        const existing = new Map(stories.map((story) => [story.id, story]))
        for (const [storyId, proposedDeps] of Object.entries(
            replan.modifiedDeps,
        )) {
            const story = existing.get(storyId)
            if (!story || sameStringArray(story.dependsOn, proposedDeps)) continue
            modifiedDeps[storyId] = [...proposedDeps]
        }
        stories = stories.map((story) => {
            const dependsOn = modifiedDeps[story.id]
            return dependsOn ? { ...story, dependsOn: [...dependsOn] } : story
        })
    }

    const addedStories: ReplanStoryAdd[] = []
    if (replan.addedStories.length > 0) {
        const existing = new Set(stories.map((story) => story.id))
        for (const added of replan.addedStories) {
            if (existing.has(added.id)) continue
            existing.add(added.id)
            const applied = cloneReplanStoryAdd(added)
            addedStories.push(applied)
            stories.push({
                id: applied.id,
                priority: applied.priority,
                title: applied.title,
                description: applied.description,
                dependsOn: [...applied.dependsOn],
                retries: Math.min(MAX_STORY_RETRIES, applied.retries ?? 2),
                acceptance: applied.acceptance ? [...applied.acceptance] : [],
                tests: applied.tests ? [...applied.tests] : [],
                ...(applied.goalInvariantIds
                    ? { goalInvariantIds: [...applied.goalInvariantIds] }
                    : {}),
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: applied.model,
            })
        }
    }

    return {
        prd: { ...prd, userStories: stories },
        applied: {
            source: replan.source,
            reason: replan.reason,
            addedStories,
            removedStoryIds,
            modifiedDeps,
            ...(replan.recovery
                ? { recovery: { ...replan.recovery } }
                : {}),
        },
    }
}

/** Apply a replan without mutating the current PRD snapshot. */
export function applyReplan(prd: PrdFile, replan: ReplanData): PrdFile {
    return applyReplanWithEffectiveDelta(prd, replan).prd
}

function sameStringArray(
    left: readonly string[],
    right: readonly string[],
): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    )
}

function cloneReplanStoryAdd(story: ReplanStoryAdd): ReplanStoryAdd {
    return {
        ...story,
        dependsOn: [...story.dependsOn],
        ...(story.acceptance ? { acceptance: [...story.acceptance] } : {}),
        ...(story.tests ? { tests: [...story.tests] } : {}),
        ...(story.goalInvariantIds
            ? { goalInvariantIds: [...story.goalInvariantIds] }
            : {}),
    }
}

/**
 * Trailer for every story commit and PR body (so squash-merges inherit it).
 * The `<numericUserId>+<login>@users.noreply.github.com` shape is what makes
 * GitHub auto-attribute commits to @baro-rs in the contributors view.
 */
export const BARO_COAUTHOR_TRAILER =
    "Co-Authored-By: baro <285254893+baro-rs@users.noreply.github.com>"

/**
 * Fallback prompt — callers should prefer a project-local `prompt.md`
 * template when one exists.
 */
export function buildDefaultStoryPrompt(story: PrdStory): string {
    const acceptance = story.acceptance.length
        ? story.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")
        : "(none specified)"
    const tests = story.tests.length
        ? story.tests.map((t) => `- ${t}`).join("\n")
        : "(no test commands specified)"
    return [
        `You are working on story ${story.id}: ${story.title}`,
        "",
        story.description,
        "",
        "ACCEPTANCE CRITERIA:",
        acceptance,
        "",
        "TEST COMMANDS:",
        tests,
        "",
        "SCOPE DISCIPLINE (read this twice):",
        "- Do ONLY what this story's description and acceptance criteria require. Nothing else.",
        "- Local scope never overrides a GLOBAL GOAL CONTRACT included above. If this",
        "  story cannot honestly provide its assigned global evidence, use the collective",
        "  collaboration/replan path to add or reshape work; do not silently ignore it.",
        "- Do NOT refactor adjacent code, rename neighbouring symbols, tidy unrelated files,",
        "  reformat imports, or fix issues you happen to notice along the way. Those are",
        "  separate stories the user did not ask for.",
        "- Do NOT add unrelated tests. Add the smallest focused regression test when it is",
        "  needed to prove an in-scope semantic acceptance criterion, even when the criterion",
        "  does not literally say `add a test`.",
        "- Do NOT introduce new dependencies, new abstractions, or new configuration",
        "  unless this story's description names them.",
        "- If a single-file edit is sufficient, make a single-file edit. Resist expanding.",
        "- If you notice unrelated bugs or improvements, mention them in your final commit",
        "  message under a `Noted (out of scope):` line so the user can file follow-ups.",
        "- Do NOT take external side-effecting actions — opening GitHub issues, posting PR",
        "  comments, sending notifications, pushing tags — UNLESS this story's acceptance",
        "  criteria explicitly require it. In a parallel run many agents share one working",
        "  tree, so a failure you observe is very likely produced by another story, not you.",
        "- If `npm test` / `cargo test` / the build surfaces a FAILURE in a file this story",
        "  did not create or modify, it is not yours to fix OR report. Note it under",
        "  `Noted (out of scope):` and move on — do not open an issue for it. A dedicated",
        "  triage story (or the user) owns deciding whether a shared failure is a real bug.",
        "- If — and ONLY if — this story's acceptance criteria explicitly require you to open",
        "  a GitHub issue, you MUST dedup BEFORE creating: run",
        '  `gh issue list --state open --search "<key symptom / file:line>"` and read the',
        "  titles it returns. If an open issue already describes the same root cause, do NOT",
        "  create a second one — at most add a comment to the existing issue if you have new",
        "  information. Only run `gh issue create` when no open issue matches. Give every issue",
        "  you do create a specific, deterministic title (name the file and the symptom, e.g.",
        '  "GetShopsQueryFilter: numeric city throws in @Transform") so a later run or a',
        "  sibling agent can match it and skip. This holds even when several stories are each",
        "  told to file issues — the search-then-create check is what prevents duplicates.",
        "",
        "IMPORTANT: Before you commit, you MUST verify the project builds successfully:",
        "  - If Cargo.toml exists: run `cargo build` and fix all errors and warnings",
        "  - If package.json exists: run `npm run build` (if a build script exists) and fix errors",
        "  - If go.mod exists: run `go build ./...` and fix errors",
        "  - If pyproject.toml or requirements.txt: ensure code is import-clean",
        "  - Otherwise: ensure linting/typecheck passes",
        "",
        "SEMANTIC SELF-REVIEW (mandatory before commit):",
        "- Re-read every acceptance criterion and challenge the implementation independently",
        "  of whether its tests are green. A changed test can pass while asserting the wrong",
        "  contract; compare each new expectation to the criterion it is meant to prove.",
        "- For asynchronous, concurrent, cancellation, streaming, retry, cleanup, or state-machine",
        "  behavior, enumerate the competing event orderings and test the decisive boundaries",
        "  deterministically: operation-first, control-first, original errors, late outcomes,",
        "  and cleanup side effects. Do not rely on timing sleeps or a single happy-path ordering.",
        "- Preserve existing no-signal/no-op, success, error, and cleanup behavior unless an",
        "  acceptance criterion explicitly changes it.",
        "",
        "When done with the story, commit your changes with a clear message.",
        "",
        "COMMIT MESSAGE TRAILER (mandatory):",
        "Every commit you create as part of this story MUST end with a blank line",
        "followed by this exact trailer line — no edits, no surrounding text:",
        "",
        `    ${BARO_COAUTHOR_TRAILER}`,
        "",
        "Use `git commit -m \"…\" -m \"\" -m \"" + BARO_COAUTHOR_TRAILER + "\"` so the",
        "trailer lands on its own paragraph at the bottom (git collapses the empty",
        "middle `-m` to a blank line between the subject and the trailer). This",
        "attributes the commit to the baro account in the contributors view.",
    ].join("\n")
}
