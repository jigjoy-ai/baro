import {
    BillingReceiptValidationError,
    parseCloudBillingReceipt,
    type CloudBillingReceipt,
} from "./cloud-receipt.js"
import {
    createTrustedGatewayIdentity,
    type TrustedGatewayIdentity,
} from "./invocation-registry.js"

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_PAGES = 100
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
const DEFAULT_RETRY_BASE_DELAY_MS = 50

export interface CloudBillingFeedPage {
    readonly schemaVersion: 1
    readonly billingSessionId: string
    readonly receipts: readonly CloudBillingReceipt[]
    /** Opaque committed watermark. It must never contain credentials. */
    readonly nextCursor: string
    readonly hasMore: boolean
}

export type BillingReceiptSink = (
    receipt: CloudBillingReceipt,
) => void | Promise<void>

export interface BillingReceiptFeedClientOptions {
    readonly gatewayBaseUrl: string
    readonly apiKey: string
    readonly billingSessionId: string
    readonly initialCursor?: string | null
    readonly timeoutMs?: number
    readonly maxRetries?: number
    readonly maxPages?: number
    readonly pageSize?: number
    readonly maxResponseBytes?: number
    readonly retryBaseDelayMs?: number
    /** Persist the watermark after all receipt sinks for a page have returned. */
    readonly commitCursor?: (cursor: string) => void | Promise<void>
    /** Test seam; production callers should use the platform fetch. */
    readonly fetchImpl?: typeof fetch
}

export interface BillingFeedPullResult {
    readonly pages: 1
    readonly deliveredReceipts: number
    readonly cursor: string
    readonly hasMore: boolean
}

export interface BillingFeedDrainResult {
    readonly pages: number
    readonly deliveredReceipts: number
    readonly cursor: string | null
}

/** Authenticated, bounded cursor reader for final cloud billing receipts. */
export class BillingReceiptFeedClient {
    readonly trustedGateway: TrustedGatewayIdentity
    readonly billingSessionId: string

    private readonly apiKey: string
    private readonly timeoutMs: number
    private readonly maxRetries: number
    private readonly maxPages: number
    private readonly pageSize: number
    private readonly maxResponseBytes: number
    private readonly retryBaseDelayMs: number
    private readonly commitCursor?: (cursor: string) => void | Promise<void>
    private readonly fetchImpl: typeof fetch
    private currentCursor: string | null
    private activeController: AbortController | null = null
    private closed = false

    constructor(options: BillingReceiptFeedClientOptions) {
        this.trustedGateway = createTrustedGatewayIdentity(options.gatewayBaseUrl)
        this.apiKey = secretText(options.apiKey, "apiKey", 16_384)
        this.billingSessionId = safeText(
            options.billingSessionId,
            "billingSessionId",
            256,
        )
        this.currentCursor =
            options.initialCursor === undefined || options.initialCursor === null
                ? null
                : safeText(options.initialCursor, "initialCursor", 2_048)
        this.timeoutMs = boundedInteger(
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            "timeoutMs",
            1,
            60_000,
        )
        this.maxRetries = boundedInteger(
            options.maxRetries ?? DEFAULT_MAX_RETRIES,
            "maxRetries",
            0,
            8,
        )
        this.maxPages = boundedInteger(
            options.maxPages ?? DEFAULT_MAX_PAGES,
            "maxPages",
            1,
            10_000,
        )
        this.pageSize = boundedInteger(
            options.pageSize ?? DEFAULT_PAGE_SIZE,
            "pageSize",
            1,
            100,
        )
        this.maxResponseBytes = boundedInteger(
            options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
            "maxResponseBytes",
            256,
            16 * 1_048_576,
        )
        this.retryBaseDelayMs = boundedInteger(
            options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
            "retryBaseDelayMs",
            0,
            2_000,
        )
        this.commitCursor = options.commitCursor
        this.fetchImpl = options.fetchImpl ?? fetch
    }

    get cursor(): string | null {
        return this.currentCursor
    }

    /** Read and commit exactly one page. */
    async pull(sink: BillingReceiptSink): Promise<BillingFeedPullResult> {
        return this.withOperation(async (controller) => {
            const result = await this.pullPage(sink, controller.signal)
            return Object.freeze({ pages: 1 as const, ...result })
        })
    }

    /** Drain currently available pages, never more than the configured bound. */
    async drain(sink: BillingReceiptSink): Promise<BillingFeedDrainResult> {
        return this.withOperation(async (controller) => {
            let pages = 0
            let deliveredReceipts = 0
            while (true) {
                if (pages >= this.maxPages) {
                    throw new BillingFeedLimitError("billing feed page limit reached")
                }
                const page = await this.pullPage(sink, controller.signal)
                pages += 1
                deliveredReceipts += page.deliveredReceipts
                if (!page.hasMore) {
                    return Object.freeze({
                        pages,
                        deliveredReceipts,
                        cursor: this.currentCursor,
                    })
                }
            }
        })
    }

    /** Abort the current pull/drain. A later operation may be started. */
    abort(reason = "billing feed aborted"): void {
        this.activeController?.abort(new BillingFeedAbortedError(safeAbortReason(reason)))
    }

    /** Permanently close this reader and abort an in-flight operation. */
    close(): void {
        if (this.closed) return
        this.closed = true
        this.activeController?.abort(new BillingFeedClosedError("billing feed client is closed"))
    }

    private async withOperation<T>(
        operation: (controller: AbortController) => Promise<T>,
    ): Promise<T> {
        if (this.closed) throw new BillingFeedClosedError("billing feed client is closed")
        if (this.activeController) {
            throw new BillingFeedStateError("a billing feed operation is already active")
        }
        const controller = new AbortController()
        this.activeController = controller
        try {
            return await operation(controller)
        } finally {
            if (this.activeController === controller) this.activeController = null
        }
    }

    private async pullPage(
        sink: BillingReceiptSink,
        operationSignal: AbortSignal,
    ): Promise<{
        readonly deliveredReceipts: number
        readonly cursor: string
        readonly hasMore: boolean
    }> {
        const previousCursor = this.currentCursor
        const page = await this.fetchPage(previousCursor, operationSignal)
        if (page.billingSessionId !== this.billingSessionId) {
            throw new BillingFeedProtocolError("billing feed returned a foreign session")
        }
        if (
            page.hasMore &&
            (page.nextCursor.length === 0 || page.nextCursor === previousCursor)
        ) {
            throw new BillingFeedProtocolError("billing feed did not advance its cursor")
        }
        if (page.receipts.length > 0 && page.nextCursor === previousCursor) {
            throw new BillingFeedProtocolError("receipt page did not advance its cursor")
        }

        for (const receipt of page.receipts) {
            if (operationSignal.aborted) throw abortReason(operationSignal)
            await sink(receipt)
            if (operationSignal.aborted) throw abortReason(operationSignal)
        }
        // Sink completion is the acceptance/persistence boundary. Cursor
        // persistence and in-memory advancement happen only after every sink.
        if (operationSignal.aborted) throw abortReason(operationSignal)
        await this.commitCursor?.(page.nextCursor)
        if (operationSignal.aborted) throw abortReason(operationSignal)
        this.currentCursor = page.nextCursor
        return Object.freeze({
            deliveredReceipts: page.receipts.length,
            cursor: page.nextCursor,
            hasMore: page.hasMore,
        })
    }

    private async fetchPage(
        cursor: string | null,
        operationSignal: AbortSignal,
    ): Promise<CloudBillingFeedPage> {
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            if (operationSignal.aborted) throw abortReason(operationSignal)
            const requestController = new AbortController()
            let timedOut = false
            const propagateAbort = () => requestController.abort(operationSignal.reason)
            operationSignal.addEventListener("abort", propagateAbort, { once: true })
            const timeout = setTimeout(() => {
                timedOut = true
                requestController.abort(
                    new BillingFeedTimeoutError("billing feed request timed out"),
                )
            }, this.timeoutMs)

            try {
                const endpoint = new URL(this.trustedGateway.receiptFeedUrl)
                endpoint.searchParams.set("session_id", this.billingSessionId)
                endpoint.searchParams.set("limit", String(this.pageSize))
                if (cursor !== null) endpoint.searchParams.set("after", cursor)
                if (endpoint.origin !== this.trustedGateway.origin) {
                    throw new BillingFeedProtocolError(
                        "billing endpoint escaped the trusted gateway origin",
                    )
                }
                const response = await this.fetchImpl(endpoint, {
                    method: "GET",
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${this.apiKey}`,
                    },
                    redirect: "error",
                    signal: requestController.signal,
                })
                if (response.url) {
                    const responseUrl = new URL(response.url)
                    if (
                        responseUrl.origin !== this.trustedGateway.origin ||
                        responseUrl.pathname !== endpoint.pathname
                    ) {
                        await response.body?.cancel()
                        throw new BillingFeedProtocolError(
                            "billing response came from an unexpected endpoint",
                        )
                    }
                }
                if (!response.ok) {
                    await response.body?.cancel()
                    if (retryableStatus(response.status) && attempt < this.maxRetries) {
                        await retryDelay(this.retryBaseDelayMs, attempt, operationSignal)
                        continue
                    }
                    throw new BillingFeedHttpError(response.status)
                }
                const contentType = response.headers.get("content-type") ?? ""
                if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
                    await response.body?.cancel()
                    throw new BillingFeedProtocolError(
                        "billing feed response is not JSON",
                    )
                }
                const text = await readBoundedText(response, this.maxResponseBytes)
                let parsed: unknown
                try {
                    parsed = JSON.parse(text)
                } catch {
                    throw new BillingFeedProtocolError("billing feed returned malformed JSON")
                }
                return parseCloudBillingFeedPage(parsed, this.pageSize)
            } catch (error) {
                if (operationSignal.aborted) throw abortReason(operationSignal)
                if (
                    error instanceof BillingFeedProtocolError ||
                    error instanceof BillingFeedHttpError ||
                    error instanceof BillingFeedLimitError
                ) {
                    throw error
                }
                if (attempt >= this.maxRetries) {
                    if (timedOut || error instanceof BillingFeedTimeoutError) {
                        throw new BillingFeedTimeoutError("billing feed request timed out")
                    }
                    throw new BillingFeedTransportError("billing feed request failed")
                }
                await retryDelay(this.retryBaseDelayMs, attempt, operationSignal)
            } finally {
                clearTimeout(timeout)
                operationSignal.removeEventListener("abort", propagateAbort)
            }
        }
        throw new BillingFeedTransportError("billing feed request failed")
    }
}

export function parseCloudBillingFeedPage(
    value: unknown,
    maximumReceipts = DEFAULT_PAGE_SIZE,
): CloudBillingFeedPage {
    const record = plainRecord(value, "billing feed page")
    exactKeys(
        record,
        ["schemaVersion", "billingSessionId", "receipts", "nextCursor", "hasMore"],
        "billing feed page",
    )
    if (record.schemaVersion !== 1) {
        throw new BillingFeedProtocolError("billing feed schemaVersion must be 1")
    }
    if (!Array.isArray(record.receipts) || record.receipts.length > maximumReceipts) {
        throw new BillingFeedProtocolError("billing feed receipts exceed the page bound")
    }
    if (typeof record.hasMore !== "boolean") {
        throw new BillingFeedProtocolError("billing feed hasMore must be boolean")
    }
    let receipts: readonly CloudBillingReceipt[]
    try {
        receipts = Object.freeze(record.receipts.map(parseCloudBillingReceipt))
    } catch (error) {
        if (error instanceof BillingReceiptValidationError) {
            throw new BillingFeedProtocolError("billing feed contains a malformed receipt")
        }
        throw error
    }
    const page: CloudBillingFeedPage = {
        schemaVersion: 1,
        billingSessionId: safeText(record.billingSessionId, "billingSessionId", 256),
        receipts,
        nextCursor: safeText(record.nextCursor, "nextCursor", 2_048),
        hasMore: record.hasMore,
    }
    return deepFreeze(page)
}

export class BillingFeedProtocolError extends Error {
    override readonly name = "BillingFeedProtocolError"
}

export class BillingFeedHttpError extends Error {
    override readonly name = "BillingFeedHttpError"

    constructor(readonly status: number) {
        super(`billing feed HTTP ${status}`)
    }
}

export class BillingFeedTimeoutError extends Error {
    override readonly name = "BillingFeedTimeoutError"
}

export class BillingFeedTransportError extends Error {
    override readonly name = "BillingFeedTransportError"
}

export class BillingFeedLimitError extends Error {
    override readonly name = "BillingFeedLimitError"
}

export class BillingFeedAbortedError extends Error {
    override readonly name = "BillingFeedAbortedError"
}

export class BillingFeedClosedError extends Error {
    override readonly name = "BillingFeedClosedError"
}

export class BillingFeedStateError extends Error {
    override readonly name = "BillingFeedStateError"
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
    const contentLength = response.headers.get("content-length")
    if (contentLength !== null) {
        const parsed = Number(contentLength)
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
            await response.body?.cancel()
            throw new BillingFeedLimitError("billing feed response is too large")
        }
    }
    if (!response.body) return ""
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maximumBytes) {
                await reader.cancel()
                throw new BillingFeedLimitError("billing feed response is too large")
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.byteLength
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(joined)
    } catch {
        throw new BillingFeedProtocolError("billing feed response is not valid UTF-8")
    }
}

function retryableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500
}

async function retryDelay(
    baseMs: number,
    attempt: number,
    signal: AbortSignal,
): Promise<void> {
    const duration = Math.min(baseMs * 2 ** attempt, 2_000)
    if (duration === 0) return
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort)
            resolve()
        }, duration)
        const abort = () => {
            clearTimeout(timer)
            signal.removeEventListener("abort", abort)
            reject(abortReason(signal))
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
    })
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new BillingFeedAbortedError("billing feed aborted")
}

function safeAbortReason(reason: unknown): string {
    return typeof reason === "string" && reason.length > 0 && reason.length <= 256
        ? reason
        : "billing feed aborted"
}

function secretText(value: unknown, name: string, maximum: number): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        /[\u0000\r\n]/.test(value)
    ) {
        throw new TypeError(`${name} must be a non-empty header-safe secret`)
    }
    return value
}

function safeText(value: unknown, name: string, maximum: number): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        value !== value.trim() ||
        /[\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new BillingFeedProtocolError(`${name} must be safe non-empty text`)
    }
    return value
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

function plainRecord(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new BillingFeedProtocolError(`${path} must be an object`)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new BillingFeedProtocolError(`${path} must be a plain object`)
    }
    return value as Record<string, unknown>
}

function exactKeys(
    record: Record<string, unknown>,
    expected: readonly string[],
    path: string,
): void {
    const keys = Object.keys(record)
    const expectedSet = new Set(expected)
    if (
        keys.length !== expected.length ||
        keys.some((key) => !expectedSet.has(key)) ||
        expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
    ) {
        throw new BillingFeedProtocolError(`${path} has invalid fields`)
    }
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    return Object.freeze(value)
}
