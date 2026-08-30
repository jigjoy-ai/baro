/**
 * The Architect's constraint predicates, carried in the decision document.
 *
 * A constraint is written in English by whoever set the goal, and the host
 * cannot read English. The first attempt at this parsed the constraint text
 * with regular expressions; it worked on the repository it was written
 * against and on almost nothing else — a Go import was rejected as a path, a
 * package without a hyphen was invisible, and "do not modify any *_test.go"
 * froze every Go file in the tree. Fitting a parser to one goal and calling it
 * a check is worse than having no check.
 *
 * So the Architect states the predicate. It is the one stage that reads the
 * repository, knows its language and layout, and has already cited exact files
 * when it disagreed with a goal. The host never interprets prose again: it
 * evaluates what it was given, and reports only what it can prove by naming
 * files.
 */

import {
    type ContractDefect,
    type NoteSink,
    joinDefectMessages,
    normalizeRecordKeys,
} from "../contract/contract-normalization.js"
import {
    type AbsentPredicate,
    type GoalPredicate,
    type UnchangedPredicate,
} from "./goal-precondition.js"

export const GOAL_CONSTRAINT_FENCE = "baro-constraints-v1"
export const GOAL_CONSTRAINT_SCHEMA_VERSION = 1 as const

export const MAX_CONSTRAINT_PREDICATES = 24
const MAX_FIELD_LENGTH = 200
const INVARIANT_ID = /^G-[AC][1-9][0-9]*$/u

/**
 * The one source of the expected key set: normalization and the exact-key
 * check must never disagree about what a predicate is allowed to name.
 */
const PREDICATE_KEYS = [
    "invariantId",
    "kind",
    "pathPrefix",
    "pathSuffix",
    "text",
] as const

export interface GoalConstraintContractErrorOptions extends ErrorOptions {
    readonly defects?: readonly ContractDefect[]
}

export class GoalConstraintContractError extends Error {
    /**
     * Every entry rejected in one pass. A lone defect reproduces the message
     * verbatim, so the single-failure text is unchanged.
     */
    readonly defects: readonly ContractDefect[]

    constructor(message: string, options?: GoalConstraintContractErrorOptions) {
        super(message, options)
        this.name = "GoalConstraintContractError"
        this.defects = options?.defects ?? [{ path: "", message }]
    }
}

/**
 * The wire form is flat and always carries every key, because strict
 * structured outputs cannot express a discriminated union: a field that only
 * some variants use has to be present and empty in the others.
 */
export interface GoalConstraintPredicateWireV1 {
    invariantId: string
    kind: "absent" | "unchanged"
    pathPrefix: string
    pathSuffix: string
    text: string
}

export interface GoalConstraintContractV1 {
    schemaVersion: typeof GOAL_CONSTRAINT_SCHEMA_VERSION
    predicates: readonly GoalConstraintPredicateWireV1[]
}

export function validateGoalConstraintPredicates(
    value: unknown,
    onNote?: NoteSink,
    canonical?: readonly GoalConstraintPredicateWireV1[],
): GoalConstraintPredicateWireV1[] {
    if (!Array.isArray(value)) {
        throw new GoalConstraintContractError("constraintPredicates must be an array")
    }
    // Measured against the array as it arrived: skipping holes first would let
    // an oversized reply slip under the bound.
    if (value.length > MAX_CONSTRAINT_PREDICATES) {
        throw new GoalConstraintContractError(
            `constraintPredicates exceeds ${MAX_CONSTRAINT_PREDICATES} entries`,
        )
    }
    if (canonical && canonical.length > 0) {
        return canonicalizePredicates(value, canonical, onNote)
    }

    const predicates: GoalConstraintPredicateWireV1[] = []
    const defects: ContractDefect[] = []
    let skipped = 0
    for (const [index, entry] of value.entries()) {
        const at = `constraintPredicates[${index}]`
        if (entry == null) {
            skipped += 1
            onNote?.({
                severity: "warn",
                kind: "skipped_absent_entry",
                path: at,
                detail: `${at}: skipped absent entry`,
            })
            continue
        }
        let candidate: unknown
        try {
            // Anything that is not a record reaches parsePredicate untouched,
            // so it still fails as "must be an object" rather than as a shape
            // normalization invented for it.
            candidate =
                typeof entry === "object" && !Array.isArray(entry)
                    ? normalizeRecordKeys(
                          entry as Record<string, unknown>,
                          PREDICATE_KEYS,
                          at,
                          onNote,
                      )
                    : entry
        } catch (error) {
            defects.push({
                path: at,
                message: error instanceof Error ? error.message : String(error),
            })
            continue
        }
        const parsed = parsePredicate(candidate, index, defects)
        if (parsed) predicates.push(parsed)
    }
    if (defects.length > 0) {
        throw new GoalConstraintContractError(joinDefectMessages(defects), { defects })
    }
    // A hole degrades to a note, but an appendix where every entry was a hole
    // states nothing the host was asked to evaluate.
    if (skipped > 0 && predicates.length === 0) {
        const defect: ContractDefect = {
            path: "constraintPredicates",
            message: "constraintPredicates must declare at least one predicate",
        }
        throw new GoalConstraintContractError(defect.message, { defects: [defect] })
    }
    return predicates
}

interface CanonicalMatch {
    /** raw index -> canonical index */
    readonly matched: Map<number, number>
    readonly unmatchedRaw: number[]
    readonly unclaimedCanon: number[]
}

/**
 * Identity is read off the raw array before holes are skipped and before any
 * key is canonicalized: an entry whose `invariantId` key itself drifted has no
 * identity the host can trust, and stays unmatched.
 */
function identityOf(entry: unknown): string | null {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null
    const invariantId = (entry as { invariantId?: unknown }).invariantId
    return typeof invariantId === "string" ? invariantId.trim() : null
}

function matchCanonicalPredicates(
    raw: readonly unknown[],
    canonical: readonly GoalConstraintPredicateWireV1[],
): CanonicalMatch {
    const matched = new Map<number, number>()
    const claimed = new Set<number>()

    const paired = Math.min(raw.length, canonical.length)
    for (let index = 0; index < paired; index += 1) {
        if (identityOf(raw[index]) === canonical[index]!.invariantId) {
            matched.set(index, index)
            claimed.add(index)
        }
    }
    // A shared id is only a key when exactly one canonical entry still carries
    // it; two candidates leave the entry unmatched rather than guessing.
    for (let index = 0; index < raw.length; index += 1) {
        if (matched.has(index)) continue
        const identity = identityOf(raw[index])
        if (identity === null) continue
        const candidates: number[] = []
        for (let canon = 0; canon < canonical.length; canon += 1) {
            if (!claimed.has(canon) && canonical[canon]!.invariantId === identity) {
                candidates.push(canon)
            }
        }
        if (candidates.length === 1) {
            matched.set(index, candidates[0]!)
            claimed.add(candidates[0]!)
        }
    }

    const unmatchedRaw: number[] = []
    for (let index = 0; index < raw.length; index += 1) {
        // A hole claims nothing and states nothing; whatever it failed to
        // cover is reported as an unclaimed canonical entry instead.
        if (matched.has(index) || raw[index] == null) continue
        unmatchedRaw.push(index)
    }
    const unclaimedCanon: number[] = []
    for (let canon = 0; canon < canonical.length; canon += 1) {
        if (!claimed.has(canon)) unclaimedCanon.push(canon)
    }
    return { matched, unmatchedRaw, unclaimedCanon }
}

function cloneCanonical(
    predicate: GoalConstraintPredicateWireV1,
): GoalConstraintPredicateWireV1 {
    return {
        invariantId: predicate.invariantId.trim(),
        kind: predicate.kind,
        pathPrefix: predicate.pathPrefix.trim(),
        pathSuffix: predicate.pathSuffix.trim(),
        text: predicate.text.trim(),
    }
}

function driftedFields(
    entry: unknown,
    canon: GoalConstraintPredicateWireV1,
): string[] {
    const record = entry as Record<string, unknown>
    const drifted = PREDICATE_KEYS.filter((key) => record[key] !== canon[key])
    const unexpected = Object.keys(record)
        .filter((key) => !(PREDICATE_KEYS as readonly string[]).includes(key))
        .sort()
    return [...drifted, ...unexpected]
}

/**
 * With a canonical appendix in hand the host restores rather than argues:
 * drifted fields never reach parsePredicate, so what validation returns — and
 * what every downstream consumer sees — is the canon itself. Only meaning
 * drift is left to reject: an entry that matches nothing, and a canonical
 * predicate nobody claimed.
 */
function canonicalizePredicates(
    raw: readonly unknown[],
    canonical: readonly GoalConstraintPredicateWireV1[],
    onNote?: NoteSink,
): GoalConstraintPredicateWireV1[] {
    const { matched, unmatchedRaw, unclaimedCanon } = matchCanonicalPredicates(
        raw,
        canonical,
    )
    const defects: ContractDefect[] = []
    for (const index of unmatchedRaw) {
        const at = `constraintPredicates[${index}]`
        const entry = raw[index]
        // Its own shape defects travel in the same throw as the membership
        // one, so a repair round hears everything wrong with it at once.
        try {
            const candidate =
                typeof entry === "object" && !Array.isArray(entry)
                    ? normalizeRecordKeys(
                          entry as Record<string, unknown>,
                          PREDICATE_KEYS,
                          at,
                          onNote,
                      )
                    : entry
            parsePredicate(candidate, index, defects)
        } catch (error) {
            defects.push({
                path: at,
                message: error instanceof Error ? error.message : String(error),
            })
        }
        defects.push({
            path: at,
            message: `${at} does not match any canonical constraint predicate`,
        })
    }
    for (const canon of unclaimedCanon) {
        defects.push({
            path: `constraintPredicates[${canon}]`,
            message: `constraintPredicates is missing the canonical predicate ${canonical[canon]!.invariantId}`,
        })
    }
    if (defects.length > 0) {
        throw new GoalConstraintContractError(joinDefectMessages(defects), { defects })
    }

    for (const index of [...matched.keys()].sort((a, b) => a - b)) {
        const canon = cloneCanonical(canonical[matched.get(index)!]!)
        const drifted = driftedFields(raw[index], canon)
        if (drifted.length === 0) continue
        const at = `constraintPredicates[${index}]`
        onNote?.({
            severity: "warn",
            kind: "canonicalized_field",
            path: at,
            detail: `${at}: restored canonical predicate ${canon.invariantId} (${drifted.join(", ")})`,
        })
    }
    return canonical.map(cloneCanonical)
}

/**
 * Every field is judged, not just the first bad one: a predicate that drifted
 * in two places would otherwise cost a second repair round to hear about the
 * second place. The defect path stays the entry, as it was when a single throw
 * carried the field name in its message alone.
 */
function parsePredicate(
    value: unknown,
    index: number,
    defects: ContractDefect[],
): GoalConstraintPredicateWireV1 | null {
    const at = `constraintPredicates[${index}]`
    const before = defects.length
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        defects.push({ path: at, message: `${at} must be an object` })
        return null
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const expected = [...PREDICATE_KEYS].sort()
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
        defects.push({ path: at, message: `${at} must use the exact predicate shape` })
        return null
    }
    const invariantId = text(record.invariantId, `${at}.invariantId`, at, defects)
    if (invariantId !== null && !INVARIANT_ID.test(invariantId)) {
        defects.push({
            path: at,
            message: `${at}.invariantId must be a GoalContract id such as G-C1`,
        })
    }
    const declaredKind = text(record.kind, `${at}.kind`, at, defects)
    let kind: "absent" | "unchanged" | null = null
    if (declaredKind !== null) {
        if (declaredKind === "absent" || declaredKind === "unchanged") {
            kind = declaredKind
        } else {
            defects.push({ path: at, message: `${at}.kind must be absent or unchanged` })
        }
    }
    const pathPrefix = text(record.pathPrefix, `${at}.pathPrefix`, at, defects, true)
    const pathSuffix = text(record.pathSuffix, `${at}.pathSuffix`, at, defects, true)
    const body = text(record.text, `${at}.text`, at, defects, true)

    if (kind === "absent" && (!pathPrefix || !body)) {
        defects.push({
            path: at,
            message: `${at} is absent and needs both a pathPrefix and the text it forbids`,
        })
    }
    if (kind === "unchanged" && !pathSuffix) {
        defects.push({
            path: at,
            message: `${at} is unchanged and needs the pathSuffix it protects`,
        })
    }
    // A prefix that escapes the tree, or a suffix so broad it names every
    // file, would turn a report into noise the moment it fires.
    if (pathPrefix !== null && (pathPrefix.startsWith("/") || pathPrefix.includes(".."))) {
        defects.push({
            path: at,
            message: `${at}.pathPrefix must be a repository-relative path`,
        })
    }
    // A bare extension is every source file in the language. The suffix has to
    // carry a second marker — `_test.go`, `.spec.ts` — or the report it feeds
    // would name the whole repository and mean nothing.
    if (kind === "unchanged" && pathSuffix !== null && /^\.[a-z0-9]+$/iu.test(pathSuffix)) {
        defects.push({
            path: at,
            message: `${at}.pathSuffix "${pathSuffix}" is a bare extension and would name every file of that kind`,
        })
    }
    if (defects.length > before) return null
    return {
        invariantId: invariantId!,
        kind: kind!,
        pathPrefix: pathPrefix!,
        pathSuffix: pathSuffix!,
        text: body!,
    }
}

function text(
    value: unknown,
    label: string,
    at: string,
    defects: ContractDefect[],
    allowEmpty = false,
): string | null {
    if (typeof value !== "string") {
        defects.push({ path: at, message: `${label} must be a string` })
        return null
    }
    const trimmed = value.trim()
    if (!allowEmpty && !trimmed) {
        defects.push({ path: at, message: `${label} must not be empty` })
        return null
    }
    if (trimmed.length > MAX_FIELD_LENGTH) {
        defects.push({
            path: at,
            message: `${label} exceeds ${MAX_FIELD_LENGTH} characters`,
        })
        return null
    }
    return trimmed
}

/**
 * The domain form, which knows nothing about the wire's empty strings. Every
 * stated scope part survives for every kind: this mapping once dropped the
 * suffix from absent predicates and the prefix from unchanged ones, and each
 * omission turned the Architect's claim into a different, wider claim.
 */
export function goalPredicatesFromWire(
    predicates: readonly GoalConstraintPredicateWireV1[],
): GoalPredicate[] {
    return predicates.map((predicate) => {
        const scope = {
            ...(predicate.pathPrefix ? { pathPrefix: predicate.pathPrefix } : {}),
            ...(predicate.pathSuffix ? { pathSuffix: predicate.pathSuffix } : {}),
        }
        return predicate.kind === "absent"
            ? ({
                  kind: "absent",
                  invariantId: predicate.invariantId,
                  ...scope,
                  text: predicate.text,
              } satisfies AbsentPredicate)
            : ({
                  kind: "unchanged",
                  invariantId: predicate.invariantId,
                  ...scope,
              } satisfies UnchangedPredicate)
    })
}

export function hasGoalConstraintFence(decisionDocument: string): boolean {
    return decisionDocument.includes(`\`\`\`${GOAL_CONSTRAINT_FENCE}`)
}

/** Append the host-owned appendix. A model-authored one is never accepted. */
export function attachGoalConstraintContract(
    decisionDocument: string,
    predicates: readonly GoalConstraintPredicateWireV1[],
): string {
    if (hasGoalConstraintFence(decisionDocument)) {
        throw new GoalConstraintContractError(
            `architecture decision document already contains the reserved ${GOAL_CONSTRAINT_FENCE} fence`,
        )
    }
    if (predicates.length === 0) return decisionDocument
    const contract: GoalConstraintContractV1 = {
        schemaVersion: GOAL_CONSTRAINT_SCHEMA_VERSION,
        predicates,
    }
    return [
        decisionDocument.trimEnd(),
        "",
        `\`\`\`${GOAL_CONSTRAINT_FENCE}`,
        JSON.stringify(contract, null, 2),
        "```",
    ].join("\n")
}

/**
 * Read the appendix back. A document without one is not an error — it is a
 * goal whose constraints nobody could state as a predicate.
 */
export function parseGoalConstraintContract(
    decisionDocument: string | null | undefined,
    onNote?: NoteSink,
    canonical?: readonly GoalConstraintPredicateWireV1[],
): GoalConstraintPredicateWireV1[] {
    if (decisionDocument == null || !hasGoalConstraintFence(decisionDocument)) {
        return []
    }
    const expression = new RegExp(
        `(?:^|\\n)\`\`\`${GOAL_CONSTRAINT_FENCE}[ \\t]*\\n([\\s\\S]*?)\\n\`\`\`(?=\\n|$)`,
        "gu",
    )
    const matches = [
        ...decisionDocument.replace(/\r\n?/gu, "\n").matchAll(expression),
    ]
    if (matches.length !== 1) {
        throw new GoalConstraintContractError(
            `decision document must contain exactly one well-formed ${GOAL_CONSTRAINT_FENCE} block`,
        )
    }
    let value: unknown
    try {
        value = JSON.parse(matches[0]![1]!)
    } catch {
        throw new GoalConstraintContractError(
            `${GOAL_CONSTRAINT_FENCE} block is not valid JSON`,
        )
    }
    if (
        !value ||
        typeof value !== "object" ||
        (value as { schemaVersion?: unknown }).schemaVersion !==
            GOAL_CONSTRAINT_SCHEMA_VERSION
    ) {
        throw new GoalConstraintContractError(
            `${GOAL_CONSTRAINT_FENCE} block has an unsupported schemaVersion`,
        )
    }
    return validateGoalConstraintPredicates(
        (value as { predicates?: unknown }).predicates,
        onNote,
        canonical,
    )
}
