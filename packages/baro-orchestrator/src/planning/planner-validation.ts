import {
    MAX_STORY_PRIORITY,
    MAX_STORY_RETRIES,
    MIN_STORY_PRIORITY,
} from "../prd.js"

const STORY_TIERS = new Set(["light", "standard", "heavy"])

/**
 * Shared fail-closed boundary for every Planner backend. Provider-specific
 * parsers may extract JSON differently, but no plan reaches mode enforcement
 * or execution without satisfying the same runnable contract.
 */
export function assertRunnablePlannerPrdJson(json: string): string {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("final PRD must be a JSON object")
    }
    const prd = parsed as Record<string, unknown>
    requireNonEmptyString(prd.project, "final PRD is missing a non-empty project")
    requireNonEmptyString(
        prd.branchName,
        "final PRD is missing a non-empty branchName",
    )
    requireNonEmptyString(
        prd.description,
        "final PRD is missing a non-empty description",
    )
    if (!Array.isArray(prd.userStories) || prd.userStories.length === 0) {
        throw new Error("final PRD must contain at least one user story")
    }

    const stories = prd.userStories as unknown[]
    const ids = new Set<string>()
    const dependencies = new Map<string, string[]>()
    for (const [index, value] of stories.entries()) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`final PRD story ${index + 1} is not an object`)
        }
        const story = value as Record<string, unknown>
        const id = requireNonEmptyString(
            story.id,
            `final PRD story ${index + 1} is missing an id`,
        )
        if (id !== id.trim()) {
            throw new Error(`final PRD story id '${id}' must be trimmed`)
        }
        if (ids.has(id)) {
            throw new Error(`invalid planner DAG: duplicate story id '${id}'`)
        }
        ids.add(id)
        requireNonEmptyString(
            story.title,
            `final PRD story ${id} is missing a title`,
        )
        requireNonEmptyString(
            story.description,
            `final PRD story ${id} is missing a non-empty description`,
        )
        if (
            !Number.isInteger(story.priority) ||
            Number(story.priority) < MIN_STORY_PRIORITY ||
            Number(story.priority) > MAX_STORY_PRIORITY
        ) {
            throw new Error(`final PRD story ${id} has an invalid i32 priority`)
        }
        if (
            !Number.isInteger(story.retries) ||
            Number(story.retries) < 0 ||
            Number(story.retries) > MAX_STORY_RETRIES
        ) {
            throw new Error(
                `final PRD story ${id} retries must be an integer between 0 and ${MAX_STORY_RETRIES}`,
            )
        }
        if (typeof story.model !== "string" || !STORY_TIERS.has(story.model)) {
            throw new Error(
                `final PRD story ${id} model must be 'light', 'standard', or 'heavy'`,
            )
        }

        const dependsOn = requireStringArray(story, id, "dependsOn", true)
        requireStringArray(story, id, "acceptance", false)
        requireStringArray(story, id, "tests", false)
        if (story.goalInvariantIds !== undefined) {
            const goalInvariantIds = requireStringArray(
                story,
                id,
                "goalInvariantIds",
                true,
            )
            if (
                goalInvariantIds.some(
                    (invariantId) => !/^G-[AC][1-9]\d*$/.test(invariantId),
                )
            ) {
                throw new Error(
                    `final PRD story ${id} contains an invalid goalInvariantIds entry`,
                )
            }
            if (new Set(goalInvariantIds).size !== goalInvariantIds.length) {
                throw new Error(
                    `final PRD story ${id} has duplicate goalInvariantIds`,
                )
            }
        }
        if (new Set(dependsOn).size !== dependsOn.length) {
            throw new Error(`invalid planner DAG: story '${id}' has duplicate dependencies`)
        }
        if (dependsOn.includes(id)) {
            throw new Error(`invalid planner DAG: story '${id}' depends on itself`)
        }
        dependencies.set(id, dependsOn)
    }

    for (const [id, storyDependencies] of dependencies) {
        for (const dependency of storyDependencies) {
            if (!ids.has(dependency)) {
                throw new Error(
                    `invalid planner DAG: story '${id}' depends on unknown story '${dependency}'`,
                )
            }
        }
    }
    assertAcyclic(dependencies)
    return json
}

function requireNonEmptyString(value: unknown, error: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(error)
    return value
}

function requireStringArray(
    story: Record<string, unknown>,
    id: string,
    field: "dependsOn" | "acceptance" | "tests" | "goalInvariantIds",
    allowEmpty: boolean,
): string[] {
    const value = story[field]
    if (!Array.isArray(value)) {
        throw new Error(`final PRD story ${id} is missing ${field}`)
    }
    if (!value.every((item) => typeof item === "string")) {
        throw new Error(`final PRD story ${id} has non-string values in ${field}`)
    }
    const strings = value as string[]
    if ((!allowEmpty && strings.length === 0) || strings.some((item) => !item.trim())) {
        throw new Error(`final PRD story ${id} must contain non-empty ${field}`)
    }
    return strings
}

function assertAcyclic(dependencies: ReadonlyMap<string, readonly string[]>): void {
    const completed = new Set<string>()
    while (completed.size < dependencies.size) {
        const ready = [...dependencies].filter(
            ([id, deps]) =>
                !completed.has(id) && deps.every((dependency) => completed.has(dependency)),
        )
        if (ready.length === 0) {
            throw new Error("invalid planner DAG: dependency cycle detected")
        }
        for (const [id] of ready) completed.add(id)
    }
}
