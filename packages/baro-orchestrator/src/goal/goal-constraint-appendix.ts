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
        try {
            // Anything that is not a record reaches parsePredicate untouched,
            // so it still fails as "must be an object" rather than as a shape
            // normalization invented for it.
            const candidate =
                typeof entry === "object" && !Array.isArray(entry)
                    ? normalizeRecordKeys(
                          entry as Record<string, unknown>,
                          PREDICATE_KEYS,
                          at,
                          onNote,
                      )
                    : entry
            predicates.push(parsePredicate(candidate, index))
        } catch (error) {
            defects.push({
                path: at,
                message: error instanceof Error ? error.message : String(error),
            })
        }
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

function parsePredicate(
    value: unknown,
    index: number,
): GoalConstraintPredicateWireV1 {
    const at = `constraintPredicates[${index}]`
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new GoalConstraintContractError(`${at} must be an object`)
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const expected = [...PREDICATE_KEYS].sort()
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
        throw new GoalConstraintContractError(`${at} must use the exact predicate shape`)
    }
    const invariantId = text(record.invariantId, `${at}.invariantId`)
    if (!INVARIANT_ID.test(invariantId)) {
        throw new GoalConstraintContractError(
            `${at}.invariantId must be a GoalContract id such as G-C1`,
        )
    }
    const kind = text(record.kind, `${at}.kind`)
    if (kind !== "absent" && kind !== "unchanged") {
        throw new GoalConstraintContractError(`${at}.kind must be absent or unchanged`)
    }
    const pathPrefix = text(record.pathPrefix, `${at}.pathPrefix`, true)
    const pathSuffix = text(record.pathSuffix, `${at}.pathSuffix`, true)
    const body = text(record.text, `${at}.text`, true)

    if (kind === "absent" && (!pathPrefix || !body)) {
        throw new GoalConstraintContractError(
            `${at} is absent and needs both a pathPrefix and the text it forbids`,
        )
    }
    if (kind === "unchanged" && !pathSuffix) {
        throw new GoalConstraintContractError(
            `${at} is unchanged and needs the pathSuffix it protects`,
        )
    }
    // A prefix that escapes the tree, or a suffix so broad it names every
    // file, would turn a report into noise the moment it fires.
    if (pathPrefix.startsWith("/") || pathPrefix.includes("..")) {
        throw new GoalConstraintContractError(
            `${at}.pathPrefix must be a repository-relative path`,
        )
    }
    // A bare extension is every source file in the language. The suffix has to
    // carry a second marker — `_test.go`, `.spec.ts` — or the report it feeds
    // would name the whole repository and mean nothing.
    if (kind === "unchanged" && /^\.[a-z0-9]+$/iu.test(pathSuffix)) {
        throw new GoalConstraintContractError(
            `${at}.pathSuffix "${pathSuffix}" is a bare extension and would name every file of that kind`,
        )
    }
    return { invariantId, kind, pathPrefix, pathSuffix, text: body }
}

function text(value: unknown, label: string, allowEmpty = false): string {
    if (typeof value !== "string") {
        throw new GoalConstraintContractError(`${label} must be a string`)
    }
    const trimmed = value.trim()
    if (!allowEmpty && !trimmed) {
        throw new GoalConstraintContractError(`${label} must not be empty`)
    }
    if (trimmed.length > MAX_FIELD_LENGTH) {
        throw new GoalConstraintContractError(
            `${label} exceeds ${MAX_FIELD_LENGTH} characters`,
        )
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
    )
}
