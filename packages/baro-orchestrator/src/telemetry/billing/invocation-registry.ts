import { randomBytes } from "node:crypto"

import type { ModelInvocationPhase } from "../model-telemetry.js"
import type { CloudBillingReceipt } from "./cloud-receipt.js"

const DEFAULT_MAX_ENTRIES = 50_000
const MAX_REGISTRY_ENTRIES = 1_000_000
const RECEIPT_FEED_PATH = "/v1/billing/receipts"

export interface TrustedGatewayIdentity {
    /** Exact configured base URL after safe normalization. */
    readonly baseUrl: string
    readonly origin: string
    /** Fixed, same-origin endpoint used for authoritative receipt reads. */
    readonly receiptFeedUrl: string
}

export interface BillingInvocationContext {
    readonly runId: string | null
    readonly phase: ModelInvocationPhase
    readonly storyId: string | null
    readonly leaseId: string | null
    readonly generation: number | null
    readonly attempt: number | null
    readonly turn: number | null
    readonly round: number | null
    readonly backend: string
    readonly requestedModel: string | null
}

/** Immutable local authority allocated before a model request is dispatched. */
export interface BillingInvocationRecord extends BillingInvocationContext {
    readonly billingSessionId: string
    readonly invocationId: string
    readonly trustedGateway: TrustedGatewayIdentity
}

export interface BillingInvocationRegistryOptions {
    readonly trustedGateway: TrustedGatewayIdentity
    readonly maxEntries?: number
}

/**
 * Per-process/session local correlation authority.
 *
 * Gateway receipts are permitted to contribute provider facts and money, but
 * never run/story/lease/backend dimensions. Those are retained here before
 * dispatch and resolved by exact `(session, invocation)` identity later.
 */
export class BillingInvocationRegistry {
    readonly billingSessionId = randomOpaqueId("bsess")
    readonly trustedGateway: TrustedGatewayIdentity

    private readonly maxEntries: number
    private readonly records = new Map<string, BillingInvocationRecord>()

    constructor(options: BillingInvocationRegistryOptions) {
        this.trustedGateway = validateTrustedGatewayIdentity(options.trustedGateway)
        this.maxEntries = boundedInteger(
            options.maxEntries ?? DEFAULT_MAX_ENTRIES,
            "maxEntries",
            1,
            MAX_REGISTRY_ENTRIES,
        )
    }

    get size(): number {
        return this.records.size
    }

    allocate(context: BillingInvocationContext): BillingInvocationRecord {
        const validated = validateContext(context)
        let invocationId: string
        do invocationId = randomOpaqueId("binv")
        while (this.records.has(invocationId))

        const record = deepFreeze({
            ...validated,
            billingSessionId: this.billingSessionId,
            invocationId,
            trustedGateway: this.trustedGateway,
        })
        this.records.set(invocationId, record)
        while (this.records.size > this.maxEntries) {
            const oldest = this.records.keys().next().value as string | undefined
            if (oldest === undefined) break
            this.records.delete(oldest)
        }
        return record
    }

    /** Exact lookup; no prefix, lease, story, or provider fallback is allowed. */
    get(invocationId: string): BillingInvocationRecord | undefined {
        if (typeof invocationId !== "string" || invocationId.length === 0) return undefined
        return this.records.get(invocationId)
    }

    requireForReceipt(
        receipt: Pick<CloudBillingReceipt, "billingSessionId" | "invocationId">,
        sourceGateway: TrustedGatewayIdentity,
    ): BillingInvocationRecord {
        const source = validateTrustedGatewayIdentity(sourceGateway)
        if (
            source.baseUrl !== this.trustedGateway.baseUrl ||
            source.receiptFeedUrl !== this.trustedGateway.receiptFeedUrl
        ) {
            throw new BillingInvocationAuthorityError("receipt came from an untrusted gateway")
        }
        if (receipt.billingSessionId !== this.billingSessionId) {
            throw new BillingInvocationAuthorityError("receipt belongs to a foreign billing session")
        }
        const record = this.records.get(receipt.invocationId)
        if (!record) {
            throw new BillingInvocationAuthorityError("receipt has an unknown invocationId")
        }
        return record
    }
}

export class BillingInvocationAuthorityError extends Error {
    override readonly name = "BillingInvocationAuthorityError"
}

/** Validate once and retain only an absolute HTTP(S) gateway identity. */
export function createTrustedGatewayIdentity(baseUrl: string): TrustedGatewayIdentity {
    if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl !== baseUrl.trim()) {
        throw new TypeError("gatewayBaseUrl must be explicit safe text")
    }
    let url: URL
    try {
        url = new URL(baseUrl)
    } catch {
        throw new TypeError("gatewayBaseUrl must be an absolute URL")
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError("gatewayBaseUrl must use http or https")
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        throw new TypeError(
            "gatewayBaseUrl must use https outside loopback development",
        )
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new TypeError("gatewayBaseUrl must not contain credentials, query, or fragment")
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/"
    url.pathname = pathname
    const baseUrlNormalized = url.toString()
    const feed = new URL(RECEIPT_FEED_PATH, url.origin)
    if (feed.origin !== url.origin) {
        throw new TypeError("receipt endpoint must remain on the trusted gateway origin")
    }
    return Object.freeze({
        baseUrl: baseUrlNormalized,
        origin: url.origin,
        receiptFeedUrl: feed.toString(),
    })
}

function isLoopbackHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
    return (
        normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1"
    )
}

function validateTrustedGatewayIdentity(
    identity: TrustedGatewayIdentity,
): TrustedGatewayIdentity {
    if (!identity || typeof identity !== "object") {
        throw new TypeError("trustedGateway is required")
    }
    const canonical = createTrustedGatewayIdentity(identity.baseUrl)
    if (
        identity.origin !== canonical.origin ||
        identity.receiptFeedUrl !== canonical.receiptFeedUrl
    ) {
        throw new TypeError("trustedGateway identity is not canonical")
    }
    return canonical
}

function validateContext(context: BillingInvocationContext): BillingInvocationContext {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
        throw new TypeError("billing invocation context is required")
    }
    const expected = new Set([
        "runId",
        "phase",
        "storyId",
        "leaseId",
        "generation",
        "attempt",
        "turn",
        "round",
        "backend",
        "requestedModel",
    ])
    const actual = Object.keys(context)
    if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
        throw new TypeError("billing invocation context has invalid fields")
    }
    const phases = new Set<ModelInvocationPhase>([
        "intake",
        "architect",
        "planner",
        "story",
        "critic",
        "surgeon",
        "dialogue",
        "verifier",
    ])
    if (!phases.has(context.phase)) throw new TypeError("invalid billing invocation phase")

    return Object.freeze({
        runId: nullableText(context.runId, "runId", 512),
        phase: context.phase,
        storyId: nullableText(context.storyId, "storyId", 512),
        leaseId: nullableText(context.leaseId, "leaseId", 512),
        generation: nullableInteger(context.generation, "generation"),
        attempt: nullableInteger(context.attempt, "attempt"),
        turn: nullableInteger(context.turn, "turn"),
        round: nullableInteger(context.round, "round"),
        backend: safeText(context.backend, "backend", 128),
        requestedModel: nullableText(context.requestedModel, "requestedModel", 512),
    })
}

function nullableInteger(value: unknown, name: string): number | null {
    if (value === null) return null
    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 0 ||
        Object.is(value, -0)
    ) {
        throw new TypeError(`${name} must be null or a non-negative safe integer`)
    }
    return value as number
}

function boundedInteger(
    value: unknown,
    name: string,
    minimum: number,
    maximum: number,
): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new RangeError(`${name} must be a safe integer from ${minimum} to ${maximum}`)
    }
    return value as number
}

function nullableText(value: unknown, name: string, maximum: number): string | null {
    return value === null ? null : safeText(value, name, maximum)
}

function safeText(value: unknown, name: string, maximum: number): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        value !== value.trim() ||
        /[\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new TypeError(`${name} must be safe non-empty text`)
    }
    return value
}

function randomOpaqueId(prefix: string): string {
    return `${prefix}_${randomBytes(24).toString("base64url")}`
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    return Object.freeze(value)
}
