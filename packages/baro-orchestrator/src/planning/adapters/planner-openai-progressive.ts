import { type Tool } from "../../runtime/mozaik.js"

import type { PrdStory } from "../../prd.js"
import { deriveGoalContract } from "../../goal/goal-contract.js"
import type { GoalEnvelope } from "../../conversation/session/conversation-contract.js"
import type { BaroCommand } from "../../tui-protocol.js"
import {
    architectureObligationsFromDecision,
    obligationMappingsForStories,
    validateArchitectureObligationCoverage,
} from "../domain/architecture-obligation-contract.js"
import { validateGoalContractCoverage } from "../domain/goal-contract-coverage.js"
import {
    openProgressivePlanSession,
    reconcileProgressivePlanStories,
    validateProgressivePlanFragment,
    type ProgressivePlanSession,
} from "../domain/progressive-plan.js"

export type PlannerOpenAIPlanFragmentEvent = Extract<
    BaroCommand,
    { type: "plan_fragment" }
>

export interface PlannerOpenAIProgressiveConfig {
    runId: string
    planningId: string
    /** Host-authored intent used only to reject unknown invariant claims before
     * the local immutable-prefix state advances. Missing preserves legacy. */
    trustedGoalEnvelope?: GoalEnvelope
    /** Architect-authored document used only with the host-owned goal. */
    trustedDecisionDocument?: string
    /** Finalization carries only the appended tail; the host composes the
     * full plan from its admitted record (see ProgressiveReconcileOptions). */
    finalizationTailOnly?: boolean
    /** May return host feedback (authoritative admission: graph version,
     *  dropped edges) that is merged into the tool result the planner sees. */
    publish(
        event: PlannerOpenAIPlanFragmentEvent,
    ):
        | void
        | Record<string, unknown>
        | Promise<void | Record<string, unknown>>
}

/** Small policy surface consumed by the main Planner inference loop. */
export interface PlannerOpenAIProgressiveSupport {
    readonly extraTools: readonly Tool[]
    readonly systemInstruction: string | null
    /** Returns the composed final PRD (admitted prefix + tail). */
    reconcileFinalCandidate(candidate: string): Record<string, unknown>
    hasEarlyPlan(): boolean
}

export interface PlannerProgressivePublisher {
    publish(args: unknown): Promise<Record<string, unknown>>
    /** Returns the composed final PRD (admitted prefix + tail). */
    reconcileFinalCandidate(candidate: string): Record<string, unknown>
    hasEarlyPlan(): boolean
}

const PROGRESSIVE_PLANNING_CORE = `\
PROGRESSIVE PLANNING — act as soon as the evidence is sufficient:
While repository tools are open, the moment one or more implementation stories form a fully
specified, dependency-closed prefix that is safe to execute, call publish_plan_fragment
immediately. Do not wait for the full DAG or terminal PRD before publishing a safe prefix.

Every published story uses exactly the final-PRD story fields: id, priority, title, description,
dependsOn, retries, acceptance, tests, goalInvariantIds, model, and writes. "writes" lists the files
this story will create or modify; the host prunes any dependsOn edge no file supports, so an edge
you cannot justify with a file will be dropped whether you publish it or not. A published fragment is closed: each dependency
must already have been published or be present in that same fragment.

Architecture obligations ride WITH their owner story: every obligation id the decision document
assigns must appear as an acceptance criterion of the story that owns it, in the fragment where
that story is published. Published stories are immutable, so an obligation cannot be attached,
moved, or reworded at finalization — a plan whose published stories do not own every obligation
by the time planning closes is rejected as incomplete. `

const PROGRESSIVE_REPEAT_FINALIZATION = `Published stories are
immutable and become an exact, same-order prefix of the final PRD userStories array. The final PRD
must repeat every published title, description, priority, dependency, retry count, acceptance
criterion, test, and model unchanged; it may only append additional stories after that prefix.`

// Asking the model to re-transmit bytes the host already holds only
// manufactures transcription mismatches (runs 13/14) — in tail-only mode the
// host composes the plan and the model states only what is new.
const PROGRESSIVE_TAIL_FINALIZATION = `Published stories are
immutable and the host keeps them verbatim — do NOT repeat them at finalization. The terminal PRD
JSON must contain ONLY the stories that come after the published prefix in userStories (use an
empty userStories array when nothing remains), together with the usual project, branchName and
description metadata. The host composes the complete plan from the published prefix plus your
appended stories.`

const PROGRESSIVE_SAFETY = `

This directive is conditional on safety. Never force an unsafe or provisional split merely to
publish early. If a story, dependency, write surface, or acceptance contract is still provisional,
keep exploring. If no dependency-closed prefix becomes safe before finalization, do not publish a
fragment; return the complete final PRD normally. The shared "Output ONLY JSON" rule applies only
to the terminal response; publish_plan_fragment tool calls are allowed during exploration.`

export function progressivePlanningInstruction(tailOnly: boolean): string {
    return (
        PROGRESSIVE_PLANNING_CORE +
        (tailOnly ? PROGRESSIVE_TAIL_FINALIZATION : PROGRESSIVE_REPEAT_FINALIZATION) +
        PROGRESSIVE_SAFETY
    )
}

export const PROGRESSIVE_PLANNING_INSTRUCTION = progressivePlanningInstruction(false)

export const PUBLISH_PLAN_FRAGMENT_DESCRIPTION =
    "Publish one closed, immutable batch of fully specified stories for early execution. " +
    "Every dependency must already be published or appear in this batch. Published stories " +
    "must remain the exact same-order prefix of the final PRD."

const FINAL_PRD_STORY_INPUT_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        id: { type: "string" },
        priority: {
            type: "integer",
            minimum: -2_147_483_648,
            maximum: 2_147_483_647,
        },
        title: { type: "string" },
        description: { type: "string" },
        dependsOn: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
        },
        retries: { type: "integer", minimum: 0, maximum: 5 },
        acceptance: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            uniqueItems: true,
        },
        tests: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            uniqueItems: true,
        },
        goalInvariantIds: {
            type: "array",
            items: { type: "string", pattern: "^G-[AC][1-9][0-9]*$" },
            uniqueItems: true,
        },
        model: {
            type: "string",
            enum: ["light", "standard", "heavy"],
        },
        writes: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
        },
    },
    required: [
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
        "writes",
    ],
    additionalProperties: false,
}

export const PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        fragmentId: {
            type: "string",
            description: "Stable unique ID for this fragment; reuse only for exact replay.",
        },
        stories: {
            type: "array",
            minItems: 1,
            // Advertise one unambiguous shape to strict tool-schema clients.
            // The publisher normalizes this final-PRD shape and still accepts
            // the former execution-neutral shape for wire compatibility.
            items: FINAL_PRD_STORY_INPUT_SCHEMA,
        },
    },
    required: ["fragmentId", "stories"],
    additionalProperties: false,
}

const NO_PROGRESSIVE_SUPPORT: PlannerOpenAIProgressiveSupport = Object.freeze({
    extraTools: Object.freeze([]) as readonly Tool[],
    systemInstruction: null,
    reconcileFinalCandidate: (candidate: string) =>
        JSON.parse(candidate) as Record<string, unknown>,
    hasEarlyPlan: () => false,
})

export function createPlannerOpenAIProgressiveSupport(
    config: PlannerOpenAIProgressiveConfig | undefined,
): PlannerOpenAIProgressiveSupport {
    if (!config) return NO_PROGRESSIVE_SUPPORT
    const publisher = createPlannerProgressivePublisher(config)
    return {
        extraTools: [createPublishPlanFragmentTool(publisher)],
        systemInstruction: progressivePlanningInstruction(
            config.finalizationTailOnly === true,
        ),
        reconcileFinalCandidate: (candidate) =>
            publisher.reconcileFinalCandidate(candidate),
        hasEarlyPlan: () => publisher.hasEarlyPlan(),
    }
}

/** Provider-neutral state machine behind native and harness-backed tools. */
export function createPlannerProgressivePublisher(
    config: PlannerOpenAIProgressiveConfig,
): PlannerProgressivePublisher {
    const session = openPlannerProgressiveSession(config)
    const goalContract = deriveGoalContract(config.trustedGoalEnvelope)
    const obligationContract = architectureObligationsFromDecision(
        config.trustedDecisionDocument,
        goalContract,
    )
    return {
        async publish(args: unknown) {
            if (!isExactToolArgs(args)) {
                throw new Error(
                    "publish_plan_fragment requires exact fragmentId and stories fields",
                )
            }
            const remembered = session
                .snapshot()
                .fragments.find((fragment) => fragment.fragmentId === args.fragmentId)
            const fragment = validateProgressivePlanFragment({
                schemaVersion: 1,
                planningSessionId: config.planningId,
                fragmentId: args.fragmentId,
                ordinal: remembered?.ordinal ?? session.nextOrdinal,
                stories: normalizePublishedStories(args.stories),
            })
            validateGoalContractCoverage(
                goalContract,
                goalContractMappings(fragment.stories),
                "partial",
            )
            const fragmentStoryIds = new Set(
                fragment.stories.map(({ id }) => id),
            )
            validateArchitectureObligationCoverage(
                obligationContract,
                obligationMappingsForStories([
                    // Exact fragment replay is part of the progressive
                    // protocol. Replace its remembered projection here so a
                    // canonical obligation is not mistaken for two owners;
                    // session.admit remains the authority that rejects a
                    // conflicting replay.
                    ...session.snapshot().stories.filter(
                        ({ id }) => !fragmentStoryIds.has(id),
                    ),
                    ...fragment.stories,
                ]),
                "partial",
            )
            const admission = session.admit(fragment)
            const event: PlannerOpenAIPlanFragmentEvent = {
                type: "plan_fragment",
                run_id: config.runId,
                planning_id: config.planningId,
                fragment_id: admission.fragmentId,
                ordinal: admission.ordinal,
                stories: fragment.stories.map(snapshotPlannerStory),
            }
            const hostFeedback = await config.publish(event)
            return {
                ok: true,
                disposition: admission.disposition,
                fragmentId: admission.fragmentId,
                ordinal: admission.ordinal,
                fingerprint: admission.fingerprint,
                storyIds: admission.admittedStoryIds,
                nextOrdinal: admission.nextOrdinal,
                ...(hostFeedback ?? {}),
            }
        },
        reconcileFinalCandidate(candidate: string) {
            const parsed = JSON.parse(candidate) as Record<string, unknown>
            const finalPrd = progressiveFinalPrd(candidate)
            if (session.phase === "reconciled") {
                // Replay identity (or conflict) is judged on the raw
                // candidate, exactly as before composition existed.
                session.reconcile(finalPrd)
                const snapshot = session.snapshot()
                return {
                    ...parsed,
                    userStories: [
                        ...snapshot.stories,
                        ...(snapshot.finalTail ?? []),
                    ],
                }
            }
            // Compose first, without touching session state: coverage and
            // reconciliation must judge the COMPLETE plan, and a rejection
            // must leave the session open for a corrected attempt.
            const composed = reconcileProgressivePlanStories(
                session.snapshot().stories,
                finalPrd,
                { tailOnly: config.finalizationTailOnly === true },
            )
            validateArchitectureObligationCoverage(
                obligationContract,
                obligationMappingsForStories(composed.finalStories),
                "complete",
            )
            session.reconcile({ userStories: composed.finalStories })
            return { ...parsed, userStories: composed.finalStories }
        },
        hasEarlyPlan() {
            return session.snapshot().stories.length > 0
        },
    }
}

function goalContractMappings(stories: readonly PrdStory[]) {
    return stories.map((story) => ({
        storyId: story.id,
        invariantIds: story.goalInvariantIds ?? [],
    }))
}

function openPlannerProgressiveSession(
    config: PlannerOpenAIProgressiveConfig,
): ProgressivePlanSession {
    if (!safeControlId(config.runId)) {
        throw new Error("PlannerOpenAI: progressive runId must be safe non-empty text")
    }
    if (!safeControlId(config.planningId)) {
        throw new Error("PlannerOpenAI: progressive planningId must be safe non-empty text")
    }
    if (typeof config.publish !== "function") {
        throw new Error("PlannerOpenAI: progressive publish callback is required")
    }
    return openProgressivePlanSession({
        schemaVersion: 1,
        planningSessionId: config.planningId,
    })
}

function createPublishPlanFragmentTool(
    publisher: PlannerProgressivePublisher,
): Tool {
    return {
        type: "function",
        name: "publish_plan_fragment",
        description: PUBLISH_PLAN_FRAGMENT_DESCRIPTION,
        strict: true,
        parameters: PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA,
        async invoke(args: unknown) {
            return JSON.stringify(await publisher.publish(args))
        },
    }
}

function progressiveFinalPrd(candidate: string): { userStories: PrdStory[] } {
    const parsed = JSON.parse(candidate) as { userStories: Array<Record<string, unknown>> }
    return {
        userStories: parsed.userStories.map((story) => ({
            id: story.id as string,
            priority: story.priority as number,
            title: story.title as string,
            description: story.description as string,
            dependsOn: [...(story.dependsOn as string[])],
            retries: story.retries as number,
            acceptance: [...(story.acceptance as string[])],
            tests: [...(story.tests as string[])],
            goalInvariantIds: [
                ...((story.goalInvariantIds as string[] | undefined) ?? []),
            ],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: story.model as string,
            // The eighth boundary for the same field: this parser silently
            // shed `writes`, so every faithful final PRD failed reconciliation
            // on a field the model never got wrong (runs 13/14).
            ...(story.writes !== undefined
                ? { writes: [...(story.writes as string[])] }
                : {}),
        })),
    }
}

const FINAL_PRD_STORY_KEYS = [
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
] as const

/** Required of the model by the tool schema, tolerated by the host: a planner
 *  that omits it should lose edge checking, not lose its fragment. */
const OPTIONAL_PRD_STORY_KEYS = ["writes"] as const

/**
 * The durable progressive contract deliberately remains execution-neutral,
 * while planners should not need to invent fields that do not exist in their
 * terminal PRD. Normalize only the exact final-PRD shape; malformed, partial,
 * or extended records flow unchanged into the existing strict validator.
 */
function normalizePublishedStories(value: unknown): unknown {
    if (!Array.isArray(value)) return value
    return value.map((story) => {
        if (!isFinalPrdStoryRecord(story)) return story
        return {
            ...story,
            passes: false,
            completedAt: null,
            durationSecs: null,
        }
    })
}

function isFinalPrdStoryRecord(
    value: unknown,
): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Object.keys(value)
    const expected = new Set<string>([
        ...FINAL_PRD_STORY_KEYS,
        ...OPTIONAL_PRD_STORY_KEYS,
    ])
    return (
        FINAL_PRD_STORY_KEYS.every((key) => keys.includes(key)) &&
        keys.every((key) => expected.has(key))
    )
}

function snapshotPlannerStory(story: PrdStory): PrdStory {
    return {
        id: story.id,
        priority: story.priority,
        title: story.title,
        description: story.description,
        dependsOn: [...story.dependsOn],
        retries: story.retries,
        acceptance: [...story.acceptance],
        tests: [...story.tests],
        goalInvariantIds: [...(story.goalInvariantIds ?? [])],
        passes: false,
        completedAt: null,
        durationSecs: null,
        ...(story.model !== undefined ? { model: story.model } : {}),
        ...(story.writes !== undefined ? { writes: [...story.writes] } : {}),
    }
}

function isExactToolArgs(
    value: unknown,
): value is { fragmentId: unknown; stories: unknown } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Object.keys(value)
    return (
        keys.length === 2 &&
        keys.includes("fragmentId") &&
        keys.includes("stories")
    )
}

function safeControlId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 256 &&
        value === value.trim() &&
        !/[\u0000-\u001f\u007f]/u.test(value)
    )
}
