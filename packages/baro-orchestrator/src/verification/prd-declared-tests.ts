/** Raw PRD inspection for verification requirements.
 *
 * loadPrd intentionally normalizes legacy data. Final verification must be
 * stricter: malformed or missing `tests` fields are objective unknowns, not an
 * empty list that can silently pass green.
 */

import { readFileSync } from "node:fs"

import type { DeclaredTestBudgetRequest } from "./declared-test-budget.js"
import type { DeclaredTestRequirement } from "./verify.js"

const MAX_STORIES_INSPECTED = 256
const MAX_REQUIREMENTS_RETURNED = 64

export function readAuthoritativeDeclaredTests(
    prdPath: string,
): DeclaredTestRequirement[] {
    return readAuthoritativeVerifyPlanOptions(prdPath).declaredTests
}

export function readAuthoritativeVerifyPlanOptions(prdPath: string): {
    declaredTests: DeclaredTestRequirement[]
    testBudgets: DeclaredTestBudgetRequest[]
    /** Stories the run never executed; their tests are not requirements of this tree. */
    notStartedStoryIds: string[]
} {
    let raw: unknown
    try {
        raw = JSON.parse(readFileSync(prdPath, "utf8")) as unknown
    } catch (error) {
        return {
            declaredTests: [
                issue("final PRD", "<unreadable>", `cannot read final PRD: ${message(error)}`),
            ],
            testBudgets: [],
            notStartedStoryIds: [],
        }
    }
    if (!isRecord(raw) || !Array.isArray(raw.userStories)) {
        return {
            declaredTests: [
                issue(
                    "final PRD",
                    "userStories",
                    "final PRD userStories must be an array",
                ),
            ],
            testBudgets: [],
            notStartedStoryIds: [],
        }
    }

    // A story the progressive planner never admitted (replanned in after the
    // run stopped, or removed) contributed no code, so its declared tests are
    // not requirements of this tree; counting them made a green tree
    // "incomplete" (#175). Executed stories are always kept.
    const admitted = admittedStoryIds(raw)
    const notStartedStoryIds: string[] = []
    const stories = raw.userStories.slice(0, MAX_STORIES_INSPECTED).filter((value, index) => {
        if (admitted === null || !isRecord(value)) return true
        const id = storyIdOf(value, index)
        const executed =
            value.passes === true ||
            typeof value.mergeStatus === "string" ||
            typeof value.completedAt === "string"
        if (executed || admitted.has(id)) return true
        notStartedStoryIds.push(id)
        return false
    })
    // Separate pass so requirement overflow below cannot hide a budget request.
    const testBudgets: DeclaredTestBudgetRequest[] = []
    for (const [storyIndex, value] of stories.entries()) {
        if (isRecord(value) && Object.hasOwn(value, "testBudget")) {
            testBudgets.push({
                storyId: storyIdOf(value, storyIndex),
                testBudget: value.testBudget,
            })
        }
    }

    const requirements: DeclaredTestRequirement[] = []
    for (const [storyIndex, value] of stories.entries()) {
        if (requirements.length >= MAX_REQUIREMENTS_RETURNED - 1) {
            requirements.push(inspectionOverflow())
            return { declaredTests: requirements, testBudgets, notStartedStoryIds }
        }
        const storyId = storyIdOf(value, storyIndex)
        if (!isRecord(value)) {
            requirements.push(
                issue(storyId, "tests", `${storyId} must be an object with a tests array`),
            )
            continue
        }
        if (!("tests" in value) || !Array.isArray(value.tests)) {
            requirements.push(
                issue(storyId, "tests", `${storyId}.tests must be an array of strings`),
            )
            continue
        }
        for (const [testIndex, command] of value.tests.entries()) {
            if (requirements.length >= MAX_REQUIREMENTS_RETURNED - 1) {
                requirements.push(inspectionOverflow())
                return { declaredTests: requirements, testBudgets, notStartedStoryIds }
            }
            if (typeof command === "string") {
                requirements.push({ storyId, command })
            } else {
                requirements.push(
                    issue(
                        storyId,
                        `tests[${testIndex}]`,
                        `${storyId}.tests[${testIndex}] must be a string`,
                    ),
                )
            }
        }
    }
    if (raw.userStories.length > MAX_STORIES_INSPECTED) {
        requirements.push(inspectionOverflow())
    }
    return { declaredTests: requirements, testBudgets, notStartedStoryIds }
}

/** The progressive planner's admission ledger, or null when this PRD has none
 *  (legacy complete-plan runs execute every story). */
function admittedStoryIds(raw: Record<string, unknown>): Set<string> | null {
    const graph = raw.runtimeGraph
    if (!isRecord(graph) || !isRecord(graph.planning)) return null
    const ids = graph.planning.admittedStoryIds
    if (!Array.isArray(ids)) return null
    return new Set(ids.filter((id): id is string => typeof id === "string"))
}

function storyIdOf(value: unknown, storyIndex: number): string {
    return isRecord(value) && typeof value.id === "string"
        ? safeEvidenceText(value.id, 100)
        : `userStories[${storyIndex}]`
}

function inspectionOverflow(): DeclaredTestRequirement {
    return issue(
        "final PRD",
        "inspection overflow",
        "final PRD exceeds the bounded raw story/test inspection budget",
    )
}

function issue(
    storyId: string,
    command: string,
    declarationError: string,
): DeclaredTestRequirement {
    return { storyId, command, declarationError }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function message(error: unknown): string {
    return safeEvidenceText(
        error instanceof Error ? error.message : String(error),
        500,
    )
}

function safeEvidenceText(value: string, limit: number): string {
    return value
        .slice(0, limit)
        .replace(/[\u0000-\u001f\u007f`]/g, "?")
}
