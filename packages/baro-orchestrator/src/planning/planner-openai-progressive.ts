import { type Tool } from "@mozaik-ai/core"

import type { PrdStory } from "../prd.js"
import { deriveGoalContract } from "../runtime/goal-contract.js"
import type { GoalEnvelope } from "../session/conversation-contract.js"
import type { BaroCommand } from "../tui-protocol.js"
import { validateGoalContractCoverage } from "./goal-contract-coverage.js"
import {
    openProgressivePlanSession,
    validateProgressivePlanFragment,
    type ProgressivePlanSession,
} from "./progressive-plan.js"

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
    publish(
        event: PlannerOpenAIPlanFragmentEvent,
    ): void | Promise<void>
}

/** Small policy surface consumed by the main Planner inference loop. */
export interface PlannerOpenAIProgressiveSupport {
    readonly extraTools: readonly Tool[]
    readonly systemInstruction: string | null
    reconcileFinalCandidate(candidate: string): void
    hasEarlyPlan(): boolean
}

export interface PlannerProgressivePublisher {
    publish(args: unknown): Promise<Record<string, unknown>>
    reconcileFinalCandidate(candidate: string): void
    hasEarlyPlan(): boolean
}

export const PROGRESSIVE_PLANNING_INSTRUCTION = `\
PROGRESSIVE PLANNING — act as soon as the evidence is sufficient:
While repository tools are open, the moment one or more implementation stories form a fully
specified, dependency-closed prefix that is safe to execute, call publish_plan_fragment
immediately. Do not wait for the full DAG or terminal PRD before publishing a safe prefix.

Every published story uses exactly the final-PRD story fields: id, priority, title, description,
dependsOn, retries, acceptance, tests, goalInvariantIds, and model. A published fragment is closed: each dependency
must already have been published or be present in that same fragment. Published stories are
immutable and become an exact, same-order prefix of the final PRD userStories array. The final PRD
must repeat every published title, description, priority, dependency, retry count, acceptance
criterion, test, and model unchanged; it may only append additional stories after that prefix.

This directive is conditional on safety. Never force an unsafe or provisional split merely to
publish early. If a story, dependency, write surface, or acceptance contract is still provisional,
keep exploring. If no dependency-closed prefix becomes safe before finalization, do not publish a
fragment; return the complete final PRD normally. The shared "Output ONLY JSON" rule applies only
to the terminal response; publish_plan_fragment tool calls are allowed during exploration.`

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
    reconcileFinalCandidate: (_candidate: string) => undefined,
    hasEarlyPlan: () => false,
})

export function createPlannerOpenAIProgressiveSupport(
    config: PlannerOpenAIProgressiveConfig | undefined,
): PlannerOpenAIProgressiveSupport {
    if (!config) return NO_PROGRESSIVE_SUPPORT
    const publisher = createPlannerProgressivePublisher(config)
    return {
        extraTools: [createPublishPlanFragmentTool(publisher)],
        systemInstruction: PROGRESSIVE_PLANNING_INSTRUCTION,
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
            const admission = session.admit(fragment)
            const event: PlannerOpenAIPlanFragmentEvent = {
                type: "plan_fragment",
                run_id: config.runId,
                planning_id: config.planningId,
                fragment_id: admission.fragmentId,
                ordinal: admission.ordinal,
                stories: fragment.stories.map(snapshotPlannerStory),
            }
            await config.publish(event)
            return {
                ok: true,
                disposition: admission.disposition,
                fragmentId: admission.fragmentId,
                ordinal: admission.ordinal,
                fingerprint: admission.fingerprint,
                storyIds: admission.admittedStoryIds,
                nextOrdinal: admission.nextOrdinal,
            }
        },
        reconcileFinalCandidate(candidate: string) {
            session.reconcile(progressiveFinalPrd(candidate))
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
    const expected = new Set<string>(FINAL_PRD_STORY_KEYS)
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
