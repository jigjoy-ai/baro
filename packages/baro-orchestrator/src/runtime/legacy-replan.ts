import { buildDag } from "../dag.js"
import {
    applyReplanWithEffectiveDelta,
    MAX_STORY_PRIORITY,
    MAX_STORY_RETRIES,
    MIN_STORY_PRIORITY,
    type AppliedReplanResult,
    type PrdFile,
} from "../prd.js"
import type { ReplanData, ReplanStoryAdd } from "../semantic-events.js"

export type LegacyReplanRejectionCode =
    | "invalid_proposal"
    | "duplicate_story"
    | "unknown_story"
    | "unknown_dependency"
    | "duplicate_dependency"
    | "self_dependency"
    | "dependency_cycle"
    | "destructive_removal"
    | "no_op"

export type LegacyReplanValidationResult =
    | ({ ok: true } & AppliedReplanResult)
    | {
          ok: false
          code: LegacyReplanRejectionCode
          reason: string
          source: string
      }

/**
 * Validate an untrusted legacy Surgeon proposal and derive its exact effective
 * mutation. Legacy compatibility still permits stale removals and duplicate
 * additions as no-ops, but malformed input or an invalid resulting graph is
 * rejected atomically before the PRD can be persisted.
 */
export function validateLegacyReplan(
    prd: PrdFile,
    value: unknown,
): LegacyReplanValidationResult {
    try {
        const parsed = parseLegacyReplan(value)
        if (!parsed.ok) return parsed

        const operations = new Map<string, "add" | "remove" | "modify">()
        for (const [operation, storyIds] of [
            ["add", parsed.replan.addedStories.map((story) => story.id)],
            ["remove", parsed.replan.removedStoryIds],
            ["modify", Object.keys(parsed.replan.modifiedDeps)],
        ] as const) {
            for (const storyId of storyIds) {
                const previous = operations.get(storyId)
                if (previous && previous !== operation) {
                    return reject(
                        "duplicate_story",
                        `story '${storyId}' is targeted by both ${previous} and ${operation}`,
                        parsed.replan.source,
                    )
                }
                operations.set(storyId, operation)
            }
        }

        const currentIds = new Set(prd.userStories.map((story) => story.id))
        for (const storyId of Object.keys(parsed.replan.modifiedDeps)) {
            if (!currentIds.has(storyId)) {
                return reject(
                    "unknown_story",
                    `cannot rewire unknown story '${storyId}'`,
                    parsed.replan.source,
                )
            }
        }

        const applied = applyReplanWithEffectiveDelta(prd, parsed.replan)
        const mutation = applied.applied
        if (
            mutation.addedStories.length === 0 &&
            mutation.removedStoryIds.length === 0 &&
            Object.keys(mutation.modifiedDeps).length === 0
        ) {
            return reject(
                "no_op",
                "legacy replan has no effective operations",
                parsed.replan.source,
            )
        }

        // Evaluate destructive scope after stale/duplicate operations have
        // been removed. A duplicate addition cannot disguise a pure removal.
        if (
            mutation.removedStoryIds.length > 0 &&
            mutation.addedStories.length === 0
        ) {
            return reject(
                "destructive_removal",
                "legacy replan cannot remove stories without effective replacement work",
                parsed.replan.source,
            )
        }

        const graphIssue = validateCandidateGraph(applied.prd, parsed.replan.source)
        if (graphIssue) return graphIssue
        return { ok: true, ...applied }
    } catch {
        return reject(
            "invalid_proposal",
            "legacy replan payload could not be safely inspected",
            safeSource(value),
        )
    }
}

type ParsedLegacyReplan =
    | { ok: true; replan: ReplanData }
    | Extract<LegacyReplanValidationResult, { ok: false }>

function parseLegacyReplan(value: unknown): ParsedLegacyReplan {
    const source = safeSource(value)
    if (
        !plainRecord(value) ||
        !onlyKeys(value, [
            "source",
            "reason",
            "addedStories",
            "removedStoryIds",
            "modifiedDeps",
            "recovery",
        ]) ||
        !nonBlank(value.source) ||
        !nonBlank(value.reason) ||
        !Array.isArray(value.addedStories) ||
        !Array.isArray(value.removedStoryIds) ||
        !plainRecord(value.modifiedDeps)
    ) {
        return reject(
            "invalid_proposal",
            "legacy replan payload is malformed",
            source,
        )
    }

    const addedStories: ReplanStoryAdd[] = []
    for (const candidate of value.addedStories) {
        const story = parseAddedStory(candidate)
        if (!story.ok) return reject("invalid_proposal", story.reason, source)
        addedStories.push(story.story)
    }

    const removedStoryIds: string[] = []
    for (const storyId of value.removedStoryIds) {
        if (!validId(storyId)) {
            return reject(
                "invalid_proposal",
                "removed story ids must be non-empty, trimmed strings",
                source,
            )
        }
        removedStoryIds.push(storyId)
    }

    const modifiedDeps: Record<string, readonly string[]> = {}
    for (const [storyId, dependencies] of Object.entries(value.modifiedDeps)) {
        if (!validId(storyId) || !validIdArray(dependencies)) {
            return reject(
                "invalid_proposal",
                "modified dependencies must map valid story ids to arrays of valid story ids",
                source,
            )
        }
        modifiedDeps[storyId] = [...dependencies]
    }

    const recovery = parseRecovery(value.recovery)
    if (!recovery.ok) return reject("invalid_proposal", recovery.reason, source)

    return {
        ok: true,
        replan: {
            source: value.source,
            reason: value.reason,
            addedStories,
            removedStoryIds,
            modifiedDeps,
            ...(recovery.value ? { recovery: recovery.value } : {}),
        },
    }
}

function parseAddedStory(
    value: unknown,
): { ok: true; story: ReplanStoryAdd } | { ok: false; reason: string } {
    if (
        !plainRecord(value) ||
        !onlyKeys(value, [
            "id",
            "priority",
            "title",
            "description",
            "dependsOn",
            "retries",
            "acceptance",
            "tests",
            "model",
            "goalInvariantIds",
        ]) ||
        !validId(value.id) ||
        !Number.isInteger(value.priority) ||
        Number(value.priority) < MIN_STORY_PRIORITY ||
        Number(value.priority) > MAX_STORY_PRIORITY ||
        !nonBlank(value.title) ||
        !nonBlank(value.description) ||
        !validIdArray(value.dependsOn) ||
        (value.retries !== undefined &&
            (!Number.isSafeInteger(value.retries) ||
                Number(value.retries) < 0 ||
                Number(value.retries) > MAX_STORY_RETRIES)) ||
        !nonBlankStringArray(value.acceptance) ||
        !nonBlankStringArray(value.tests) ||
        (value.model !== undefined && !nonBlank(value.model)) ||
        (value.goalInvariantIds !== undefined &&
            (!validIdArray(value.goalInvariantIds) ||
                value.goalInvariantIds.some(
                    (invariantId) => !/^G-[AC][1-9]\d*$/.test(invariantId),
                )))
    ) {
        return { ok: false, reason: "legacy replan contains a malformed added story" }
    }

    return {
        ok: true,
        story: {
            id: value.id,
            priority: Number(value.priority),
            title: value.title,
            description: value.description,
            dependsOn: [...value.dependsOn],
            ...(value.retries !== undefined
                ? { retries: Number(value.retries) }
                : {}),
            acceptance: [...value.acceptance],
            tests: [...value.tests],
            ...(value.goalInvariantIds !== undefined
                ? { goalInvariantIds: [...value.goalInvariantIds] }
                : {}),
            ...(value.model !== undefined ? { model: value.model } : {}),
        },
    }
}

function parseRecovery(value: unknown):
    | { ok: true; value: ReplanData["recovery"] }
    | { ok: false; reason: string } {
    if (value === undefined) return { ok: true, value: undefined }
    if (
        !plainRecord(value) ||
        !onlyKeys(value, ["runId", "storyId", "leaseId", "generation"]) ||
        !validId(value.storyId) ||
        (value.runId !== undefined && !validId(value.runId)) ||
        (value.leaseId !== undefined && !validId(value.leaseId)) ||
        (value.generation !== undefined &&
            (!Number.isSafeInteger(value.generation) ||
                Number(value.generation) < 0))
    ) {
        return { ok: false, reason: "legacy replan recovery correlation is malformed" }
    }
    return {
        ok: true,
        value: {
            ...(value.runId !== undefined ? { runId: value.runId } : {}),
            storyId: value.storyId,
            ...(value.leaseId !== undefined ? { leaseId: value.leaseId } : {}),
            ...(value.generation !== undefined
                ? { generation: Number(value.generation) }
                : {}),
        },
    }
}

function validateCandidateGraph(
    prd: PrdFile,
    source: string,
): Extract<LegacyReplanValidationResult, { ok: false }> | null {
    const storyIds = new Set(prd.userStories.map((story) => story.id))
    for (const story of prd.userStories) {
        const duplicate = firstDuplicate(story.dependsOn)
        if (duplicate) {
            return reject(
                "duplicate_dependency",
                `story '${story.id}' depends on '${duplicate}' more than once`,
                source,
            )
        }
        for (const dependency of story.dependsOn) {
            if (dependency === story.id) {
                return reject(
                    "self_dependency",
                    `story '${story.id}' cannot depend on itself`,
                    source,
                )
            }
            if (!storyIds.has(dependency)) {
                return reject(
                    "unknown_dependency",
                    `story '${story.id}' depends on unknown story '${dependency}'`,
                    source,
                )
            }
        }
    }
    try {
        buildDag(prd.userStories)
    } catch {
        return reject(
            "dependency_cycle",
            "legacy replan candidate contains a dependency cycle",
            source,
        )
    }
    return null
}

function reject(
    code: LegacyReplanRejectionCode,
    reason: string,
    source: string,
): Extract<LegacyReplanValidationResult, { ok: false }> {
    return { ok: false, code, reason, source }
}

function firstDuplicate(values: readonly string[]): string | null {
    const seen = new Set<string>()
    for (const value of values) {
        if (seen.has(value)) return value
        seen.add(value)
    }
    return null
}

function safeSource(value: unknown): string {
    try {
        return plainRecord(value) && typeof value.source === "string"
            ? value.source
            : "unknown"
    } catch {
        return "unknown"
    }
}

function validId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value
}

function nonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function validIdArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(validId)
}

function stringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function nonBlankStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.every(nonBlank)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function onlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const keys = new Set(allowed)
    return Object.keys(value).every((key) => keys.has(key))
}
