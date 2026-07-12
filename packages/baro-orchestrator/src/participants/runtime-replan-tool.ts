import type { Tool } from "@mozaik-ai/core"

import type {
    RuntimeReplanAppliedData,
    RuntimeReplanMutation,
    RuntimeReplanRejectedData,
} from "../semantic-events.js"

export type RuntimeReplanDecision =
    | { status: "applied"; data: RuntimeReplanAppliedData }
    | { status: "rejected"; data: RuntimeReplanRejectedData }

export interface PendingRuntimeReplan {
    baseGraphVersion: number
    resolve: (decision: RuntimeReplanDecision) => void
}

export interface RuntimeReplanArgs {
    baseGraphVersion: number
    reason: string
    mutation: RuntimeReplanMutation
}

export type ParsedRuntimeReplanArgs =
    | { ok: true; value: RuntimeReplanArgs }
    | { ok: false; error: string }

export type RuntimeReplanToolStatus =
    | "applied"
    | "rejected"
    | "invalid"
    | "skipped"
    | "cancelled"
    | "timed_out"

export function createRuntimeReplanTool(graphVersion: number): Tool {
    return {
        type: "function",
        name: "propose_replan",
        description:
            "Propose an atomic runtime DAG change to the collective Board. " +
            "This never edits the DAG directly: wait for the structured applied or " +
            "rejected tool result before relying on the change.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                baseGraphVersion: {
                    type: "integer",
                    minimum: 1,
                    default: graphVersion,
                    description:
                        `Optimistic DAG version. This story launched at version ` +
                        `${graphVersion}; use a newer version only when a prior tool ` +
                        "result reported it.",
                },
                reason: {
                    type: "string",
                    minLength: 1,
                    description: "Concise evidence for why the DAG must change.",
                },
                addedStories: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string", minLength: 1 },
                            priority: { type: "number" },
                            title: { type: "string", minLength: 1 },
                            description: { type: "string", minLength: 1 },
                            dependsOn: {
                                type: "array",
                                items: { type: "string" },
                            },
                            retries: { type: "integer", minimum: 0 },
                            acceptance: {
                                type: "array",
                                items: { type: "string" },
                            },
                            tests: {
                                type: "array",
                                items: { type: "string" },
                            },
                            model: { type: "string" },
                        },
                        required: [
                            "id",
                            "priority",
                            "title",
                            "description",
                            "dependsOn",
                        ],
                        additionalProperties: false,
                    },
                },
                removedStoryIds: {
                    type: "array",
                    items: { type: "string" },
                },
                modifiedDeps: {
                    type: "object",
                    additionalProperties: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
            },
            required: [
                "baseGraphVersion",
                "reason",
                "addedStories",
                "removedStoryIds",
                "modifiedDeps",
            ],
            additionalProperties: false,
        },
        async invoke() {
            return runtimeReplanToolOutput("invalid", {
                code: "runtime_interception_required",
                reason: "propose_replan must be handled by OpenAIStoryAgent",
            })
        },
    }
}

export function parseRuntimeReplanArgs(raw: string): ParsedRuntimeReplanArgs {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch (error) {
        return {
            ok: false,
            error: `arguments are not valid JSON: ${(error as Error)?.message ?? String(error)}`,
        }
    }
    if (!isPlainRecord(value)) {
        return { ok: false, error: "arguments must be an object" }
    }

    const topKeys = new Set([
        "baseGraphVersion",
        "reason",
        "addedStories",
        "removedStoryIds",
        "modifiedDeps",
    ])
    const extra = Object.keys(value).find((key) => !topKeys.has(key))
    if (extra) return { ok: false, error: `unknown argument '${extra}'` }
    if (!validGraphVersion(value.baseGraphVersion)) {
        return {
            ok: false,
            error: "baseGraphVersion must be a positive integer",
        }
    }
    if (typeof value.reason !== "string" || !value.reason.trim()) {
        return { ok: false, error: "reason must be a non-empty string" }
    }

    const addedStories = parseAddedStories(value.addedStories)
    if (!addedStories.ok) return addedStories
    const removedStoryIds = stringArray(value.removedStoryIds, "removedStoryIds")
    if (!removedStoryIds.ok) return removedStoryIds
    const modifiedDeps = dependencyMap(value.modifiedDeps)
    if (!modifiedDeps.ok) return modifiedDeps

    return {
        ok: true,
        value: {
            baseGraphVersion: value.baseGraphVersion,
            reason: value.reason.trim(),
            mutation: {
                addedStories: addedStories.value,
                removedStoryIds: removedStoryIds.value,
                modifiedDeps: modifiedDeps.value,
            },
        },
    }
}

export function validGraphVersion(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 1
}

export function runtimeReplanToolOutput(
    status: RuntimeReplanToolStatus,
    data: Record<string, unknown>,
): string {
    return JSON.stringify({ ok: status === "applied", status, ...data })
}

function parseAddedStories(
    value: unknown,
):
    | { ok: true; value: RuntimeReplanMutation["addedStories"] }
    | { ok: false; error: string } {
    if (!Array.isArray(value)) {
        return { ok: false, error: "addedStories must be an array" }
    }
    const stories: Array<RuntimeReplanMutation["addedStories"][number]> = []
    const allowed = new Set([
        "id",
        "priority",
        "title",
        "description",
        "dependsOn",
        "retries",
        "acceptance",
        "tests",
        "model",
    ])
    for (let index = 0; index < value.length; index += 1) {
        const story = value[index]
        if (!isPlainRecord(story)) {
            return {
                ok: false,
                error: `addedStories[${index}] must be an object`,
            }
        }
        const extra = Object.keys(story).find((key) => !allowed.has(key))
        if (extra) {
            return {
                ok: false,
                error: `addedStories[${index}] has unknown field '${extra}'`,
            }
        }
        if (
            typeof story.id !== "string" ||
            typeof story.priority !== "number" ||
            !Number.isFinite(story.priority) ||
            typeof story.title !== "string" ||
            typeof story.description !== "string"
        ) {
            return {
                ok: false,
                error:
                    `addedStories[${index}] requires string ` +
                    "id/title/description and finite priority",
            }
        }
        const dependsOn = stringArray(
            story.dependsOn,
            `addedStories[${index}].dependsOn`,
        )
        if (!dependsOn.ok) return dependsOn
        if (
            story.retries !== undefined &&
            (!Number.isInteger(story.retries) || (story.retries as number) < 0)
        ) {
            return {
                ok: false,
                error:
                    `addedStories[${index}].retries must be a ` +
                    "non-negative integer",
            }
        }
        const acceptance = optionalStringArray(
            story.acceptance,
            `addedStories[${index}].acceptance`,
        )
        if (!acceptance.ok) return acceptance
        const tests = optionalStringArray(
            story.tests,
            `addedStories[${index}].tests`,
        )
        if (!tests.ok) return tests
        if (story.model !== undefined && typeof story.model !== "string") {
            return {
                ok: false,
                error: `addedStories[${index}].model must be a string`,
            }
        }
        stories.push({
            id: story.id,
            priority: story.priority,
            title: story.title,
            description: story.description,
            dependsOn: dependsOn.value,
            ...(story.retries !== undefined
                ? { retries: story.retries as number }
                : {}),
            ...(acceptance.value !== undefined
                ? { acceptance: acceptance.value }
                : {}),
            ...(tests.value !== undefined ? { tests: tests.value } : {}),
            ...(story.model !== undefined ? { model: story.model } : {}),
        })
    }
    return { ok: true, value: stories }
}

function dependencyMap(
    value: unknown,
):
    | { ok: true; value: RuntimeReplanMutation["modifiedDeps"] }
    | { ok: false; error: string } {
    if (!isPlainRecord(value)) {
        return { ok: false, error: "modifiedDeps must be an object" }
    }
    const out: Record<string, readonly string[]> = {}
    for (const [storyId, dependencies] of Object.entries(value)) {
        const parsed = stringArray(dependencies, `modifiedDeps.${storyId}`)
        if (!parsed.ok) return parsed
        out[storyId] = parsed.value
    }
    return { ok: true, value: out }
}

function stringArray(
    value: unknown,
    field: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
    return Array.isArray(value) &&
        value.every((item) => typeof item === "string")
        ? { ok: true, value: [...value] }
        : { ok: false, error: `${field} must be an array of strings` }
}

function optionalStringArray(
    value: unknown,
    field: string,
):
    | { ok: true; value: string[] | undefined }
    | { ok: false; error: string } {
    return value === undefined
        ? { ok: true, value: undefined }
        : stringArray(value, field)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
