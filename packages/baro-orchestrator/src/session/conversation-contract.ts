import { createHash } from "node:crypto"

export const CONVERSATION_SCHEMA_VERSION = 1 as const

const MAX_CORRELATION_ID_LENGTH = 128
const MAX_MESSAGE_LENGTH = 8_000
const MAX_OBJECTIVE_LENGTH = 8_000
const MAX_GOAL_LIST_ITEMS = 32
const MAX_GOAL_LIST_ITEM_LENGTH = 2_000
const MAX_QUESTIONS = 3
const MAX_QUESTION_TEXT_LENGTH = 1_000
const MAX_QUESTION_REASON_LENGTH = 1_000

export type ConversationResponseKind = "ready" | "clarify" | "answer"

/**
 * Provider-neutral, implementation-facing statement of user intent.
 *
 * Deliberately absent: model, route, worker, DAG, retry and priority fields.
 * Conversation intake describes intent; downstream authorities decide how to
 * plan and execute it.
 */
export interface GoalEnvelope {
    objective: string
    constraints: readonly string[]
    acceptanceCriteria: readonly string[]
    nonGoals: readonly string[]
    assumptions: readonly string[]
}

export interface ClarificationQuestion {
    id: string
    text: string
    reason?: string
}

/** Exact v1 model/transport wire value. */
export interface ConversationResponse {
    schemaVersion: typeof CONVERSATION_SCHEMA_VERSION
    sessionId: string
    requestId: string
    kind: ConversationResponseKind
    message: string
    questions: readonly ClarificationQuestion[]
    goalEnvelope: GoalEnvelope | null
}

export interface ConversationCorrelation {
    sessionId: string
    requestId: string
}

export class ConversationContractError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ConversationContractError"
    }
}

/**
 * Parse one strict JSON response and bind it to trusted caller correlation.
 * Provider prose, markdown fences, unknown keys and echoed foreign IDs fail
 * closed instead of being silently repaired.
 */
export function parseConversationResponse(
    raw: string,
    expected: ConversationCorrelation,
): ConversationResponse {
    assertCorrelationId(expected.sessionId, "expected sessionId")
    assertCorrelationId(expected.requestId, "expected requestId")

    let parsed: unknown
    try {
        parsed = JSON.parse(raw.trim())
    } catch {
        throw new ConversationContractError("conversation response is not valid JSON")
    }
    return validateConversationResponse(parsed, expected)
}

/** Validate an already-decoded wire value with the same fail-closed rules. */
export function validateConversationResponse(
    value: unknown,
    expected: ConversationCorrelation,
): ConversationResponse {
    assertCorrelationId(expected.sessionId, "expected sessionId")
    assertCorrelationId(expected.requestId, "expected requestId")
    if (
        !isExactRecord(value, [
            "schemaVersion",
            "sessionId",
            "requestId",
            "kind",
            "message",
            "questions",
            "goalEnvelope",
        ])
    ) {
        throw new ConversationContractError(
            "conversation response must use the exact v1 schema",
        )
    }
    if (value.schemaVersion !== CONVERSATION_SCHEMA_VERSION) {
        throw new ConversationContractError("unsupported conversation schemaVersion")
    }
    if (value.sessionId !== expected.sessionId) {
        throw new ConversationContractError("conversation sessionId correlation mismatch")
    }
    if (value.requestId !== expected.requestId) {
        throw new ConversationContractError("conversation requestId correlation mismatch")
    }
    const kind = value.kind
    if (kind !== "ready" && kind !== "clarify" && kind !== "answer") {
        throw new ConversationContractError("conversation response kind is invalid")
    }
    const message = boundedString(
        value.message,
        MAX_MESSAGE_LENGTH,
        "conversation message",
    )
    const questions = parseQuestions(value.questions)

    let goalEnvelope: GoalEnvelope | null = null
    if (value.goalEnvelope !== null) {
        goalEnvelope = validateGoalEnvelope(value.goalEnvelope)
    }

    if (kind === "ready") {
        if (goalEnvelope === null) {
            throw new ConversationContractError(
                "ready response requires a goalEnvelope",
            )
        }
        if (questions.length !== 0) {
            throw new ConversationContractError(
                "ready response cannot contain clarification questions",
            )
        }
    } else if (kind === "clarify") {
        if (goalEnvelope !== null) {
            throw new ConversationContractError(
                "clarify response cannot contain a goalEnvelope",
            )
        }
        if (questions.length === 0) {
            throw new ConversationContractError(
                "clarify response requires at least one question",
            )
        }
    } else {
        if (goalEnvelope !== null || questions.length !== 0) {
            throw new ConversationContractError(
                "answer response cannot contain questions or a goalEnvelope",
            )
        }
    }

    return deepFreeze({
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        sessionId: expected.sessionId,
        requestId: expected.requestId,
        kind,
        message,
        questions,
        goalEnvelope,
    })
}

/** Validate an exact GoalEnvelope independently of the conversation wrapper. */
export function validateGoalEnvelope(value: unknown): GoalEnvelope {
    if (
        !isExactRecord(value, [
            "objective",
            "constraints",
            "acceptanceCriteria",
            "nonGoals",
            "assumptions",
        ])
    ) {
        throw new ConversationContractError("goalEnvelope shape is not exact")
    }
    const objective = boundedString(
        value.objective,
        MAX_OBJECTIVE_LENGTH,
        "goal objective",
    )
    const constraints = boundedStringList(value.constraints, {
        label: "goal constraints",
        allowEmpty: true,
    })
    const acceptanceCriteria = boundedStringList(value.acceptanceCriteria, {
        label: "goal acceptanceCriteria",
        allowEmpty: false,
    })
    const nonGoals = boundedStringList(value.nonGoals, {
        label: "goal nonGoals",
        allowEmpty: true,
    })
    const assumptions = boundedStringList(value.assumptions, {
        label: "goal assumptions",
        allowEmpty: true,
    })
    return deepFreeze({
        objective,
        constraints,
        acceptanceCriteria,
        nonGoals,
        assumptions,
    })
}

/** Stable comparison key without adding a model-controlled ID to the wire. */
export function goalEnvelopeFingerprint(envelope: GoalEnvelope): string {
    const valid = validateGoalEnvelope(envelope)
    return createHash("sha256")
        .update(JSON.stringify(valid))
        .digest("hex")
}

/** Shared safe-ID assertion for session-domain callers. */
export function assertCorrelationId(value: unknown, label: string): asserts value is string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_CORRELATION_ID_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ) {
        throw new ConversationContractError(`${label} is not a safe correlation id`)
    }
}

function parseQuestions(value: unknown): ClarificationQuestion[] {
    if (!Array.isArray(value) || value.length > MAX_QUESTIONS) {
        throw new ConversationContractError(
            `questions must contain at most ${MAX_QUESTIONS} entries`,
        )
    }
    const result: ClarificationQuestion[] = []
    const ids = new Set<string>()
    for (const candidate of value) {
        if (
            !isExactRecord(candidate, ["id", "text"]) &&
            !isExactRecord(candidate, ["id", "text", "reason"])
        ) {
            throw new ConversationContractError("clarification question shape is not exact")
        }
        assertCorrelationId(candidate.id, "clarification question id")
        if (ids.has(candidate.id)) {
            throw new ConversationContractError("clarification question ids must be unique")
        }
        ids.add(candidate.id)
        const question: ClarificationQuestion = {
            id: candidate.id,
            text: boundedString(
                candidate.text,
                MAX_QUESTION_TEXT_LENGTH,
                "clarification question text",
            ),
        }
        if ("reason" in candidate) {
            question.reason = boundedString(
                candidate.reason,
                MAX_QUESTION_REASON_LENGTH,
                "clarification question reason",
            )
        }
        result.push(Object.freeze(question))
    }
    return result
}

function boundedStringList(
    value: unknown,
    options: { label: string; allowEmpty: boolean },
): string[] {
    if (
        !Array.isArray(value) ||
        value.length > MAX_GOAL_LIST_ITEMS ||
        (!options.allowEmpty && value.length === 0)
    ) {
        throw new ConversationContractError(
            `${options.label} must contain ` +
                `${options.allowEmpty ? "0" : "1"}-${MAX_GOAL_LIST_ITEMS} entries`,
        )
    }
    const result: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
        const text = boundedString(
            item,
            MAX_GOAL_LIST_ITEM_LENGTH,
            `${options.label} entry`,
        )
        if (seen.has(text)) {
            throw new ConversationContractError(`${options.label} entries must be unique`)
        }
        seen.add(text)
        result.push(text)
    }
    return result
}

function boundedString(value: unknown, maximum: number, label: string): string {
    if (typeof value !== "string") {
        throw new ConversationContractError(`${label} must be a string`)
    }
    const normalized = value.replace(/\r\n?/g, "\n").trim()
    if (
        normalized.length === 0 ||
        normalized.length > maximum ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    ) {
        throw new ConversationContractError(`${label} is empty, too long, or unsafe`)
    }
    return normalized
}

function isExactRecord(
    value: unknown,
    keys: readonly string[],
): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const actual = Object.keys(value)
    return (
        actual.length === keys.length &&
        actual.every((key) => keys.includes(key))
    )
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
        return value
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child)
    }
    return Object.freeze(value)
}
