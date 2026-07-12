import {
    type ProviderCapacityCode,
    type StoryFailureData,
} from "./semantic-events.js"

interface ClassifiedFailure {
    failure: StoryFailureData
    confidence: number
}

const MAX_INSPECTION_DEPTH = 4

/**
 * Turn provider-specific errors into the bounded failure vocabulary carried
 * by StoryResult. Structured status/code fields win over message heuristics.
 *
 * Multiple signals may be supplied (for example a Claude rate-limit frame
 * and its terminal result text); the strongest classification is returned
 * and retry timing is retained from either signal.
 */
export function classifyProviderFailure(
    ...signals: readonly unknown[]
): StoryFailureData | undefined {
    let strongest: ClassifiedFailure | undefined
    let retryAfterMs: number | undefined

    for (const signal of signals) {
        const classified = classifyOne(signal, 0, new Set<object>())
        if (classified && (!strongest || classified.confidence > strongest.confidence)) {
            strongest = classified
        }
        retryAfterMs ??= extractRetryAfterMs(signal)
    }

    if (!strongest) return undefined
    return retryAfterMs === undefined
        ? strongest.failure
        : { ...strongest.failure, retryAfterMs }
}

/**
 * Policy predicate for an already-classified failure/result. Deliberately
 * does not infer from StoryResult.error: old audit events that omit `failure`
 * must retain legacy execution-recovery behavior.
 */
export function isProviderCapacityFailure(value: unknown): boolean {
    if (!isRecord(value)) return false
    if (value.kind === "provider_capacity") return true

    const failure = value.failure
    if (isRecord(failure) && failure.kind === "provider_capacity") return true

    const data = value.data
    return (
        isRecord(data) &&
        isRecord(data.failure) &&
        data.failure.kind === "provider_capacity"
    )
}

/** Collapse untrusted provider diagnostics before publishing them on the bus. */
export function compactProviderFailureDetail(
    value: unknown,
    maxLength = 240,
): string {
    const text = failureText(value)
    if (!text || maxLength <= 0) return ""
    const compact = text.replace(/\s+/g, " ").trim()
    if (compact.length <= maxLength) return compact
    if (maxLength === 1) return "…"
    return `${compact.slice(0, maxLength - 1).trimEnd()}…`
}

function classifyOne(
    value: unknown,
    depth: number,
    seen: Set<object>,
): ClassifiedFailure | undefined {
    if (typeof value === "string") return classifyMessage(value)
    if (!isRecord(value) || depth > MAX_INSPECTION_DEPTH || seen.has(value)) {
        return undefined
    }
    seen.add(value)

    if (value.kind === "provider_capacity") {
        const code = capacityCode(value.code)
        const retryAfterMs = extractRetryAfterMs(value)
        return {
            failure: {
                kind: "provider_capacity",
                ...(code ? { code } : {}),
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            },
            confidence: 100,
        }
    }

    const claudeRateLimit = classifyClaudeRateLimit(value)
    if (claudeRateLimit.handled) return claudeRateLimit.classified

    const status = firstValue(value, [
        "statusCode",
        "status_code",
        "httpStatus",
        "http_status",
        "status",
    ])
    const statusClassification = classifyHttpStatus(status)
    if (statusClassification) return statusClassification

    for (const key of ["code", "errorCode", "error_code", "type"] as const) {
        const classified = classifyCode(value[key])
        if (classified) return classified
    }

    let bestMessage: ClassifiedFailure | undefined
    for (const key of [
        "message",
        "detail",
        "reason",
        "resultText",
        "result",
        "error_description",
    ] as const) {
        const field = value[key]
        if (typeof field !== "string") continue
        const classified = classifyMessage(field)
        if (classified && (!bestMessage || classified.confidence > bestMessage.confidence)) {
            bestMessage = classified
        }
    }

    for (const key of ["error", "cause", "response", "data", "body", "details"] as const) {
        const nested = value[key]
        if (nested === undefined || nested === null) continue
        const classified = classifyOne(nested, depth + 1, seen)
        if (classified && (!bestMessage || classified.confidence > bestMessage.confidence)) {
            bestMessage = classified
        }
    }

    return bestMessage
}

function classifyClaudeRateLimit(value: Record<string, unknown>): {
    handled: boolean
    classified?: ClassifiedFailure
} {
    const envelopeType = normalizeCode(value.type)
    const nested = isRecord(value.rate_limit_info)
        ? value.rate_limit_info
        : isRecord(value.rateLimitInfo)
          ? value.rateLimitInfo
          : null
    const info = nested ?? value
    const looksLikeRateLimit =
        envelopeType === "rate_limit_event" ||
        "rateLimitType" in info ||
        "rate_limit_type" in info ||
        "resetsAt" in info ||
        "resets_at" in info

    if (!looksLikeRateLimit) return { handled: false }

    const status = normalizeCode(info.status)
    // Claude emits informational rate_limit_event frames while the request is
    // still allowed. Their overageDisabledReason can be out_of_credits and is
    // not itself evidence that the primary route is unavailable.
    if (["allowed", "ok", "active"].includes(status)) {
        return { handled: true }
    }
    if (!["rejected", "denied", "blocked", "exhausted"].includes(status)) {
        return { handled: envelopeType === "rate_limit_event" }
    }

    const limitType = normalizeCode(
        firstValue(info, ["rateLimitType", "rate_limit_type"]),
    )
    const disabledReason = normalizeCode(
        firstValue(info, ["overageDisabledReason", "overage_disabled_reason"]),
    )
    const code: ProviderCapacityCode =
        /(?:five_hour|seven_day|session|usage)/.test(limitType)
            ? "session_limit"
            : classifyCodeValue(disabledReason) ?? "rate_limited"
    const retryAfterMs = extractRetryAfterMs(info)

    return {
        handled: true,
        classified: {
            failure: {
                kind: "provider_capacity",
                code,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            },
            confidence: 95,
        },
    }
}

function classifyHttpStatus(value: unknown): ClassifiedFailure | undefined {
    const status = numericStatus(value)
    let code: ProviderCapacityCode | undefined
    if (status === 402) code = "quota_exhausted"
    else if (status === 429) code = "rate_limited"
    else if (status === 529) code = "overloaded"
    else if (status === 503) code = "capacity_unavailable"
    if (!code) return undefined
    return classified(code, 90)
}

function classifyCode(value: unknown): ClassifiedFailure | undefined {
    const code = classifyCodeValue(normalizeCode(value))
    return code ? classified(code, 85) : undefined
}

function classifyCodeValue(code: string): ProviderCapacityCode | undefined {
    if (!code) return undefined
    if (
        /^(?:session_limit|session_usage_limit|usage_limit|five_hour_limit|seven_day_limit)$/.test(
            code,
        )
    ) {
        return "session_limit"
    }
    if (
        /^(?:insufficient_quota|quota_exceeded|quota_exhausted|out_of_credits?|billing_hard_limit_reached|credit_balance_too_low|payment_required)$/.test(
            code,
        )
    ) {
        return "quota_exhausted"
    }
    if (
        /^(?:rate_limit|rate_limited|rate_limit_exceeded|too_many_requests|requests_limit_exceeded)$/.test(
            code,
        )
    ) {
        return "rate_limited"
    }
    if (
        /^(?:overloaded|overloaded_error|server_overloaded|model_overloaded|engine_overloaded)$/.test(
            code,
        )
    ) {
        return "overloaded"
    }
    if (
        /^(?:capacity_unavailable|no_capacity|resource_exhausted|service_unavailable)$/.test(
            code,
        )
    ) {
        return "capacity_unavailable"
    }
    return undefined
}

function classifyMessage(message: string): ClassifiedFailure | undefined {
    const text = message.replace(/\s+/g, " ").trim()
    if (!text) return undefined
    if (
        /(?:hit|reached|exceeded|exhausted)(?: your)? (?:current )?session limit|session(?: usage)? limit(?: reached| exceeded| exhausted)|(?:five[- ]hour|seven[- ]day) limit/i.test(
            text,
        )
    ) {
        return classified("session_limit", 65)
    }
    if (
        /insufficient[_ -]?quota|quota (?:has been )?(?:exceeded|exhausted)|exceeded (?:your )?(?:current )?quota|out[_ -]?of[_ -]?credits?|credit balance (?:is )?too low|billing (?:hard )?limit|payment required/i.test(
            text,
        )
    ) {
        return classified("quota_exhausted", 60)
    }
    if (/rate[_ -]?limit(?:ed| exceeded)?|too many requests|\bhttp\s*429\b|\bstatus(?: code)?\s*429\b|\berror\s*429\b/i.test(text)) {
        return classified("rate_limited", 55)
    }
    if (/\boverloaded\b|server over capacity|model over capacity/i.test(text)) {
        return classified("overloaded", 50)
    }
    if (/capacity (?:is )?unavailable|no (?:available )?capacity|temporarily unavailable due to capacity/i.test(text)) {
        return classified("capacity_unavailable", 45)
    }
    return undefined
}

function classified(code: ProviderCapacityCode, confidence: number): ClassifiedFailure {
    return {
        failure: { kind: "provider_capacity", code },
        confidence,
    }
}

function capacityCode(value: unknown): ProviderCapacityCode | undefined {
    const code = normalizeCode(value)
    return [
        "session_limit",
        "quota_exhausted",
        "rate_limited",
        "overloaded",
        "capacity_unavailable",
    ].includes(code)
        ? (code as ProviderCapacityCode)
        : undefined
}

function extractRetryAfterMs(
    value: unknown,
    depth = 0,
    seen = new Set<object>(),
): number | undefined {
    if (
        !isRecord(value) ||
        depth > MAX_INSPECTION_DEPTH ||
        seen.has(value)
    ) {
        return undefined
    }
    seen.add(value)

    const explicitMs = finiteNonNegative(
        firstValue(value, ["retryAfterMs", "retry_after_ms"]),
    )
    if (explicitMs !== undefined) return Math.round(explicitMs)

    const retryAfter = firstValue(value, ["retryAfter", "retry_after"])
    const fromRetryAfter = retryAfterHeaderMs(retryAfter)
    if (fromRetryAfter !== undefined) return fromRetryAfter

    const headers = value.headers
    if (headers !== undefined) {
        const headerMs = headerValue(headers, "retry-after-ms")
        const parsedHeaderMs = finiteNonNegative(headerMs)
        if (parsedHeaderMs !== undefined) return Math.round(parsedHeaderMs)
        const parsedHeader = retryAfterHeaderMs(headerValue(headers, "retry-after"))
        if (parsedHeader !== undefined) return parsedHeader
    }

    const reset = finiteNonNegative(
        firstValue(value, ["resetsAt", "resets_at", "resetAt", "reset_at"]),
    )
    if (reset !== undefined) {
        const epochMs = reset < 10_000_000_000 ? reset * 1000 : reset
        const remaining = Math.round(epochMs - Date.now())
        if (remaining > 0) return remaining
    }

    for (const key of ["rate_limit_info", "rateLimitInfo", "error", "response"] as const) {
        const nested = value[key]
        const retry = extractRetryAfterMs(nested, depth + 1, seen)
        if (retry !== undefined) return retry
    }
    return undefined
}

function retryAfterHeaderMs(value: unknown): number | undefined {
    const seconds = finiteNonNegative(value)
    if (seconds !== undefined) return Math.round(seconds * 1000)
    if (typeof value !== "string") return undefined
    const at = Date.parse(value)
    if (!Number.isFinite(at)) return undefined
    const remaining = Math.round(at - Date.now())
    return remaining > 0 ? remaining : undefined
}

function headerValue(headers: unknown, name: string): unknown {
    if (isRecord(headers)) {
        const direct =
            headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
        if (direct !== undefined) return direct
    }
    if (
        typeof headers === "object" &&
        headers !== null &&
        "get" in headers &&
        typeof (headers as { get?: unknown }).get === "function"
    ) {
        try {
            return (headers as { get(name: string): unknown }).get(name)
        } catch {
            return undefined
        }
    }
    return undefined
}

function numericStatus(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value !== "string") return undefined
    const match = value.trim().match(/^(?:http[_ -]?)?(\d{3})$/i)
    return match ? Number(match[1]) : undefined
}

function finiteNonNegative(value: unknown): number | undefined {
    const number =
        typeof value === "number"
            ? value
            : typeof value === "string" && value.trim() !== ""
              ? Number(value)
              : Number.NaN
    return Number.isFinite(number) && number >= 0 ? number : undefined
}

function normalizeCode(value: unknown): string {
    return typeof value === "string"
        ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
        : ""
}

function failureText(value: unknown): string {
    if (typeof value === "string") return value
    if (value instanceof Error) return value.message
    if (!isRecord(value)) return value == null ? "" : String(value)
    for (const key of ["message", "detail", "reason", "resultText", "result"] as const) {
        if (typeof value[key] === "string") return value[key]
    }
    // Never stringify an opaque SDK/provider object. It commonly contains
    // request headers, Authorization/API keys, and full request bodies.
    return ""
}

function firstValue(
    value: Record<string, unknown>,
    keys: readonly string[],
): unknown {
    for (const key of keys) {
        if (value[key] !== undefined) return value[key]
    }
    return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}
