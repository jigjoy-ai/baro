import type { PrdFile, PrdStory } from "../../prd.js"
import type { GoalContract } from "../../goal/goal-contract.js"

export const ARCHITECTURE_OBLIGATION_SCHEMA_VERSION = 1 as const
export const ARCHITECTURE_OBLIGATION_FENCE = "baro-obligations-v1"
export const MAX_ARCHITECTURE_OBLIGATIONS = 128
export const MAX_ARCHITECTURE_DECISION_DOCUMENT_BYTES = 96 * 1024

/** True only for an opening fenced appendix, not a prose protocol reference. */
export function hasArchitectureObligationFence(document: string): boolean {
    return /(?:^|\n)```baro-obligations-v1[ \t]*(?:\n|$)/u.test(
        document.replace(/\r\n?/gu, "\n"),
    )
}

const MAX_INVARIANTS_PER_OBLIGATION = 32
const MAX_EVIDENCE_ITEMS = 8
const MAX_FIELD_CHARS = 2_000
const MAX_EVIDENCE_CHARS = 1_000
const OBLIGATION_ID = /^O-(\d{3})$/u
const GOAL_INVARIANT_ID = /^G-[AC][1-9]\d*$/u
// Reserve the complete [O-*] namespace anywhere in an acceptance string. Any
// claimed obligation that is not byte-for-byte canonical must fail closed,
// including provider-added prose before or after the canonical criterion.
const OBLIGATION_CRITERION_CLAIM = /\[(O-[^\]]+)\]/u
const MAX_REPORTED_VIOLATION_DETAILS = 12

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

export type ObligationNoteKind =
    | "canonicalized_obligation_criterion"
    | "completed_obligation_parent_invariants"

export interface ObligationNote {
    readonly severity: "warn"
    readonly kind: ObligationNoteKind
    readonly storyId: string
    readonly obligationId: string
    readonly detail: string
}

export type ObligationNoteSink = (note: ObligationNote) => void

export type ArchitectureObligationViolationKind =
    | "unknown_obligation"
    | "compound_claim"
    | "altered_canonical"
    | "duplicate_owner"
    | "missing_parent_invariants"
    | "unowned_obligation"

export interface ArchitectureObligationViolation {
    readonly kind: ArchitectureObligationViolationKind
    /** "" for unowned_obligation: no story reached the criterion. */
    readonly storyId: string
    readonly obligationId: string
    readonly detail: string
}

export class ArchitectureObligationContractError extends Error {
    /** Populated only by the incomplete-coverage throw; empty elsewhere. */
    readonly missingObligationIds: readonly string[]
    readonly violations: readonly ArchitectureObligationViolation[]

    constructor(
        message: string,
        missingObligationIds: readonly string[] = [],
        violations: readonly ArchitectureObligationViolation[] = [],
    ) {
        super(message)
        this.name = "ArchitectureObligationContractError"
        this.missingObligationIds = missingObligationIds
        this.violations = violations
    }
}

export function missingObligationIdsFromError(error: unknown): readonly string[] {
    return error instanceof ArchitectureObligationContractError
        ? error.missingObligationIds
        : []
}

export function violationsFromError(
    error: unknown,
): readonly ArchitectureObligationViolation[] {
    return error instanceof ArchitectureObligationContractError
        ? error.violations
        : []
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
    if (
        decisionDocument == null ||
        !hasArchitectureObligationFence(decisionDocument)
    ) {
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

/**
 * Append one canonical machine-readable obligation appendix to an ADR-only
 * decision document. The input document must not already mention the reserved
 * fence: accepting and replacing a model-authored appendix would make it
 * ambiguous which contract downstream consumers are meant to trust.
 */
export function attachArchitectureObligationContract(
    decisionDocument: string,
    contract: ArchitectureObligationContractV1,
): string {
    if (typeof decisionDocument !== "string" || decisionDocument.trim().length === 0) {
        throw new ArchitectureObligationContractError(
            "architecture decision document must be non-empty text",
        )
    }
    if (hasArchitectureObligationFence(decisionDocument)) {
        throw new ArchitectureObligationContractError(
            `architecture decision document already contains the reserved ${ARCHITECTURE_OBLIGATION_FENCE} fence`,
        )
    }
    const validated = validateArchitectureObligationContract(contract)
    const attached = [
        decisionDocument.trimEnd(),
        "",
        `\`\`\`${ARCHITECTURE_OBLIGATION_FENCE}`,
        JSON.stringify(validated),
        "\`\`\`",
    ].join("\n")
    const bytes = Buffer.byteLength(attached, "utf8")
    if (bytes > MAX_ARCHITECTURE_DECISION_DOCUMENT_BYTES) {
        throw new ArchitectureObligationContractError(
            `architecture decision document is ${bytes} bytes after attaching obligations; limit is ${MAX_ARCHITECTURE_DECISION_DOCUMENT_BYTES}`,
        )
    }
    return attached
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
 * Restore host-owned criterion text on acceptance entries that claim a KNOWN
 * obligation id. The claim (which obligation a story owns) is the model's
 * decision; the criterion text is canonical and never the model's to edit —
 * planners routinely paraphrase it, and a paraphrase must not kill a plan
 * when the exact text is deterministically recoverable. Claims of unknown
 * ids are left untouched for the validator to reject, and duplicate claims
 * of one obligation within a story collapse to a single canonical entry.
 *
 * `invariantIds` is the union of parent invariants implied by those claims.
 * WHICH obligations a story owns is the model's decision; which invariants
 * they descend from is a host fact already recorded in the contract. Making
 * the planner transcribe it only creates a way to omit one and kill a plan
 * that is otherwise coherent, so callers fold this in instead.
 */
export function canonicalObligationAcceptance(
    contract: ArchitectureObligationContractV1 | null | undefined,
    acceptance: readonly string[],
): { acceptance: string[]; invariantIds: string[]; changed: boolean } {
    if (!contract) {
        return { acceptance: [...acceptance], invariantIds: [], changed: false }
    }
    const byId = new Map(
        contract.obligations.map((obligation) => [obligation.id, obligation]),
    )
    const claimed = new Set<string>()
    const invariantIds: string[] = []
    const result: string[] = []
    let changed = false
    for (const criterion of acceptance) {
        const claim = OBLIGATION_CRITERION_CLAIM.exec(criterion)
        // A compound claim ("[O-015/O-022]") is the same class of mistake as
        // a paraphrase: WHICH obligations are meant is legible and the text
        // is deterministically recoverable, so it expands to one canonical
        // criterion per id. Any unknown part makes the whole claim
        // fabrication and it stays untouched for the validator.
        const claimedIds = claim ? splitClaimedObligationIds(claim[1] ?? "") : []
        const obligations = claimedIds.map((id) => byId.get(id))
        if (obligations.length === 0 || obligations.some((o) => o === undefined)) {
            result.push(criterion)
            continue
        }
        if (obligations.length > 1) changed = true
        for (const obligation of obligations as ArchitectureObligationV1[]) {
            if (claimed.has(obligation.id)) {
                changed = true
                continue
            }
            claimed.add(obligation.id)
            for (const invariantId of obligation.invariantIds) {
                if (!invariantIds.includes(invariantId)) invariantIds.push(invariantId)
            }
            const canonical = renderArchitectureObligationCriterion(obligation)
            if (canonical !== criterion) changed = true
            result.push(canonical)
        }
    }
    return { acceptance: result, invariantIds, changed }
}

/** "O-015/O-022", "O-015, O-022" → the individual ids; [] unless every part is an id. */
function splitClaimedObligationIds(raw: string): string[] {
    const parts = raw.split(/[\s/,+&]+/u).filter(Boolean)
    if (parts.length === 0) return []
    return parts.every((part) => OBLIGATION_ID.test(part)) ? parts : []
}

/** Union the parent invariants a story's claims imply into what it declared. */
export function completeImpliedInvariantIds(
    declared: readonly string[] | undefined,
    implied: readonly string[],
): string[] {
    const result = [...(declared ?? [])]
    for (const invariantId of implied) {
        if (!result.includes(invariantId)) result.push(invariantId)
    }
    return result
}

/** Idempotent host-side repair of known claims, announced through `onNote`. */
export function canonicalizeObligationMappings(
    contract: ArchitectureObligationContractV1,
    mappings: readonly StoryObligationMapping[],
    onNote?: ObligationNoteSink,
): readonly StoryObligationMapping[] {
    const byId = new Map(
        contract.obligations.map((obligation) => [obligation.id, obligation] as const),
    )
    const announced = new Set<string>()
    const note = (
        kind: ObligationNoteKind,
        storyId: string,
        obligationId: string,
        detail: string,
    ): void => {
        if (!onNote) return
        const key = `${storyId} ${obligationId} ${kind}`
        if (announced.has(key)) return
        announced.add(key)
        onNote({ severity: "warn", kind, storyId, obligationId, detail })
    }
    return mappings.map((mapping) => {
        const declared = new Set(mapping.invariantIds)
        const implied: string[] = []
        const acceptance: string[] = []
        let rewritten = false
        for (const criterion of mapping.acceptance) {
            const claim = OBLIGATION_CRITERION_CLAIM.exec(criterion)
            const claimedIds = claim ? splitClaimedObligationIds(claim[1] ?? "") : []
            const obligation =
                claimedIds.length === 1 ? byId.get(claimedIds[0]!) : undefined
            // Unknown and multi-id claims stay verbatim for the validator.
            if (!obligation) {
                acceptance.push(criterion)
                continue
            }
            const canonical =
                canonicalObligationAcceptance(contract, [criterion]).acceptance[0] ??
                criterion
            if (canonical !== criterion) {
                rewritten = true
                note(
                    "canonicalized_obligation_criterion",
                    mapping.storyId,
                    obligation.id,
                    `story ${mapping.storyId}: canonicalized paraphrased architecture obligation ${obligation.id} criterion text`,
                )
            }
            acceptance.push(canonical)
            // Parent ids come from the contract obligation, never the text.
            const added = obligation.invariantIds.filter((id) => !declared.has(id))
            if (added.length > 0) {
                for (const id of added) declared.add(id)
                note(
                    "completed_obligation_parent_invariants",
                    mapping.storyId,
                    obligation.id,
                    `story ${mapping.storyId}: completed parent GoalContract invariant(s) for ${obligation.id}: ${added.join(", ")}`,
                )
            }
            implied.push(...obligation.invariantIds)
        }
        const invariantIds = completeImpliedInvariantIds(mapping.invariantIds, implied)
        if (!rewritten && invariantIds.length === mapping.invariantIds.length) {
            return mapping
        }
        return { storyId: mapping.storyId, acceptance, invariantIds }
    })
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
    onNote?: ObligationNoteSink,
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
    const effective = canonicalizeObligationMappings(contract, mappings, onNote)
    const owners = new Map<string, string>()
    const violations: ArchitectureObligationViolation[] = []

    for (const mapping of effective) {
        const storyInvariantIds = new Set(mapping.invariantIds)
        for (const criterion of mapping.acceptance) {
            const exact = byCriterion.get(criterion)
            if (!exact) {
                const claim = OBLIGATION_CRITERION_CLAIM.exec(criterion)
                if (claim) {
                    const id = claim[1] ?? "unknown"
                    const compound = splitClaimedObligationIds(id)
                    violations.push(
                        compound.length > 1
                            ? {
                                  kind: "compound_claim",
                                  storyId: mapping.storyId,
                                  obligationId: id,
                                  detail: `story ${mapping.storyId} writes ${compound.length} obligation ids in one claim [${id}]; each obligation needs its own acceptance criterion`,
                              }
                            : byId.has(id)
                              ? {
                                    kind: "altered_canonical",
                                    storyId: mapping.storyId,
                                    obligationId: id,
                                    detail: `story ${mapping.storyId} altered canonical architecture obligation ${id}`,
                                }
                              : {
                                    kind: "unknown_obligation",
                                    storyId: mapping.storyId,
                                    obligationId: id,
                                    detail: `story ${mapping.storyId} claims unknown architecture obligation ${id}`,
                                },
                    )
                }
                continue
            }
            const previousOwner = owners.get(exact.id)
            if (previousOwner) {
                violations.push({
                    kind: "duplicate_owner",
                    storyId: mapping.storyId,
                    obligationId: exact.id,
                    detail: `architecture obligation ${exact.id} has multiple evidence owners: ${previousOwner}, ${mapping.storyId}`,
                })
                continue
            }
            const missingParents = exact.invariantIds.filter(
                (id) => !storyInvariantIds.has(id),
            )
            // Backstop: canonicalization completes these before the loops run.
            if (missingParents.length > 0) {
                violations.push({
                    kind: "missing_parent_invariants",
                    storyId: mapping.storyId,
                    obligationId: exact.id,
                    detail: `story ${mapping.storyId} owns ${exact.id} but omits parent GoalContract invariant(s): ${missingParents.join(", ")}`,
                })
                continue
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
    const unowned = mode === "complete" ? missingObligationIds : []
    for (const id of unowned) {
        violations.push({
            kind: "unowned_obligation",
            storyId: "",
            obligationId: id,
            detail: `architecture obligation ${id} has no evidence owner`,
        })
    }
    if (violations.length > 0) {
        throw new ArchitectureObligationContractError(
            violationMessage(violations, unowned),
            unowned.length > 0 ? missingObligationIds : [],
            violations,
        )
    }
    return { coveredObligationIds, missingObligationIds }
}

function violationMessage(
    violations: readonly ArchitectureObligationViolation[],
    unowned: readonly string[],
): string {
    // Incomplete coverage alone keeps its legacy wording at any id count.
    if (unowned.length > 0 && unowned.length === violations.length) {
        return `architecture obligation coverage is incomplete; no story owns: ${unowned.join(", ")}`
    }
    if (violations.length === 1) return violations[0]!.detail
    const details = violations.map(({ detail }) => detail)
    const shown = details.slice(0, MAX_REPORTED_VIOLATION_DETAILS)
    const hidden = details.length - shown.length
    if (hidden > 0) shown.push(`… (+${hidden} more)`)
    return `${violations.length} architecture obligation violations: ${shown.join("; ")}`
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
    onNote?: ObligationNoteSink,
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
        onNote,
    )
}

export function validateArchitectureObligationContract(
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
        value.obligations.length > MAX_ARCHITECTURE_OBLIGATIONS
    ) {
        throw new ArchitectureObligationContractError(
            `architecture obligations must contain 1-${MAX_ARCHITECTURE_OBLIGATIONS} entries`,
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
