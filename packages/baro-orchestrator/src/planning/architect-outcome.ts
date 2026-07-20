/**
 * Strict provider-neutral result of the repository-aware Architect pass.
 *
 * Model output deliberately contains no session/run authority. The
 * run-architect entrypoint validates this payload first, then attaches trusted
 * caller correlation in a separate transport envelope.
 */

import type { GoalEnvelope } from "../session/conversation-contract.js"
import { deriveGoalContract } from "../runtime/goal-contract.js"
import {
    bindArchitectureObligationContract,
    parseArchitectureObligationContract,
} from "./architecture-obligation-contract.js"

export const ARCHITECT_OUTCOME_SCHEMA_VERSION = 1 as const
export const MAX_ARCHITECT_OUTCOME_BYTES = 128 * 1024

const MAX_MESSAGE_LENGTH = 8_000
const MAX_DECISION_DOCUMENT_LENGTH = 96 * 1024
const MAX_QUESTIONS = 3
const MAX_QUESTION_TEXT_LENGTH = 1_000
const MAX_QUESTION_REASON_LENGTH = 1_000
const MAX_EVIDENCE = 16
const MAX_EVIDENCE_PATH_LENGTH = 512
const MAX_EVIDENCE_FACT_LENGTH = 2_000
const MAX_CORRELATION_ID_LENGTH = 128
const MAX_LINE_NUMBER = 10_000_000

export interface ArchitectClarificationQuestionV1 {
    readonly id: string
    readonly text: string
    readonly reason?: string
}

export interface ArchitectRepositoryEvidenceV1 {
    /** Portable project-relative path. Absolute and parent-traversing paths fail. */
    readonly path: string
    readonly line: number | null
    readonly fact: string
}

interface ArchitectOutcomeBaseV1 {
    readonly schemaVersion: typeof ARCHITECT_OUTCOME_SCHEMA_VERSION
    readonly message: string
}

export interface ArchitectReadyOutcomeV1 extends ArchitectOutcomeBaseV1 {
    readonly kind: "ready"
    readonly questions: readonly []
    readonly evidence: readonly []
    readonly decisionDocument: string
}

export interface ArchitectNeedsInputOutcomeV1 extends ArchitectOutcomeBaseV1 {
    readonly kind: "needsInput"
    readonly questions: readonly ArchitectClarificationQuestionV1[]
    readonly evidence: readonly ArchitectRepositoryEvidenceV1[]
    readonly decisionDocument: null
}

export type ArchitectOutcomeV1 =
    | ArchitectReadyOutcomeV1
    | ArchitectNeedsInputOutcomeV1

export interface ArchitectOutcomeTransportV1 {
    readonly schemaVersion: typeof ARCHITECT_OUTCOME_SCHEMA_VERSION
    readonly sessionId: string
    readonly goalRequestId: string
    readonly architectRequestId: string
    readonly outcome: ArchitectOutcomeV1
}

export interface ArchitectOutcomeCorrelationV1 {
    sessionId: string
    goalRequestId: string
    architectRequestId: string
}

export class ArchitectOutcomeContractError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ArchitectOutcomeContractError"
    }
}

/**
 * Portable fixed-shape schema for CLIs that support native structured output.
 * The strict parser below remains authoritative because the discriminator's
 * cross-field rules are intentionally provider independent.
 */
export const ARCHITECT_OUTCOME_JSON_SCHEMA = deepFreeze({
    type: "object",
    additionalProperties: false,
    required: [
        "schemaVersion",
        "kind",
        "message",
        "questions",
        "evidence",
        "decisionDocument",
    ],
    properties: {
        schemaVersion: { type: "integer", const: 1 },
        kind: { type: "string", enum: ["ready", "needsInput"] },
        message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
        questions: {
            type: "array",
            maxItems: MAX_QUESTIONS,
            items: {
                type: "object",
                additionalProperties: false,
                // Codex/OpenAI strict structured outputs require every
                // declared object property to be listed in `required`.
                // The provider schema can require `reason` while the
                // provider-neutral parser remains backward-compatible with
                // Claude/OpenCode/Pi outputs that omit it.
                required: ["id", "text", "reason"],
                properties: {
                    id: { type: "string", minLength: 1, maxLength: MAX_CORRELATION_ID_LENGTH },
                    text: { type: "string", minLength: 1, maxLength: MAX_QUESTION_TEXT_LENGTH },
                    reason: { type: "string", minLength: 1, maxLength: MAX_QUESTION_REASON_LENGTH },
                },
            },
        },
        evidence: {
            type: "array",
            maxItems: MAX_EVIDENCE,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "line", "fact"],
                properties: {
                    path: { type: "string", minLength: 1, maxLength: MAX_EVIDENCE_PATH_LENGTH },
                    line: {
                        anyOf: [
                            { type: "integer", minimum: 1, maximum: MAX_LINE_NUMBER },
                            { type: "null" },
                        ],
                    },
                    fact: { type: "string", minLength: 1, maxLength: MAX_EVIDENCE_FACT_LENGTH },
                },
            },
        },
        decisionDocument: {
            anyOf: [
                {
                    type: "string",
                    minLength: 1,
                    maxLength: MAX_DECISION_DOCUMENT_LENGTH,
                    // Strict outcome mode always carries the host-owned goal
                    // into a machine-checkable obligation appendix. A model
                    // must not gain authority to bypass that binding merely
                    // by labelling its own answer "trivial".
                    pattern: "```baro-obligations-v1(?:\\r?\\n)",
                },
                { type: "null" },
            ],
        },
    },
})

/** Parse exact JSON. Markdown fences, leading prose and unknown keys fail. */
export function parseArchitectOutcome(
    raw: string,
    options: ArchitectOutcomeValidationOptions = {},
): ArchitectOutcomeV1 {
    if (typeof raw !== "string") {
        throw new ArchitectOutcomeContractError("architect outcome must be text")
    }
    const bytes = Buffer.byteLength(raw, "utf8")
    if (bytes > MAX_ARCHITECT_OUTCOME_BYTES) {
        throw new ArchitectOutcomeContractError(
            `architect outcome is ${bytes} bytes; limit is ${MAX_ARCHITECT_OUTCOME_BYTES}`,
        )
    }
    let value: unknown
    try {
        value = JSON.parse(raw.trim())
    } catch {
        throw new ArchitectOutcomeContractError("architect outcome is not valid JSON")
    }
    return validateArchitectOutcome(value, options)
}

export function validateArchitectOutcome(
    value: unknown,
    options: ArchitectOutcomeValidationOptions = {},
): ArchitectOutcomeV1 {
    if (!exactRecord(value, [
        "schemaVersion",
        "kind",
        "message",
        "questions",
        "evidence",
        "decisionDocument",
    ])) {
        throw new ArchitectOutcomeContractError(
            "architect outcome must use the exact v1 schema",
        )
    }
    if (value.schemaVersion !== ARCHITECT_OUTCOME_SCHEMA_VERSION) {
        throw new ArchitectOutcomeContractError("unsupported architect outcome schemaVersion")
    }
    const message = boundedText(value.message, MAX_MESSAGE_LENGTH, "architect message")
    const questions = parseQuestions(value.questions)
    const evidence = parseEvidence(value.evidence)

    if (value.kind === "ready") {
        if (questions.length !== 0 || evidence.length !== 0) {
            throw new ArchitectOutcomeContractError(
                "ready architect outcome requires empty questions and evidence",
            )
        }
        const decisionDocument = boundedText(
            value.decisionDocument,
            MAX_DECISION_DOCUMENT_LENGTH,
            "architect decisionDocument",
        )
        assertArchitectureDocument(decisionDocument)
        validateArchitectureObligations(
            decisionDocument,
            options.requireObligations === true,
            options.trustedGoalEnvelope,
        )
        return deepFreeze({
            schemaVersion: ARCHITECT_OUTCOME_SCHEMA_VERSION,
            kind: "ready" as const,
            message,
            questions: [] as const,
            evidence: [] as const,
            decisionDocument,
        })
    }

    if (value.kind === "needsInput") {
        if (value.decisionDocument !== null) {
            throw new ArchitectOutcomeContractError(
                "needsInput architect outcome requires decisionDocument null",
            )
        }
        if (questions.length < 1 || questions.length > MAX_QUESTIONS) {
            throw new ArchitectOutcomeContractError(
                "needsInput architect outcome requires 1-3 questions",
            )
        }
        if (evidence.length < 1) {
            throw new ArchitectOutcomeContractError(
                "needsInput architect outcome requires repository evidence",
            )
        }
        return deepFreeze({
            schemaVersion: ARCHITECT_OUTCOME_SCHEMA_VERSION,
            kind: "needsInput" as const,
            message,
            questions,
            evidence,
            decisionDocument: null,
        })
    }

    throw new ArchitectOutcomeContractError("architect outcome kind is invalid")
}

function validateArchitectureObligations(
    decisionDocument: string,
    requireObligations: boolean,
    trustedGoalEnvelope?: GoalEnvelope | null,
): void {
    const obligations = parseArchitectureObligationContract(decisionDocument)
    if (requireObligations && !obligations) {
        throw new ArchitectOutcomeContractError(
            "ready architect outcome requires a baro-obligations-v1 appendix",
        )
    }
    if (obligations && trustedGoalEnvelope) {
        bindArchitectureObligationContract(
            obligations,
            deriveGoalContract(trustedGoalEnvelope),
        )
    }
}

export interface ArchitectOutcomeValidationOptions {
    requireObligations?: boolean
    /** Host-owned goal used to reject unknown or missing parent ids. */
    trustedGoalEnvelope?: GoalEnvelope | null
}

export function wrapArchitectOutcome(
    outcome: ArchitectOutcomeV1,
    correlation: ArchitectOutcomeCorrelationV1,
): ArchitectOutcomeTransportV1 {
    const transport = {
        schemaVersion: ARCHITECT_OUTCOME_SCHEMA_VERSION,
        sessionId: safeCorrelationId(correlation.sessionId, "sessionId"),
        goalRequestId: safeCorrelationId(correlation.goalRequestId, "goalRequestId"),
        architectRequestId: safeCorrelationId(
            correlation.architectRequestId,
            "architectRequestId",
        ),
        outcome: validateArchitectOutcome(outcome),
    }
    const bytes = Buffer.byteLength(JSON.stringify(transport), "utf8")
    if (bytes > MAX_ARCHITECT_OUTCOME_BYTES) {
        throw new ArchitectOutcomeContractError(
            `architect outcome transport is ${bytes} bytes; limit is ${MAX_ARCHITECT_OUTCOME_BYTES}`,
        )
    }
    return deepFreeze(transport)
}

/** Validate trusted caller correlation before any provider invocation. */
export function validateArchitectOutcomeCorrelation(
    correlation: ArchitectOutcomeCorrelationV1,
): ArchitectOutcomeCorrelationV1 {
    return Object.freeze({
        sessionId: safeCorrelationId(correlation.sessionId, "sessionId"),
        goalRequestId: safeCorrelationId(correlation.goalRequestId, "goalRequestId"),
        architectRequestId: safeCorrelationId(
            correlation.architectRequestId,
            "architectRequestId",
        ),
    })
}

function parseQuestions(value: unknown): ArchitectClarificationQuestionV1[] {
    if (!Array.isArray(value) || value.length > MAX_QUESTIONS) {
        throw new ArchitectOutcomeContractError(
            `architect questions must contain at most ${MAX_QUESTIONS} entries`,
        )
    }
    const result: ArchitectClarificationQuestionV1[] = []
    const ids = new Set<string>()
    for (const candidate of value) {
        if (
            !exactRecord(candidate, ["id", "text"]) &&
            !exactRecord(candidate, ["id", "text", "reason"])
        ) {
            throw new ArchitectOutcomeContractError("architect question shape is not exact")
        }
        const id = safeCorrelationId(candidate.id, "architect question id")
        if (ids.has(id)) {
            throw new ArchitectOutcomeContractError("architect question ids must be unique")
        }
        ids.add(id)
        result.push({
            id,
            text: boundedText(
                candidate.text,
                MAX_QUESTION_TEXT_LENGTH,
                "architect question text",
            ),
            ...("reason" in candidate
                ? {
                      reason: boundedText(
                          candidate.reason,
                          MAX_QUESTION_REASON_LENGTH,
                          "architect question reason",
                      ),
                  }
                : {}),
        })
    }
    return result
}

function parseEvidence(value: unknown): ArchitectRepositoryEvidenceV1[] {
    if (!Array.isArray(value) || value.length > MAX_EVIDENCE) {
        throw new ArchitectOutcomeContractError(
            `architect evidence must contain at most ${MAX_EVIDENCE} entries`,
        )
    }
    const result: ArchitectRepositoryEvidenceV1[] = []
    const seen = new Set<string>()
    for (const candidate of value) {
        if (!exactRecord(candidate, ["path", "line", "fact"])) {
            throw new ArchitectOutcomeContractError("architect evidence shape is not exact")
        }
        const path = safeRelativePath(candidate.path)
        const line = candidate.line
        if (
            line !== null &&
            (typeof line !== "number" ||
                !Number.isSafeInteger(line) ||
                line < 1 ||
                line > MAX_LINE_NUMBER)
        ) {
            throw new ArchitectOutcomeContractError(
                "architect evidence line must be null or a positive bounded integer",
            )
        }
        const fact = boundedText(
            candidate.fact,
            MAX_EVIDENCE_FACT_LENGTH,
            "architect evidence fact",
        )
        const key = `${path}\u0000${line ?? ""}\u0000${fact}`
        if (seen.has(key)) {
            throw new ArchitectOutcomeContractError("architect evidence entries must be unique")
        }
        seen.add(key)
        result.push({ path, line: line as number | null, fact })
    }
    return result
}

function safeRelativePath(value: unknown): string {
    const path = boundedText(
        value,
        MAX_EVIDENCE_PATH_LENGTH,
        "architect evidence path",
    )
    if (
        path.startsWith("/") ||
        path.startsWith("\\") ||
        /^[A-Za-z]:/.test(path) ||
        path.includes("\\") ||
        path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
        throw new ArchitectOutcomeContractError(
            "architect evidence path must be a portable project-relative path",
        )
    }
    return path
}

function safeCorrelationId(value: unknown, label: string): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_CORRELATION_ID_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ) {
        throw new ArchitectOutcomeContractError(`${label} is not a safe correlation id`)
    }
    return value
}

function boundedText(value: unknown, maximum: number, label: string): string {
    if (typeof value !== "string") {
        throw new ArchitectOutcomeContractError(`${label} must be a string`)
    }
    const normalized = value.replace(/\r\n?/g, "\n").trim()
    if (
        normalized.length === 0 ||
        normalized.length > maximum ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    ) {
        throw new ArchitectOutcomeContractError(`${label} is empty, too long, or unsafe`)
    }
    return normalized
}

function assertArchitectureDocument(text: string): void {
    const hasAdr = /^## ADR-\d{3}:\s+.+$/m.test(text)
    const hasFields = ["Status", "Context", "Decision", "Consequences"].every(
        (field) => new RegExp(`^\\*\\*${field}:\\*\\*`, "m").test(text),
    )
    const isTrivial = /^## ADR-001: No cross-cutting decisions needed$/m.test(text)
    const hasExistingContext = /^## Existing context$/m.test(text)
    if (!hasAdr || !hasFields || (!isTrivial && !hasExistingContext)) {
        throw new ArchitectOutcomeContractError(
            "ready architect outcome requires a valid ADR decisionDocument",
        )
    }
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
