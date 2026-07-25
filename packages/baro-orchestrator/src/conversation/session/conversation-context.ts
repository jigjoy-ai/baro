import { readFileSync, statSync } from "node:fs"

import {
    assertCorrelationId,
    goalEnvelopeFingerprint,
    validateGoalEnvelope,
    type GoalEnvelope,
} from "./conversation-contract.js"

export const CONVERSATION_CONTEXT_SCHEMA_VERSION = 1 as const
export const MAX_CONVERSATION_CONTEXT_BYTES = 128 * 1024
export const MAX_CONVERSATION_CONTEXT_HISTORY = 24

const MAX_CONTEXT_TEXT_LENGTH = 8_000

/**
 * Caller-owned lifecycle phase accompanying an already accepted goal.
 * Pre-goal phases are intentionally absent: runtime Dialogue must never turn
 * an unresolved intake into execution authority.
 */
export type ConversationContextPhase =
    | "ready"
    | "planning"
    | "executing"
    | "verifying"
    | "completed"
    | "failed"

export interface ConversationContextHistoryEntry {
    requestId: string | null
    role: "user" | "assistant" | "system"
    text: string
}

/**
 * Ephemeral, bounded projection from the durable front-door session.
 *
 * This value is runtime context only. It contains no route, model, DAG,
 * worker, lease, retry, mutation, or completion fields and must not be copied
 * into the repository PRD.
 */
export interface ConversationContextSnapshot {
    schemaVersion: typeof CONVERSATION_CONTEXT_SCHEMA_VERSION
    sessionId: string
    phase: ConversationContextPhase
    goalEnvelope: GoalEnvelope
    summary: string | null
    history: readonly ConversationContextHistoryEntry[]
}

export interface ConversationContextBinding {
    conversationSessionId?: string
    goalEnvelope?: GoalEnvelope
}

export class ConversationContextError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ConversationContextError"
    }
}

/** Parse one exact, size-bounded JSON projection. */
export function parseConversationContextSnapshot(
    raw: string,
): ConversationContextSnapshot {
    if (typeof raw !== "string") {
        throw new ConversationContextError("conversation context must be JSON text")
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_CONVERSATION_CONTEXT_BYTES) {
        throw new ConversationContextError(
            `conversation context exceeds ${MAX_CONVERSATION_CONTEXT_BYTES} bytes`,
        )
    }
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        throw new ConversationContextError("conversation context is not valid JSON")
    }
    return validateConversationContextSnapshot(value)
}

/** Load exactly one caller-selected ephemeral snapshot without persisting it. */
export function loadConversationContextFile(
    path: string,
): ConversationContextSnapshot {
    let metadata: ReturnType<typeof statSync>
    try {
        metadata = statSync(path)
    } catch (error) {
        throw new ConversationContextError(
            `cannot inspect conversation context file: ${messageOf(error)}`,
        )
    }
    if (!metadata.isFile()) {
        throw new ConversationContextError("conversation context path is not a file")
    }
    if (metadata.size > MAX_CONVERSATION_CONTEXT_BYTES) {
        throw new ConversationContextError(
            `conversation context exceeds ${MAX_CONVERSATION_CONTEXT_BYTES} bytes`,
        )
    }
    let bytes: Buffer
    try {
        bytes = readFileSync(path)
    } catch (error) {
        throw new ConversationContextError(
            `cannot read conversation context file: ${messageOf(error)}`,
        )
    }
    if (bytes.byteLength > MAX_CONVERSATION_CONTEXT_BYTES) {
        throw new ConversationContextError(
            `conversation context exceeds ${MAX_CONVERSATION_CONTEXT_BYTES} bytes`,
        )
    }
    return parseConversationContextSnapshot(bytes.toString("utf8"))
}

/** Validate an already-decoded snapshot with the same fail-closed rules. */
export function validateConversationContextSnapshot(
    value: unknown,
): ConversationContextSnapshot {
    if (!isExactRecord(value, [
        "schemaVersion",
        "sessionId",
        "phase",
        "goalEnvelope",
        "summary",
        "history",
    ])) {
        throw new ConversationContextError(
            "conversation context must use the exact v1 schema",
        )
    }
    if (value.schemaVersion !== CONVERSATION_CONTEXT_SCHEMA_VERSION) {
        throw new ConversationContextError(
            "unsupported conversation context schemaVersion",
        )
    }
    try {
        assertCorrelationId(value.sessionId, "conversation context sessionId")
    } catch (error) {
        throw asContextError(error)
    }
    const phase = parsePhase(value.phase)
    let goalEnvelope: GoalEnvelope
    try {
        goalEnvelope = validateGoalEnvelope(value.goalEnvelope)
    } catch (error) {
        throw asContextError(error)
    }
    const summary = value.summary === null
        ? null
        : boundedText(value.summary, "conversation context summary")
    const history = parseHistory(value.history)
    const snapshot = {
        schemaVersion: CONVERSATION_CONTEXT_SCHEMA_VERSION,
        sessionId: value.sessionId,
        phase,
        goalEnvelope,
        summary,
        history,
    } satisfies ConversationContextSnapshot
    if (
        Buffer.byteLength(JSON.stringify(snapshot), "utf8") >
        MAX_CONVERSATION_CONTEXT_BYTES
    ) {
        throw new ConversationContextError(
            `conversation context exceeds ${MAX_CONVERSATION_CONTEXT_BYTES} bytes`,
        )
    }
    return deepFreeze(snapshot)
}

/**
 * Bind ephemeral context to the plan that authorized this run. Context is
 * rejected when the PRD lacks the durable correlation fields or carries a
 * different accepted goal.
 */
export function assertConversationContextBinding(
    context: ConversationContextSnapshot,
    binding: ConversationContextBinding,
): void {
    const valid = validateConversationContextSnapshot(context)
    if (!binding.conversationSessionId || !binding.goalEnvelope) {
        throw new ConversationContextError(
            "conversation context requires PRD conversationSessionId and goalEnvelope",
        )
    }
    try {
        assertCorrelationId(binding.conversationSessionId, "PRD conversationSessionId")
    } catch (error) {
        throw asContextError(error)
    }
    if (binding.conversationSessionId !== valid.sessionId) {
        throw new ConversationContextError(
            "conversation context sessionId does not match the PRD",
        )
    }
    let goal: GoalEnvelope
    try {
        goal = validateGoalEnvelope(binding.goalEnvelope)
    } catch (error) {
        throw asContextError(error)
    }
    if (goalEnvelopeFingerprint(goal) !== goalEnvelopeFingerprint(valid.goalEnvelope)) {
        throw new ConversationContextError(
            "conversation context goalEnvelope does not match the PRD",
        )
    }
}

function parseHistory(value: unknown): ConversationContextHistoryEntry[] {
    if (!Array.isArray(value) || value.length > MAX_CONVERSATION_CONTEXT_HISTORY) {
        throw new ConversationContextError(
            `conversation context history must contain at most ${MAX_CONVERSATION_CONTEXT_HISTORY} entries`,
        )
    }
    const history: ConversationContextHistoryEntry[] = []
    const pending = new Set<string>()
    const completed = new Set<string>()
    for (const candidate of value) {
        if (!isExactRecord(candidate, ["requestId", "role", "text"])) {
            throw new ConversationContextError(
                "conversation context history entry shape is not exact",
            )
        }
        if (
            candidate.role !== "user" &&
            candidate.role !== "assistant" &&
            candidate.role !== "system"
        ) {
            throw new ConversationContextError(
                "conversation context history role is invalid",
            )
        }
        const text = boundedText(candidate.text, "conversation context history text")
        if (candidate.role === "system") {
            if (candidate.requestId !== null) {
                throw new ConversationContextError(
                    "conversation context system history must not carry requestId",
                )
            }
            history.push(Object.freeze({ requestId: null, role: "system", text }))
            continue
        }
        try {
            assertCorrelationId(
                candidate.requestId,
                "conversation context history requestId",
            )
        } catch (error) {
            throw asContextError(error)
        }
        const requestId = candidate.requestId
        if (candidate.role === "user") {
            if (pending.has(requestId) || completed.has(requestId)) {
                throw new ConversationContextError(
                    "conversation context user requestIds must be unique",
                )
            }
            pending.add(requestId)
        } else {
            if (!pending.delete(requestId) || completed.has(requestId)) {
                throw new ConversationContextError(
                    "conversation context assistant history must follow its user turn",
                )
            }
            completed.add(requestId)
        }
        history.push(Object.freeze({ requestId, role: candidate.role, text }))
    }
    if (pending.size > 0) {
        throw new ConversationContextError(
            "conversation context history must contain complete user/assistant turns",
        )
    }
    return history
}

function parsePhase(value: unknown): ConversationContextPhase {
    if (
        value !== "ready" &&
        value !== "planning" &&
        value !== "executing" &&
        value !== "verifying" &&
        value !== "completed" &&
        value !== "failed"
    ) {
        throw new ConversationContextError(
            "conversation context phase requires an accepted goal",
        )
    }
    return value
}

function boundedText(value: unknown, label: string): string {
    if (typeof value !== "string") {
        throw new ConversationContextError(`${label} must be a string`)
    }
    const text = value.replace(/\r\n?/g, "\n").trim()
    if (
        text.length === 0 ||
        text.length > MAX_CONTEXT_TEXT_LENGTH ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
    ) {
        throw new ConversationContextError(`${label} is empty, too long, or unsafe`)
    }
    return text
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
    return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function asContextError(error: unknown): ConversationContextError {
    return error instanceof ConversationContextError
        ? error
        : new ConversationContextError(messageOf(error))
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
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
