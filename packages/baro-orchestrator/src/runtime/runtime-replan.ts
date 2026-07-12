import { buildDag } from "../dag.js"
import type { PrdFile, PrdStory } from "../prd.js"
import { isVerificationOnlyStory } from "../planning/verification-stories.js"
import type {
    ReplanStoryAdd,
    RuntimeReplanMutation,
    RuntimeReplanRejectionCode,
} from "../semantic-events.js"

export interface RuntimeReplanValidationOptions {
    /** Running, leased, or otherwise already-started stories are immutable. */
    immutableStoryIds: Iterable<string>
    /** Remaining number of dynamic stories this proposal may add. */
    maxAddedStories: number
}

export interface RuntimeReplanValidationSuccess {
    ok: true
    prd: PrdFile
    addedStoryIds: string[]
    removedStoryIds: string[]
    modifiedStoryIds: string[]
    affectedStoryIds: string[]
}

export interface RuntimeReplanValidationFailure {
    ok: false
    code: RuntimeReplanRejectionCode
    reason: string
}

export type RuntimeReplanValidationResult =
    | RuntimeReplanValidationSuccess
    | RuntimeReplanValidationFailure

/**
 * Deep-copy the replay-facing mutation fields. Callers use this before
 * publishing an accepted mutation so later changes to tool arguments cannot
 * rewrite the audit event or the mutation being persisted.
 */
export function snapshotRuntimeReplanMutation(
    mutation: RuntimeReplanMutation,
): RuntimeReplanMutation {
    return {
        addedStories: mutation.addedStories.map(snapshotStoryAdd),
        removedStoryIds: [...mutation.removedStoryIds],
        modifiedDeps: Object.fromEntries(
            Object.entries(mutation.modifiedDeps).map(([storyId, dependsOn]) => [
                storyId,
                [...dependsOn],
            ]),
        ),
    }
}

/**
 * Validate and apply one proposed mutation as an all-or-nothing candidate.
 * The input PRD and mutation are never modified. Only stories not marked
 * complete and not listed in `immutableStoryIds` may be removed or rewired.
 */
export function validateRuntimeReplanMutation(
    prd: PrdFile,
    mutation: RuntimeReplanMutation,
    options: RuntimeReplanValidationOptions,
): RuntimeReplanValidationResult {
    const inputFailure = validateInputs(prd, mutation, options)
    if (inputFailure) return inputFailure

    let immutableStoryIds: string[]
    try {
        immutableStoryIds = [...options.immutableStoryIds]
    } catch {
        return reject(
            "invalid_proposal",
            "immutable story ids must be an iterable of strings",
        )
    }
    if (immutableStoryIds.some((storyId) => !validId(storyId))) {
        return reject(
            "invalid_proposal",
            "immutable story ids must be non-empty, trimmed strings",
        )
    }

    const snapshot = snapshotRuntimeReplanMutation(mutation)
    const addedStoryIds = snapshot.addedStories.map((story) => story.id)
    const removedStoryIds = [...snapshot.removedStoryIds]
    const modifiedStoryIds = Object.keys(snapshot.modifiedDeps)

    if (
        addedStoryIds.length === 0 &&
        removedStoryIds.length === 0 &&
        modifiedStoryIds.length === 0
    ) {
        return reject("no_op", "runtime replan mutation contains no operations")
    }

    const currentById = new Map<string, PrdStory>()
    for (const story of prd.userStories) {
        if (currentById.has(story.id)) {
            return reject(
                "duplicate_story",
                `current PRD contains duplicate story id '${story.id}'`,
            )
        }
        currentById.set(story.id, story)
    }

    const duplicateAdded = firstDuplicate(addedStoryIds)
    if (duplicateAdded) {
        return reject(
            "duplicate_story",
            `story '${duplicateAdded}' is added more than once`,
        )
    }
    const duplicateRemoved = firstDuplicate(removedStoryIds)
    if (duplicateRemoved) {
        return reject(
            "duplicate_story",
            `story '${duplicateRemoved}' is removed more than once`,
        )
    }

    const operationsByStory = new Map<string, string>()
    for (const [operation, storyIds] of [
        ["add", addedStoryIds],
        ["remove", removedStoryIds],
        ["modify", modifiedStoryIds],
    ] as const) {
        for (const storyId of storyIds) {
            const previous = operationsByStory.get(storyId)
            if (previous) {
                return reject(
                    "duplicate_story",
                    `story '${storyId}' is targeted by both ${previous} and ${operation}`,
                )
            }
            operationsByStory.set(storyId, operation)
        }
    }

    for (const storyId of addedStoryIds) {
        if (currentById.has(storyId)) {
            return reject(
                "duplicate_story",
                `cannot add existing story '${storyId}'`,
            )
        }
    }
    for (const storyId of [...removedStoryIds, ...modifiedStoryIds]) {
        if (!currentById.has(storyId)) {
            return reject(
                "unknown_story",
                `cannot mutate unknown story '${storyId}'`,
            )
        }
    }

    const immutable = new Set(immutableStoryIds)
    for (const story of prd.userStories) {
        if (story.passes) immutable.add(story.id)
    }
    for (const storyId of [...removedStoryIds, ...modifiedStoryIds]) {
        if (immutable.has(storyId)) {
            return reject(
                "immutable_story",
                `cannot mutate completed or already-started story '${storyId}'`,
            )
        }
    }

    if (snapshot.addedStories.length > options.maxAddedStories) {
        return reject(
            "dynamic_story_limit",
            `proposal adds ${snapshot.addedStories.length} stories but only ${options.maxAddedStories} are allowed`,
        )
    }

    // Removing work without adding a replacement is intentionally fail-closed.
    // A dependency-only rewire does not replace the deleted acceptance scope.
    if (removedStoryIds.length > 0 && addedStoryIds.length === 0) {
        return reject(
            "destructive_removal",
            "runtime replan cannot remove stories without adding replacement work",
        )
    }

    for (const storyId of modifiedStoryIds) {
        const before = currentById.get(storyId)!.dependsOn
        const after = snapshot.modifiedDeps[storyId]
        if (sameStringSet(before, after)) {
            return reject(
                "no_op",
                `dependency mutation for story '${storyId}' makes no change`,
            )
        }
    }

    const removed = new Set(removedStoryIds)
    const candidate = clonePrd(prd)
    candidate.userStories = candidate.userStories
        .filter((story) => !removed.has(story.id))
        .map((story) => {
            const dependsOn = snapshot.modifiedDeps[story.id]
            return dependsOn ? { ...story, dependsOn: [...dependsOn] } : story
        })

    for (const added of snapshot.addedStories) {
        candidate.userStories.push(toPrdStory(added))
    }

    const graphFailure = validateCandidateGraph(candidate)
    if (graphFailure) return graphFailure

    return {
        ok: true,
        prd: candidate,
        addedStoryIds,
        removedStoryIds,
        modifiedStoryIds,
        affectedStoryIds: [
            ...addedStoryIds,
            ...removedStoryIds,
            ...modifiedStoryIds,
        ],
    }
}

function validateInputs(
    prd: PrdFile,
    mutation: RuntimeReplanMutation,
    options: RuntimeReplanValidationOptions,
): RuntimeReplanValidationFailure | null {
    if (!prd || typeof prd !== "object" || !Array.isArray(prd.userStories)) {
        return reject("invalid_proposal", "current PRD is not valid")
    }
    if (
        !mutation ||
        typeof mutation !== "object" ||
        !hasOnlyKeys(mutation as unknown as Record<string, unknown>, [
            "addedStories",
            "removedStoryIds",
            "modifiedDeps",
        ]) ||
        !Array.isArray(mutation.addedStories) ||
        !Array.isArray(mutation.removedStoryIds) ||
        !isPlainRecord(mutation.modifiedDeps)
    ) {
        return reject("invalid_proposal", "runtime replan mutation is malformed")
    }
    if (
        !options ||
        typeof options !== "object" ||
        !Number.isInteger(options.maxAddedStories) ||
        options.maxAddedStories < 0 ||
        !options.immutableStoryIds ||
        typeof options.immutableStoryIds[Symbol.iterator] !== "function"
    ) {
        return reject("invalid_proposal", "runtime replan validation options are malformed")
    }

    for (const story of prd.userStories) {
        if (!validPrdStoryShape(story)) {
            return reject(
                "invalid_proposal",
                "current PRD contains a malformed story",
            )
        }
    }
    for (const added of mutation.addedStories) {
        const issue = validateAddedStoryShape(added)
        if (issue) return reject("invalid_proposal", issue)
        if (isVerificationOnlyStory(added)) {
            return reject(
                "invalid_proposal",
                `added story '${added.id}' is verification-only; final test/build/lint gates belong to RunVerifier`,
            )
        }
    }
    for (const storyId of mutation.removedStoryIds) {
        if (!validId(storyId)) {
            return reject(
                "invalid_proposal",
                "removed story ids must be non-empty, trimmed strings",
            )
        }
    }
    for (const [storyId, dependsOn] of Object.entries(mutation.modifiedDeps)) {
        if (!validId(storyId) || !validStringArray(dependsOn, true)) {
            return reject(
                "invalid_proposal",
                "modified dependencies must map a valid story id to valid story ids",
            )
        }
    }
    return null
}

function validateCandidateGraph(
    candidate: PrdFile,
): RuntimeReplanValidationFailure | null {
    const storyIds = new Set(candidate.userStories.map((story) => story.id))

    for (const story of candidate.userStories) {
        const duplicate = firstDuplicate(story.dependsOn)
        if (duplicate) {
            return reject(
                "duplicate_dependency",
                `story '${story.id}' depends on '${duplicate}' more than once`,
            )
        }
        for (const dependency of story.dependsOn) {
            if (dependency === story.id) {
                return reject(
                    "self_dependency",
                    `story '${story.id}' cannot depend on itself`,
                )
            }
            if (!storyIds.has(dependency)) {
                return reject(
                    "unknown_dependency",
                    `story '${story.id}' depends on unknown story '${dependency}'`,
                )
            }
        }
    }

    try {
        buildDag(candidate.userStories)
    } catch {
        return reject(
            "dependency_cycle",
            "runtime replan candidate contains a dependency cycle",
        )
    }
    return null
}

function validateAddedStoryShape(story: ReplanStoryAdd): string | null {
    if (!story || typeof story !== "object") return "added story is malformed"
    if (
        !hasOnlyKeys(story as unknown as Record<string, unknown>, [
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
    ) return `added story '${story.id || "(missing)"}' has unknown fields`
    if (!validId(story.id)) return "added story id must be a non-empty, trimmed string"
    if (!Number.isFinite(story.priority)) return `added story '${story.id}' has invalid priority`
    if (!validNonBlankString(story.title)) return `added story '${story.id}' has invalid title`
    if (!validNonBlankString(story.description)) {
        return `added story '${story.id}' has invalid description`
    }
    if (!validStringArray(story.dependsOn, true)) {
        return `added story '${story.id}' has malformed dependencies`
    }
    if (story.retries !== undefined && (!Number.isInteger(story.retries) || story.retries < 0)) {
        return `added story '${story.id}' has invalid retries`
    }
    if (story.acceptance !== undefined && !validStringArray(story.acceptance, false)) {
        return `added story '${story.id}' has malformed acceptance criteria`
    }
    if (story.tests !== undefined && !validStringArray(story.tests, false)) {
        return `added story '${story.id}' has malformed tests`
    }
    if (story.model !== undefined && !validNonBlankString(story.model)) {
        return `added story '${story.id}' has invalid model`
    }
    return null
}

function validPrdStoryShape(story: PrdStory): boolean {
    return (
        !!story &&
        typeof story === "object" &&
        validId(story.id) &&
        Number.isFinite(story.priority) &&
        typeof story.title === "string" &&
        typeof story.description === "string" &&
        validStringArray(story.dependsOn, true) &&
        Number.isInteger(story.retries) &&
        story.retries >= 0 &&
        validStringArray(story.acceptance, false) &&
        validStringArray(story.tests, false) &&
        typeof story.passes === "boolean" &&
        (story.completedAt === null || typeof story.completedAt === "string") &&
        (story.durationSecs === null || Number.isFinite(story.durationSecs)) &&
        (story.model === undefined || typeof story.model === "string")
    )
}

function clonePrd(prd: PrdFile): PrdFile {
    return {
        ...prd,
        ...(prd.executionMode
            ? { executionMode: { ...prd.executionMode } }
            : {}),
        userStories: prd.userStories.map((story) => ({
            ...story,
            dependsOn: [...story.dependsOn],
            acceptance: [...story.acceptance],
            tests: [...story.tests],
        })),
    }
}

function toPrdStory(story: ReplanStoryAdd): PrdStory {
    return {
        id: story.id,
        priority: story.priority,
        title: story.title,
        description: story.description,
        dependsOn: [...story.dependsOn],
        retries: story.retries ?? 2,
        acceptance: story.acceptance ? [...story.acceptance] : [],
        tests: story.tests ? [...story.tests] : [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: story.model,
    }
}

function snapshotStoryAdd(story: ReplanStoryAdd): ReplanStoryAdd {
    return {
        id: story.id,
        priority: story.priority,
        title: story.title,
        description: story.description,
        dependsOn: [...story.dependsOn],
        ...(story.retries !== undefined ? { retries: story.retries } : {}),
        ...(story.acceptance !== undefined
            ? { acceptance: [...story.acceptance] }
            : {}),
        ...(story.tests !== undefined ? { tests: [...story.tests] } : {}),
        ...(story.model !== undefined ? { model: story.model } : {}),
    }
}

function reject(
    code: RuntimeReplanRejectionCode,
    reason: string,
): RuntimeReplanValidationFailure {
    return { ok: false, code, reason }
}

function firstDuplicate(values: readonly string[]): string | null {
    const seen = new Set<string>()
    for (const value of values) {
        if (seen.has(value)) return value
        seen.add(value)
    }
    return null
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false
    const rightSet = new Set(right)
    return left.every((value) => rightSet.has(value))
}

function validId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.trim() === value
    )
}

function validNonBlankString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function validStringArray(value: unknown, ids: boolean): value is string[] {
    return (
        Array.isArray(value) &&
        value.every((item) =>
            ids ? validId(item) : typeof item === "string",
        )
    )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const keys = new Set(allowed)
    return Object.keys(value).every((key) => keys.has(key))
}
