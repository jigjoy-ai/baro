/**
 * Shared key normalization, warn notes and defect records for the architect
 * output contracts. This module is a leaf: it imports nothing from the goal,
 * planning, execution or harness trees, so both sides of the dependency edge
 * (planning -> goal) can depend on it without a cycle.
 *
 * Paths follow one grammar everywhere: `constraintPredicates[2].kind`,
 * `obligations[0].evidence[3]`, `questions[1].reason`, and `""` for the
 * top-level record.
 */

export type ContractNoteKind =
    | "stripped_unexpected_field"
    | "canonicalized_field"
    | "skipped_absent_entry"

export interface ContractNote {
    readonly severity: "warn"
    readonly kind: ContractNoteKind
    readonly path: string
    readonly detail: string
}

export interface ContractDefect {
    readonly path: string
    readonly message: string
}

export type NoteSink = (note: ContractNote) => void

export class ContractNormalizationError extends Error {
    readonly path: string

    constructor(message: string, path: string) {
        super(message)
        this.name = "ContractNormalizationError"
        this.path = path
    }
}

/**
 * Correlation the host stamps onto the transport itself. A model that emits
 * one is claiming authority it cannot hold, so the record is refused rather
 * than quietly stripped: a stripped field looks like an accepted outcome.
 */
export const HOST_ASSIGNED_CORRELATION_FIELDS: readonly string[] = [
    "sessionId", // outcome transport envelope, architect-outcome.ts:122-128 / :480-489
    "conversationSessionId", // same envelope, from --conversation-session-id (run-architect.ts:177-185)
    "goalRequestId", // same envelope, same stamping site
    "architectRequestId", // same envelope, same stamping site
    "runId", // billing envelope, run-architect.ts:325 / :786-799
    "billingRunId", // billing envelope, same lines
    "messageId", // per-call billing envelope, run-architect.ts:786-799
    "billingPhase", // per-call billing envelope, same lines
    "billingAttempt", // per-call billing envelope, same lines
    "invocationId", // model_usage measurement context, run-architect.ts:908-935
    "invocationBaseId", // model_usage measurement context, same lines
    "measurementId", // model_usage measurement context, same lines
    "storyId", // host-assigned execution identity, same measurement context
    "workerId", // host-assigned execution identity, same measurement context
    "batchId", // obligation compilation identity, architect-obligation-segments.ts:210-211 / :346-357
    "batchOrdinal", // obligation compilation identity, same sites
    "snapshotId", // host-owned RepositoryBrief snapshot identity
    "traceId", // reserved generic host correlation spelling
    "requestId", // reserved generic host correlation spelling
]

// Deliberately absent: "id" (obligation drafts legitimately carry a model id
// the host discards) and "schemaVersion" (a real contract field), plus the
// bare words attempt/phase/backend/requestedModel, which are host-side
// telemetry only and plausible prose field names.
const HOST_ASSIGNED_CANONICAL = new Set(
    HOST_ASSIGNED_CORRELATION_FIELDS.map(canonicalFieldKey),
)

export class ContractAuthorityFieldError extends ContractNormalizationError {
    readonly field: string

    constructor(field: string, path: string) {
        super(
            `${path}: field "${field}" is host-assigned correlation; ` +
                "model output may not carry host-assigned correlation",
            path,
        )
        this.name = "ContractAuthorityFieldError"
        this.field = field
    }
}

/** Canonical matching, so session_id and SessionID cannot slip past. */
export function isHostAssignedCorrelationField(key: string): boolean {
    return HOST_ASSIGNED_CANONICAL.has(canonicalFieldKey(key))
}

export function assertNoHostAssignedCorrelation(
    candidate: Record<string, unknown>,
    path: string,
): void {
    for (const key of Object.keys(candidate)) {
        if (isHostAssignedCorrelationField(key)) {
            throw new ContractAuthorityFieldError(key, path)
        }
    }
}

const MAX_DEFECT_MESSAGE_LENGTH = 400
const MAX_DEFECT_LIST_LENGTH = 4000

/**
 * Casing and punctuation are the only drift this collapses. No edit distance,
 * no synonym table and no stemming: a key that means something else must stay
 * unmatched so the downstream required-field check can still reject it.
 */
export function canonicalFieldKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/gu, "")
}

/**
 * Copies `candidate` into a new record under the expected spelling of each
 * key. Values are never inspected, coerced or trimmed, and a missing expected
 * key is never invented, so every semantic check downstream stays as strict as
 * it was.
 */
export function normalizeRecordKeys(
    candidate: Record<string, unknown>,
    expectedKeys: readonly string[],
    path: string,
    onNote?: NoteSink,
): Record<string, unknown> {
    // Before collision detection and before any note: forged authority is a
    // refusal, never a drift the caller gets to hear about and continue past.
    assertNoHostAssignedCorrelation(candidate, path)
    const presentKeys = Object.keys(candidate)
    const grouped = new Map<string, string[]>()
    for (const key of presentKeys) {
        const canonical = canonicalFieldKey(key)
        const group = grouped.get(canonical)
        if (group) group.push(key)
        else grouped.set(canonical, [key])
    }

    const expectedByCanonical = new Map<string, string>()
    for (const expected of expectedKeys) {
        expectedByCanonical.set(canonicalFieldKey(expected), expected)
    }

    // An exact match does not win a collision: picking one of two fields that
    // name the same thing would silently discard whichever the model meant.
    for (const expected of expectedKeys) {
        const collided = grouped.get(canonicalFieldKey(expected))
        if (!collided || collided.length < 2) continue
        const names = [...collided].sort().map((name) => `"${name}"`).join(" and ")
        throw new ContractNormalizationError(
            `${path}: fields ${names} both name "${expected}"`,
            path,
        )
    }

    const entries: [string, unknown][] = []
    for (const key of presentKeys) {
        const value = candidate[key]
        const expected = expectedByCanonical.get(canonicalFieldKey(key))
        if (expected === key) {
            entries.push([key, value])
            continue
        }
        if (expected !== undefined) {
            entries.push([expected, value])
            onNote?.({
                severity: "warn",
                kind: "canonicalized_field",
                path,
                detail: `${path}: renamed field "${key}" to "${expected}"`,
            })
            continue
        }
        onNote?.({
            severity: "warn",
            kind: "stripped_unexpected_field",
            path,
            detail: `${path}: dropped unexpected field "${key}"`,
        })
    }
    return Object.fromEntries(entries)
}

/**
 * Validators that were not converted to defect carriage still reach the repair
 * prompt through the synthetic single-defect fallback.
 */
export function contractDefects(error: unknown): readonly ContractDefect[] {
    if (typeof error === "object" && error !== null) {
        const carried = (error as { defects?: unknown }).defects
        if (Array.isArray(carried) && carried.length > 0) {
            return carried as readonly ContractDefect[]
        }
    }
    return [
        {
            path: "",
            message: error instanceof Error ? error.message : String(error),
        },
    ]
}

export function defectFlavor(defect: ContractDefect): string {
    if (defect.path === "") return "outcome"
    const cut = defect.path.search(/[[.]/u)
    return cut < 0 ? defect.path : defect.path.slice(0, cut)
}

export function formatDefectList(defects: readonly ContractDefect[]): string {
    const lines = defects.map((defect) => {
        const message = defect.message.slice(0, MAX_DEFECT_MESSAGE_LENGTH)
        return `- ${defect.path ? `${defect.path}: ` : ""}${message}`
    })
    return lines.join("\n").slice(0, MAX_DEFECT_LIST_LENGTH)
}

/**
 * With exactly one defect this reproduces the pre-accumulation message
 * character-for-character, which is what keeps existing message assertions
 * green.
 */
export function joinDefectMessages(defects: readonly ContractDefect[]): string {
    return defects.map((defect) => defect.message).join("; ")
}
