import type { PrdFile, PrdStory } from "../prd.js"
import type { GoalContract } from "../runtime/goal-contract.js"

export const ARCHITECTURE_OBLIGATION_SCHEMA_VERSION = 1 as const
export const ARCHITECTURE_OBLIGATION_FENCE = "baro-obligations-v1"

const MAX_OBLIGATIONS = 128
const MAX_INVARIANTS_PER_OBLIGATION = 32
const MAX_EVIDENCE_ITEMS = 8
const MAX_FIELD_CHARS = 2_000
const MAX_EVIDENCE_CHARS = 1_000
const OBLIGATION_ID = /^O-(\d{3})$/u
const GOAL_INVARIANT_ID = /^G-[AC][1-9]\d*$/u
// Reserve the complete [O-*] namespace. Any claimed obligation that is not
// byte-for-byte canonical must fail closed, regardless of the punctuation a
// provider puts after the closing bracket.
const OBLIGATION_CRITERION_PREFIX = /^\[O-[^\]]+\]/u

export interface ArchitectureObligationV1 {
    id: string
    invariantIds: readonly string[]
    subject: string
    scenario: string
    expectedOutcome: string
    evidence: readonly string[]
}

export interface ArchitectureObligationContractV1 {
    schemaVersion: typeof ARCHITECTURE_OBLIGATION_SCHEMA_VERSION
    obligations: readonly ArchitectureObligationV1[]
}

export interface StoryObligationMapping {
    storyId: string
    acceptance: readonly string[]
    invariantIds: readonly string[]
}

export type ArchitectureObligationCoverageMode = "partial" | "complete"

export interface ArchitectureObligationCoverageResult {
    coveredObligationIds: readonly string[]
    missingObligationIds: readonly string[]
}

export class ArchitectureObligationContractError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ArchitectureObligationContractError"
    }
}

/**
 * Read the optional machine-checkable appendix from an Architect decision
 * document. Documents produced before this contract remain valid and return
 * null. A present marker is fail-closed: malformed or repeated blocks never
 * silently fall back to legacy planning.
 */
export function parseArchitectureObligationContract(
    decisionDocument: string | null | undefined,
): ArchitectureObligationContractV1 | null {
    if (decisionDocument == null || !decisionDocument.includes(ARCHITECTURE_OBLIGATION_FENCE)) {
        return null
    }
    const expression =
        /(?:^|\n)```baro-obligations-v1[ \t]*\n([\s\S]*?)\n```(?=\n|$)/gu
    const matches = [...decisionDocument.replace(/\r\n?/gu, "\n").matchAll(expression)]
    if (matches.length !== 1) {
        throw new ArchitectureObligationContractError(
            `decision document must contain exactly one well-formed ${ARCHITECTURE_OBLIGATION_FENCE} block`,
        )
    }
    let value: unknown
    try {
        value = JSON.parse(matches[0]![1]!)
    } catch {
        throw new ArchitectureObligationContractError(
            `${ARCHITECTURE_OBLIGATION_FENCE} block is not valid JSON`,
        )
    }
    return validateArchitectureObligationContract(value)
}

/** Validate parent ids against the host-owned goal, never provider JSON. */
export function bindArchitectureObligationContract(
    contract: ArchitectureObligationContractV1 | null,
    goal: GoalContract | null | undefined,
): ArchitectureObligationContractV1 | null {
    if (!contract || !goal) return null
    const known = new Set(goal.invariants.map(({ id }) => id))
    const covered = new Set<string>()
    for (const obligation of contract.obligations) {
        const unknown = obligation.invariantIds.filter((id) => !known.has(id))
        if (unknown.length > 0) {
            throw new ArchitectureObligationContractError(
                `architecture obligation ${obligation.id} references unknown GoalContract invariant(s): ${unknown.join(", ")}`,
            )
        }
        for (const id of obligation.invariantIds) covered.add(id)
    }
    const missing = goal.invariants
        .map(({ id }) => id)
        .filter((id) => !covered.has(id))
    if (missing.length > 0) {
        throw new ArchitectureObligationContractError(
            `architecture obligation contract does not refine GoalContract invariant(s): ${missing.join(", ")}`,
        )
    }
    return contract
}

export function architectureObligationsFromDecision(
    decisionDocument: string | null | undefined,
    goal: GoalContract | null | undefined,
): ArchitectureObligationContractV1 | null {
    return bindArchitectureObligationContract(
        parseArchitectureObligationContract(decisionDocument),
        goal,
    )
}

/** Stable exact criterion carried through the existing PRD acceptance array. */
export function renderArchitectureObligationCriterion(
    obligation: ArchitectureObligationV1,
): string {
    return [
        `[${obligation.id}]`,
        `Subject: ${obligation.subject}`,
        `Scenario: ${obligation.scenario}`,
        `Required outcome: ${obligation.expectedOutcome}`,
        `Required evidence: ${obligation.evidence.join(" | ")}`,
    ].join("; ")
}

/**
 * Require exact, single-owner propagation into stories. Partial mode permits
 * obligations to arrive in later progressive fragments but still rejects
 * unknown/tampered claims and duplicate owners in the supplied graph.
 */
export function validateArchitectureObligationCoverage(
    contract: ArchitectureObligationContractV1 | null | undefined,
    mappings: readonly StoryObligationMapping[],
    mode: ArchitectureObligationCoverageMode,
): ArchitectureObligationCoverageResult {
    if (!contract) {
        return { coveredObligationIds: [], missingObligationIds: [] }
    }
    const byCriterion = new Map(
        contract.obligations.map((obligation) => [
            renderArchitectureObligationCriterion(obligation),
            obligation,
        ] as const),
    )
    const byId = new Map(contract.obligations.map((obligation) => [obligation.id, obligation]))
    const owners = new Map<string, string>()

    for (const mapping of mappings) {
        const storyInvariantIds = new Set(mapping.invariantIds)
        for (const criterion of mapping.acceptance) {
            const exact = byCriterion.get(criterion)
            if (!exact) {
                if (OBLIGATION_CRITERION_PREFIX.test(criterion)) {
                    const id = criterion.match(/^\[([^\]]+)\]/u)?.[1] ?? "unknown"
                    throw new ArchitectureObligationContractError(
                        byId.has(id)
                            ? `story ${mapping.storyId} altered canonical architecture obligation ${id}`
                            : `story ${mapping.storyId} claims unknown architecture obligation ${id}`,
                    )
                }
                continue
            }
            const previousOwner = owners.get(exact.id)
            if (previousOwner) {
                throw new ArchitectureObligationContractError(
                    `architecture obligation ${exact.id} has multiple evidence owners: ${previousOwner}, ${mapping.storyId}`,
                )
            }
            const missingParents = exact.invariantIds.filter(
                (id) => !storyInvariantIds.has(id),
            )
            if (missingParents.length > 0) {
                throw new ArchitectureObligationContractError(
                    `story ${mapping.storyId} owns ${exact.id} but omits parent GoalContract invariant(s): ${missingParents.join(", ")}`,
                )
            }
            owners.set(exact.id, mapping.storyId)
        }
    }

    const coveredObligationIds = contract.obligations
        .map(({ id }) => id)
        .filter((id) => owners.has(id))
    const missingObligationIds = contract.obligations
        .map(({ id }) => id)
        .filter((id) => !owners.has(id))
    if (mode === "complete" && missingObligationIds.length > 0) {
        throw new ArchitectureObligationContractError(
            `architecture obligation coverage is incomplete; no story owns: ${missingObligationIds.join(", ")}`,
        )
    }
    return { coveredObligationIds, missingObligationIds }
}

export function obligationMappingsForStories(
    stories: readonly Pick<PrdStory, "id" | "acceptance" | "goalInvariantIds">[],
): StoryObligationMapping[] {
    return stories.map((story) => ({
        storyId: story.id,
        acceptance: story.acceptance,
        invariantIds: story.goalInvariantIds ?? [],
    }))
}

/**
 * Validate a persisted execution snapshot, not only the Planner response that
 * originally produced it. A present obligation appendix without its trusted
 * GoalContract is invalid; progressive plans may be incomplete only while
 * their durable planning latch is still open.
 */
export function validatePrdArchitectureObligationCoverage(
    prd: Pick<PrdFile, "decisionDocument" | "userStories">,
    goal: GoalContract | null | undefined,
    mode: ArchitectureObligationCoverageMode,
): ArchitectureObligationCoverageResult {
    const parsed = parseArchitectureObligationContract(prd.decisionDocument)
    if (!parsed) {
        return { coveredObligationIds: [], missingObligationIds: [] }
    }
    if (!goal) {
        throw new ArchitectureObligationContractError(
            "persisted architecture obligations require a trusted GoalContract",
        )
    }
    return validateArchitectureObligationCoverage(
        bindArchitectureObligationContract(parsed, goal),
        obligationMappingsForStories(prd.userStories),
        mode,
    )
}

function validateArchitectureObligationContract(
    value: unknown,
): ArchitectureObligationContractV1 {
    if (!exactRecord(value, ["schemaVersion", "obligations"])) {
        throw new ArchitectureObligationContractError(
            "architecture obligation contract must use the exact v1 schema",
        )
    }
    if (value.schemaVersion !== ARCHITECTURE_OBLIGATION_SCHEMA_VERSION) {
        throw new ArchitectureObligationContractError(
            "unsupported architecture obligation schemaVersion",
        )
    }
    if (
        !Array.isArray(value.obligations) ||
        value.obligations.length === 0 ||
        value.obligations.length > MAX_OBLIGATIONS
    ) {
        throw new ArchitectureObligationContractError(
            `architecture obligations must contain 1-${MAX_OBLIGATIONS} entries`,
        )
    }
    const obligations = value.obligations.map((candidate, index) => {
        if (!exactRecord(candidate, [
            "id",
            "invariantIds",
            "subject",
            "scenario",
            "expectedOutcome",
            "evidence",
        ])) {
            throw new ArchitectureObligationContractError(
                `architecture obligation ${index + 1} must use the exact v1 shape`,
            )
        }
        const id = boundedText(candidate.id, 16, `architecture obligation ${index + 1} id`)
        const match = OBLIGATION_ID.exec(id)
        const expectedId = `O-${String(index + 1).padStart(3, "0")}`
        if (!match || id !== expectedId) {
            throw new ArchitectureObligationContractError(
                `architecture obligation ${index + 1} id must be ${expectedId}`,
            )
        }
        if (
            !Array.isArray(candidate.invariantIds) ||
            candidate.invariantIds.length === 0 ||
            candidate.invariantIds.length > MAX_INVARIANTS_PER_OBLIGATION ||
            candidate.invariantIds.some(
                (item) => typeof item !== "string" || !GOAL_INVARIANT_ID.test(item),
            ) ||
            new Set(candidate.invariantIds).size !== candidate.invariantIds.length
        ) {
            throw new ArchitectureObligationContractError(
                `architecture obligation ${id} has invalid invariantIds`,
            )
        }
        if (
            !Array.isArray(candidate.evidence) ||
            candidate.evidence.length === 0 ||
            candidate.evidence.length > MAX_EVIDENCE_ITEMS
        ) {
            throw new ArchitectureObligationContractError(
                `architecture obligation ${id} requires 1-${MAX_EVIDENCE_ITEMS} evidence entries`,
            )
        }
        const evidence = candidate.evidence.map((item, evidenceIndex) =>
            boundedText(
                item,
                MAX_EVIDENCE_CHARS,
                `architecture obligation ${id} evidence ${evidenceIndex + 1}`,
            ),
        )
        if (new Set(evidence).size !== evidence.length) {
            throw new ArchitectureObligationContractError(
                `architecture obligation ${id} has duplicate evidence entries`,
            )
        }
        return {
            id,
            invariantIds: [...candidate.invariantIds] as string[],
            subject: boundedText(candidate.subject, MAX_FIELD_CHARS, `${id} subject`),
            scenario: boundedText(candidate.scenario, MAX_FIELD_CHARS, `${id} scenario`),
            expectedOutcome: boundedText(
                candidate.expectedOutcome,
                MAX_FIELD_CHARS,
                `${id} expectedOutcome`,
            ),
            evidence,
        }
    })
    return deepFreeze({
        schemaVersion: ARCHITECTURE_OBLIGATION_SCHEMA_VERSION,
        obligations,
    })
}

function boundedText(value: unknown, maximum: number, label: string): string {
    if (typeof value !== "string") {
        throw new ArchitectureObligationContractError(`${label} must be a string`)
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        throw new ArchitectureObligationContractError(`${label} contains unsafe characters`)
    }
    const normalized = value.replace(/\s+/gu, " ").trim()
    if (
        normalized.length === 0 ||
        normalized.length > maximum
    ) {
        throw new ArchitectureObligationContractError(
            `${label} is empty, too long, or unsafe`,
        )
    }
    return normalized
}

function exactRecord(
    value: unknown,
    keys: readonly string[],
): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const actual = Object.keys(value)
    return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child)
        }
        Object.freeze(value)
    }
    return value
}
