import { type Tool } from "@mozaik-ai/core"

import type { PrdStory } from "../prd.js"
import type { BaroCommand } from "../tui-protocol.js"
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

const PROGRESSIVE_PLANNING_INSTRUCTION = `\
Progressive planning is enabled. While repository tools are open, you may call
publish_plan_fragment when one or more implementation stories are fully decided and safe to
execute early. Every published story must include the complete PrdStory fields, including
passes=false, completedAt=null, and durationSecs=null. A published fragment is closed: each
dependency must already have been published or be present in that same fragment. Never publish a
provisional forward reference. Published stories are immutable and become an exact, same-order
prefix of the final PRD userStories array. The final PRD must repeat every published title,
description, priority, dependency, retry count, acceptance criterion, test, and model unchanged;
it may only append additional stories after that prefix. Publishing is optional: if no prefix is
safe, continue exploring and return the complete final PRD normally.`

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
    const session = openPlannerProgressiveSession(config)
    return {
        extraTools: [createPublishPlanFragmentTool(config, session)],
        systemInstruction: PROGRESSIVE_PLANNING_INSTRUCTION,
        reconcileFinalCandidate: (candidate) => {
            session.reconcile(progressiveFinalPrd(candidate))
        },
        hasEarlyPlan: () => session.snapshot().stories.length > 0,
    }
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
    config: PlannerOpenAIProgressiveConfig,
    session: ProgressivePlanSession,
): Tool {
    return {
        type: "function",
        name: "publish_plan_fragment",
        description:
            "Publish one closed, immutable batch of fully specified stories for early execution. " +
            "Every dependency must already be published or appear in this batch. Published stories " +
            "must remain the exact same-order prefix of the final PRD.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                fragmentId: {
                    type: "string",
                    description: "Stable unique ID for this fragment; reuse only for exact replay.",
                },
                stories: {
                    type: "array",
                    minItems: 1,
                    items: {
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
                            passes: { type: "boolean", const: false },
                            completedAt: { type: "null" },
                            durationSecs: { type: "null" },
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
                            "passes",
                            "completedAt",
                            "durationSecs",
                            "model",
                        ],
                        additionalProperties: false,
                    },
                },
            },
            required: ["fragmentId", "stories"],
            additionalProperties: false,
        },
        async invoke(args: unknown) {
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
                stories: args.stories,
            })
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
            return JSON.stringify({
                ok: true,
                disposition: admission.disposition,
                fragmentId: admission.fragmentId,
                ordinal: admission.ordinal,
                fingerprint: admission.fingerprint,
                storyIds: admission.admittedStoryIds,
                nextOrdinal: admission.nextOrdinal,
            })
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
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: story.model as string,
        })),
    }
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
