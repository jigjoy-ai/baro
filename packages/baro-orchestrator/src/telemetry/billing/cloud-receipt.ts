/**
 * Canonical, lossless receipt returned by Baro Cloud after a gateway request
 * has reached a final metering decision.
 *
 * Money stays in integer nano-USD on the wire.  Do not replace this with a
 * floating-point field: `0` is a real settled charge while `null` means that
 * no authoritative amount exists.
 */

export const BILLING_MONEY_SCALE = 9 as const
export const MAX_BILLING_MONEY_NANOUNITS = BigInt(Number.MAX_SAFE_INTEGER)

export interface BillingMoney {
    readonly currency: "USD"
    /** Canonical non-negative base-10 integer, expressed at `scale`. */
    readonly amount: string
    readonly scale: typeof BILLING_MONEY_SCALE
}

/** Signed nano-USD, used only for a post-debit balance that may be overdrawn. */
export interface SignedBillingMoney {
    readonly currency: "USD"
    readonly amount: string
    readonly scale: typeof BILLING_MONEY_SCALE
}

export interface BillingTokenUsage {
    readonly inputTotal: number | null
    readonly cachedInput: number | null
    readonly cacheWriteInput: number | null
    readonly outputTotal: number | null
    readonly reasoningOutput: number | null
    readonly total: number | null
}

/** Backend-derived balance/allowance facts attached to a settled charge. */
export interface BillingChargeBreakdown {
    readonly markupMultiplier: number
    readonly allowanceApplied: BillingMoney
    readonly bankedDebit: BillingMoney
    readonly bankedBalanceAfter: SignedBillingMoney
    readonly allowanceRemaining: BillingMoney
    readonly insufficient: boolean
}

/** Diagnostic backend attribution. It is never local runtime authority. */
export interface BillingAttribution {
    readonly tenantId: string
    readonly runId: string
}

interface CloudBillingReceiptBase {
    readonly schemaVersion: 1
    readonly receiptId: string
    readonly chargeId: string
    readonly billingSessionId: string
    readonly invocationId: string
    readonly provider: string
    readonly requestedModel: string
    readonly resolvedModel: string
    readonly providerRequestId: string | null
    readonly tokens: BillingTokenUsage
    readonly state: "final"
    readonly rateCardVersion: string
    /** Canonical RFC 3339 UTC timestamp. */
    readonly settledAt: string
    readonly chargeBreakdown?: BillingChargeBreakdown
    readonly attribution?: BillingAttribution
}

export interface CompleteCloudBillingReceipt extends CloudBillingReceiptBase {
    readonly metering: "complete"
    readonly providerCost: BillingMoney | null
    /** A settled zero is represented as `{ amount: "0", ... }`, never null. */
    readonly customerCost: BillingMoney
}

export interface UnbillableCloudBillingReceipt extends CloudBillingReceiptBase {
    readonly metering: "unbillable"
    /** Unbillable is unknown, not a zero-priced invocation. */
    readonly providerCost: null
    readonly customerCost: null
    readonly unbillableReason: string
}

export type CloudBillingReceipt =
    | CompleteCloudBillingReceipt
    | UnbillableCloudBillingReceipt

const BASE_KEYS = [
    "schemaVersion",
    "receiptId",
    "chargeId",
    "billingSessionId",
    "invocationId",
    "provider",
    "requestedModel",
    "resolvedModel",
    "providerRequestId",
    "tokens",
    "state",
    "metering",
    "providerCost",
    "customerCost",
    "rateCardVersion",
    "settledAt",
] as const

const TOKEN_KEYS = [
    "inputTotal",
    "cachedInput",
    "cacheWriteInput",
    "outputTotal",
    "reasoningOutput",
    "total",
] as const

const MONEY_KEYS = ["currency", "amount", "scale"] as const
const CHARGE_BREAKDOWN_KEYS = [
    "markupMultiplier",
    "allowanceApplied",
    "bankedDebit",
    "bankedBalanceAfter",
    "allowanceRemaining",
    "insufficient",
] as const
const ATTRIBUTION_KEYS = ["tenantId", "runId"] as const

/** Parse and deeply freeze a receipt. Unknown fields fail closed. */
export function parseCloudBillingReceipt(value: unknown): CloudBillingReceipt {
    const record = plainRecord(value, "billing receipt")
    const metering = literal(record.metering, ["complete", "unbillable"], "metering")
    exactKeys(
        record,
        [
            ...BASE_KEYS,
            ...(hasOwn(record, "chargeBreakdown") ? ["chargeBreakdown"] : []),
            ...(hasOwn(record, "attribution") ? ["attribution"] : []),
            ...(metering === "unbillable" ? ["unbillableReason"] : []),
        ],
        "billing receipt",
    )

    if (record.schemaVersion !== 1) {
        throw new BillingReceiptValidationError("schemaVersion must be 1")
    }
    if (record.state !== "final") {
        throw new BillingReceiptValidationError("state must be final")
    }

    const base = {
        schemaVersion: 1 as const,
        receiptId: safeText(record.receiptId, "receiptId", 256),
        chargeId: safeText(record.chargeId, "chargeId", 256),
        billingSessionId: safeText(record.billingSessionId, "billingSessionId", 256),
        invocationId: safeText(record.invocationId, "invocationId", 256),
        provider: safeText(record.provider, "provider", 128),
        requestedModel: safeText(record.requestedModel, "requestedModel", 512),
        resolvedModel: safeText(record.resolvedModel, "resolvedModel", 512),
        providerRequestId:
            record.providerRequestId === null
                ? null
                : safeText(record.providerRequestId, "providerRequestId", 512),
        tokens: parseTokens(record.tokens),
        state: "final" as const,
        rateCardVersion: safeText(record.rateCardVersion, "rateCardVersion", 256),
        settledAt: parseSettledAt(record.settledAt),
        ...(hasOwn(record, "chargeBreakdown")
            ? { chargeBreakdown: parseChargeBreakdown(record.chargeBreakdown) }
            : {}),
        ...(hasOwn(record, "attribution")
            ? { attribution: parseAttribution(record.attribution) }
            : {}),
    }

    if (metering === "unbillable") {
        if (record.providerCost !== null || record.customerCost !== null) {
            throw new BillingReceiptValidationError(
                "unbillable receipt costs must be null, never zero",
            )
        }
        return deepFreeze({
            ...base,
            metering,
            providerCost: null,
            customerCost: null,
            unbillableReason: safeText(
                record.unbillableReason,
                "unbillableReason",
                1_024,
            ),
        })
    }

    const providerCost =
        record.providerCost === null
            ? null
            : parseBillingMoney(record.providerCost, "providerCost")
    const customerCost = parseBillingMoney(record.customerCost, "customerCost")

    return deepFreeze({
        ...base,
        metering,
        providerCost,
        customerCost,
    })
}

export function parseBillingMoney(value: unknown, path = "money"): BillingMoney {
    return parseMoney(value, path, false) as BillingMoney
}

export function parseSignedBillingMoney(
    value: unknown,
    path = "signedMoney",
): SignedBillingMoney {
    return parseMoney(value, path, true) as SignedBillingMoney
}

function parseMoney(
    value: unknown,
    path: string,
    signed: boolean,
): BillingMoney | SignedBillingMoney {
    const record = plainRecord(value, path)
    exactKeys(record, MONEY_KEYS, path)
    if (record.currency !== "USD") {
        throw new BillingReceiptValidationError(`${path}.currency must be USD`)
    }
    if (record.scale !== BILLING_MONEY_SCALE) {
        throw new BillingReceiptValidationError(`${path}.scale must be 9`)
    }
    const amountPattern = signed
        ? /^(?:0|-?[1-9][0-9]*)$/
        : /^(?:0|[1-9][0-9]*)$/
    if (typeof record.amount !== "string" || !amountPattern.test(record.amount)) {
        throw new BillingReceiptValidationError(
            `${path}.amount must be a canonical ${signed ? "signed" : "non-negative"} integer string`,
        )
    }
    const amount = BigInt(record.amount)
    if (
        amount > MAX_BILLING_MONEY_NANOUNITS ||
        amount < -MAX_BILLING_MONEY_NANOUNITS
    ) {
        throw new BillingReceiptValidationError(`${path}.amount exceeds the safe telemetry range`)
    }
    return Object.freeze({
        currency: "USD" as const,
        amount: record.amount,
        scale: BILLING_MONEY_SCALE,
    })
}

/** Convert validated nano-USD to the legacy numeric telemetry representation. */
export function billingMoneyToUsd(money: BillingMoney): number {
    const parsed = parseBillingMoney(money)
    return Number(BigInt(parsed.amount)) / 10 ** BILLING_MONEY_SCALE
}

export class BillingReceiptValidationError extends Error {
    override readonly name = "BillingReceiptValidationError"
}

function parseTokens(value: unknown): BillingTokenUsage {
    const record = plainRecord(value, "tokens")
    exactKeys(record, TOKEN_KEYS, "tokens")
    const tokens: BillingTokenUsage = {
        inputTotal: nullableSafeInteger(record.inputTotal, "tokens.inputTotal"),
        cachedInput: nullableSafeInteger(record.cachedInput, "tokens.cachedInput"),
        cacheWriteInput: nullableSafeInteger(
            record.cacheWriteInput,
            "tokens.cacheWriteInput",
        ),
        outputTotal: nullableSafeInteger(record.outputTotal, "tokens.outputTotal"),
        reasoningOutput: nullableSafeInteger(
            record.reasoningOutput,
            "tokens.reasoningOutput",
        ),
        total: nullableSafeInteger(record.total, "tokens.total"),
    }

    if (
        tokens.inputTotal !== null &&
        tokens.cachedInput !== null &&
        tokens.cachedInput > tokens.inputTotal
    ) {
        throw new BillingReceiptValidationError("tokens.cachedInput exceeds inputTotal")
    }
    if (
        tokens.inputTotal !== null &&
        tokens.cacheWriteInput !== null &&
        tokens.cacheWriteInput > tokens.inputTotal
    ) {
        throw new BillingReceiptValidationError("tokens.cacheWriteInput exceeds inputTotal")
    }
    if (
        tokens.outputTotal !== null &&
        tokens.reasoningOutput !== null &&
        tokens.reasoningOutput > tokens.outputTotal
    ) {
        throw new BillingReceiptValidationError("tokens.reasoningOutput exceeds outputTotal")
    }
    if (tokens.total !== null) {
        if (tokens.inputTotal !== null && tokens.total < tokens.inputTotal) {
            throw new BillingReceiptValidationError("tokens.total is less than inputTotal")
        }
        if (tokens.outputTotal !== null && tokens.total < tokens.outputTotal) {
            throw new BillingReceiptValidationError("tokens.total is less than outputTotal")
        }
        if (
            tokens.inputTotal !== null &&
            tokens.outputTotal !== null &&
            tokens.total !== tokens.inputTotal + tokens.outputTotal
        ) {
            throw new BillingReceiptValidationError(
                "tokens.total must equal inputTotal plus outputTotal",
            )
        }
    }
    return Object.freeze(tokens)
}

function parseChargeBreakdown(value: unknown): BillingChargeBreakdown {
    const record = plainRecord(value, "chargeBreakdown")
    exactKeys(record, CHARGE_BREAKDOWN_KEYS, "chargeBreakdown")
    if (
        typeof record.markupMultiplier !== "number" ||
        !Number.isFinite(record.markupMultiplier) ||
        record.markupMultiplier < 0 ||
        record.markupMultiplier > 1_000_000 ||
        Object.is(record.markupMultiplier, -0)
    ) {
        throw new BillingReceiptValidationError(
            "chargeBreakdown.markupMultiplier must be a finite non-negative number",
        )
    }
    if (typeof record.insufficient !== "boolean") {
        throw new BillingReceiptValidationError(
            "chargeBreakdown.insufficient must be boolean",
        )
    }
    return deepFreeze({
        markupMultiplier: record.markupMultiplier,
        allowanceApplied: parseBillingMoney(
            record.allowanceApplied,
            "chargeBreakdown.allowanceApplied",
        ),
        bankedDebit: parseBillingMoney(
            record.bankedDebit,
            "chargeBreakdown.bankedDebit",
        ),
        bankedBalanceAfter: parseSignedBillingMoney(
            record.bankedBalanceAfter,
            "chargeBreakdown.bankedBalanceAfter",
        ),
        allowanceRemaining: parseBillingMoney(
            record.allowanceRemaining,
            "chargeBreakdown.allowanceRemaining",
        ),
        insufficient: record.insufficient,
    })
}

function parseAttribution(value: unknown): BillingAttribution {
    const record = plainRecord(value, "attribution")
    exactKeys(record, ATTRIBUTION_KEYS, "attribution")
    return Object.freeze({
        tenantId: safeText(record.tenantId, "attribution.tenantId", 512),
        runId: safeText(record.runId, "attribution.runId", 512),
    })
}

function parseSettledAt(value: unknown): string {
    const text = safeText(value, "settledAt", 64)
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(text)
    if (!match) {
        throw new BillingReceiptValidationError("settledAt must be an RFC 3339 UTC timestamp")
    }
    const [, year, month, day, hour, minute, second] = match
    const millis = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
    )
    const date = new Date(millis)
    if (
        !Number.isFinite(millis) ||
        date.getUTCFullYear() !== Number(year) ||
        date.getUTCMonth() + 1 !== Number(month) ||
        date.getUTCDate() !== Number(day) ||
        date.getUTCHours() !== Number(hour) ||
        date.getUTCMinutes() !== Number(minute) ||
        date.getUTCSeconds() !== Number(second)
    ) {
        throw new BillingReceiptValidationError("settledAt is not a real UTC timestamp")
    }
    return text
}

function nullableSafeInteger(value: unknown, path: string): number | null {
    if (value === null) return null
    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 0 ||
        Object.is(value, -0)
    ) {
        throw new BillingReceiptValidationError(
            `${path} must be null or a non-negative safe integer`,
        )
    }
    return value as number
}

function safeText(value: unknown, path: string, maxLength: number): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        value !== value.trim() ||
        /[\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new BillingReceiptValidationError(`${path} must be safe non-empty text`)
    }
    return value
}

function literal<const T extends readonly string[]>(
    value: unknown,
    allowed: T,
    path: string,
): T[number] {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new BillingReceiptValidationError(
            `${path} must be one of ${allowed.join(", ")}`,
        )
    }
    return value as T[number]
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new BillingReceiptValidationError(`${path} must be an object`)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new BillingReceiptValidationError(`${path} must be a plain object`)
    }
    return value as Record<string, unknown>
}

function exactKeys(
    record: Record<string, unknown>,
    expected: readonly string[],
    path: string,
): void {
    const expectedSet = new Set(expected)
    const actual = Object.keys(record)
    const unknown = actual.filter((key) => !expectedSet.has(key))
    const missing = expected.filter((key) => !hasOwn(record, key))
    if (unknown.length > 0 || missing.length > 0 || actual.length !== expected.length) {
        throw new BillingReceiptValidationError(
            `${path} has invalid fields` +
                (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "") +
                (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
        )
    }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key)
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child)
    }
    return Object.freeze(value)
}
