import { Buffer } from "node:buffer"

export const REPOSITORY_BRIEF_SCHEMA_VERSION = 1 as const
export const MAX_REPOSITORY_BRIEF_BYTES = 64 * 1024

const MAX_SUMMARY_LENGTH = 8_000
const MAX_FACTS = 32
const MAX_FACT_LENGTH = 2_000
const MAX_RELEVANT_PATHS = 48
const MAX_UNKNOWNS = 16
const MAX_UNKNOWN_LENGTH = 1_000
const MAX_PATH_LENGTH = 512
const MAX_LINE_NUMBER = 2_147_483_647

export type RepositoryFactConfidence = "high" | "medium" | "low"

export interface RepositoryFactV1 {
    readonly statement: string
    readonly evidencePath: string
    /** Autonomous briefs accept this only for a line visibly returned by read/search. */
    readonly line?: number
    readonly confidence: RepositoryFactConfidence
}

/**
 * A bounded, repository-relative observation carried by Baro's trusted
 * read-only envelope and evidence-snapshot identity. Deterministic briefs use
 * the repository snapshot directly; successful autonomous briefs compose the
 * exact finishing bootstrap projection, visible observation suffix and omission
 * count.
 * Autonomous findings and every repository-derived string remain untrusted
 * data; correlation, bounds, and evidence identity are trusted, not semantic
 * truth of model-authored statements.
 */
export interface RepositoryBriefV1 {
    readonly schemaVersion: typeof REPOSITORY_BRIEF_SCHEMA_VERSION
    readonly snapshotId: string
    readonly summary: string
    readonly facts: readonly RepositoryFactV1[]
    readonly relevantPaths: readonly string[]
    readonly unknowns: readonly string[]
    readonly truncated: boolean
}

export class RepositoryBriefError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "RepositoryBriefError"
    }
}

/** Copy, strictly validate, size-bound, and deeply freeze a v1 brief. */
export function validateRepositoryBriefV1(value: unknown): RepositoryBriefV1 {
    if (!isExactRecord(value, [
        "schemaVersion",
        "snapshotId",
        "summary",
        "facts",
        "relevantPaths",
        "unknowns",
        "truncated",
    ])) {
        throw new RepositoryBriefError("repository brief must use the exact v1 schema")
    }
    if (value.schemaVersion !== REPOSITORY_BRIEF_SCHEMA_VERSION) {
        throw new RepositoryBriefError("unsupported repository brief schemaVersion")
    }
    if (
        typeof value.snapshotId !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(value.snapshotId)
    ) {
        throw new RepositoryBriefError("repository brief snapshotId is invalid")
    }
    const summary = boundedText(value.summary, MAX_SUMMARY_LENGTH, "repository summary")
    const facts = parseFacts(value.facts)
    const relevantPaths = parseUniquePaths(value.relevantPaths)
    const unknowns = parseUniqueTextList(
        value.unknowns,
        MAX_UNKNOWNS,
        MAX_UNKNOWN_LENGTH,
        "repository unknowns",
    )
    if (typeof value.truncated !== "boolean") {
        throw new RepositoryBriefError("repository brief truncated must be boolean")
    }

    const brief: RepositoryBriefV1 = {
        schemaVersion: REPOSITORY_BRIEF_SCHEMA_VERSION,
        snapshotId: value.snapshotId,
        summary,
        facts,
        relevantPaths,
        unknowns,
        truncated: value.truncated,
    }
    if (Buffer.byteLength(JSON.stringify(brief), "utf8") > MAX_REPOSITORY_BRIEF_BYTES) {
        throw new RepositoryBriefError(
            `repository brief exceeds ${MAX_REPOSITORY_BRIEF_BYTES} UTF-8 bytes`,
        )
    }
    return deepFreeze(brief)
}

/** Strict repository-relative evidence path validation shared by scanners. */
export function validateRepositoryEvidencePath(value: unknown): string {
    if (typeof value !== "string") {
        throw new RepositoryBriefError("repository evidence path must be a string")
    }
    if (
        value.length === 0 ||
        value.length > MAX_PATH_LENGTH ||
        value.startsWith("/") ||
        /^[A-Za-z]:/u.test(value) ||
        value.includes(":") ||
        value.includes("\\") ||
        value.endsWith("/") ||
        /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
    ) {
        throw new RepositoryBriefError("repository evidence path is unsafe")
    }
    const segments = value.split("/")
    if (segments.some((segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
    )) {
        throw new RepositoryBriefError("repository evidence path is not normalized")
    }
    return value
}

function parseFacts(value: unknown): RepositoryFactV1[] {
    if (!Array.isArray(value) || value.length > MAX_FACTS) {
        throw new RepositoryBriefError(`repository facts must contain at most ${MAX_FACTS} entries`)
    }
    const facts: RepositoryFactV1[] = []
    for (const candidate of value) {
        if (
            !isExactRecord(candidate, ["statement", "evidencePath", "confidence"]) &&
            !isExactRecord(candidate, ["statement", "evidencePath", "line", "confidence"])
        ) {
            throw new RepositoryBriefError("repository fact shape is not exact")
        }
        const confidence = candidate.confidence
        if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
            throw new RepositoryBriefError("repository fact confidence is invalid")
        }
        let line: number | undefined
        if ("line" in candidate) {
            if (
                !Number.isSafeInteger(candidate.line) ||
                Number(candidate.line) < 1 ||
                Number(candidate.line) > MAX_LINE_NUMBER
            ) {
                throw new RepositoryBriefError("repository fact line is invalid")
            }
            line = Number(candidate.line)
        }
        const fact: RepositoryFactV1 = {
            statement: boundedText(
                candidate.statement,
                MAX_FACT_LENGTH,
                "repository fact statement",
            ),
            evidencePath: validateRepositoryEvidencePath(candidate.evidencePath),
            ...(line !== undefined ? { line } : {}),
            confidence,
        }
        facts.push(Object.freeze(fact))
    }
    return facts
}

function parseUniquePaths(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MAX_RELEVANT_PATHS) {
        throw new RepositoryBriefError(
            `repository relevantPaths must contain at most ${MAX_RELEVANT_PATHS} entries`,
        )
    }
    const paths: string[] = []
    const seen = new Set<string>()
    for (const candidate of value) {
        const path = validateRepositoryEvidencePath(candidate)
        if (seen.has(path)) {
            throw new RepositoryBriefError("repository relevantPaths must be unique")
        }
        seen.add(path)
        paths.push(path)
    }
    return paths
}

function parseUniqueTextList(
    value: unknown,
    maximumItems: number,
    maximumLength: number,
    label: string,
): string[] {
    if (!Array.isArray(value) || value.length > maximumItems) {
        throw new RepositoryBriefError(`${label} contains too many entries`)
    }
    const result: string[] = []
    const seen = new Set<string>()
    for (const candidate of value) {
        const text = boundedText(candidate, maximumLength, label)
        if (seen.has(text)) {
            throw new RepositoryBriefError(`${label} must contain unique entries`)
        }
        seen.add(text)
        result.push(text)
    }
    return result
}

function boundedText(value: unknown, maximum: number, label: string): string {
    if (typeof value !== "string") {
        throw new RepositoryBriefError(`${label} must be a string`)
    }
    const text = value.replace(/\r\n?/gu, "\n").trim()
    if (
        text.length === 0 ||
        text.length > maximum ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)
    ) {
        throw new RepositoryBriefError(`${label} is empty, too long, or unsafe`)
    }
    return text
}

function isExactRecord(
    value: unknown,
    keys: readonly string[],
): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const actual = Object.keys(value)
    return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
    return Object.freeze(value)
}
