import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024
const MAX_TOKEN_BYTES = 16 * 1024
const MAX_ISSUED_TTL_SECS = 24 * 60 * 60
const CLOCK_SKEW_SECS = 60

export const LOCAL_GATEWAY_SCOPES = Object.freeze([
    "model:invoke",
    "billing:receipts:read",
    "billing:attribution",
] as const)

export interface IssuedGatewayCredential {
    readonly schemaVersion: 1
    readonly runId: string
    readonly gatewayBaseUrl: string
    readonly apiKey: string
    readonly expiresAt: string
}

export interface AcquireGatewayCredentialOptions {
    readonly credentialsPath?: string
    readonly fetchImpl?: typeof fetch
    readonly nowMs?: number
    readonly timeoutMs?: number
}

export class GatewayCredentialError extends Error {
    override readonly name = "GatewayCredentialError"
}

/**
 * Exchange the long-lived CLI login for one short-lived, run-scoped Gateway
 * credential. The stored control origin is authoritative: CONTROL_URL and
 * arbitrary model endpoints are deliberately ignored so the cli_ bearer can
 * never be redirected by ambient environment.
 */
export async function acquireGatewayCredential(
    options: AcquireGatewayCredentialOptions = {},
): Promise<IssuedGatewayCredential> {
    const path = options.credentialsPath ?? join(homedir(), ".baro", "credentials.json")
    let raw: Buffer
    try {
        raw = readFileSync(path)
    } catch {
        throw new GatewayCredentialError(
            "not signed in; run `baro login` before using --llm jigjoy",
        )
    }
    if (raw.byteLength === 0 || raw.byteLength > MAX_CREDENTIAL_FILE_BYTES) {
        throw new GatewayCredentialError("stored Baro login is malformed")
    }

    let stored: unknown
    try {
        stored = JSON.parse(raw.toString("utf8"))
    } catch {
        throw new GatewayCredentialError("stored Baro login is malformed")
    }
    if (!isPlainObject(stored)) {
        throw new GatewayCredentialError("stored Baro login is malformed")
    }
    const token = stored.token
    const controlUrl = stored.controlUrl
    if (
        typeof token !== "string" ||
        !/^cli_[A-Za-z0-9._~-]{8,4091}$/.test(token) ||
        typeof controlUrl !== "string"
    ) {
        throw new GatewayCredentialError(
            "stored Baro login is incomplete; run `baro login` again",
        )
    }
    const controlBase = canonicalControlHttpOrigin(controlUrl)
    const endpoint = new URL("/cli/gateway/credentials", controlBase)
    const timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 100, 60_000)

    let response: Response
    try {
        response = await (options.fetchImpl ?? fetch)(endpoint, {
            method: "POST",
            redirect: "error",
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/json",
                "content-type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(timeoutMs),
        })
    } catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError"
            ? "timed out"
            : "failed"
        throw new GatewayCredentialError(`Gateway credential exchange ${reason}`)
    }
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new GatewayCredentialError(
                "Baro login is no longer valid; run `baro login` again",
            )
        }
        if (response.status === 404) {
            throw new GatewayCredentialError(
                "this Baro control plane does not support login-backed Gateway access yet",
            )
        }
        throw new GatewayCredentialError(
            `Gateway credential exchange failed with HTTP ${response.status}`,
        )
    }
    const cacheControl = response.headers.get("cache-control") ?? ""
    if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) {
        throw new GatewayCredentialError(
            "Gateway credential response was not marked no-store",
        )
    }
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new GatewayCredentialError("Gateway credential response was too large")
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new GatewayCredentialError("Gateway credential response was malformed")
    }
    return parseIssuedGatewayCredential(parsed, options.nowMs ?? Date.now())
}

export function parseIssuedGatewayCredential(
    value: unknown,
    nowMs = Date.now(),
): IssuedGatewayCredential {
    if (!isPlainObject(value) || !hasExactKeys(value, [
        "apiKey",
        "expiresAt",
        "gatewayBaseUrl",
        "runId",
        "schemaVersion",
    ])) {
        throw new GatewayCredentialError("Gateway credential response had an invalid schema")
    }
    if (value.schemaVersion !== 1) {
        throw new GatewayCredentialError("Gateway credential response used an unsupported version")
    }
    if (typeof value.runId !== "string" || !/^run-local-[A-Za-z0-9_-]{20,128}$/.test(value.runId)) {
        throw new GatewayCredentialError("Gateway credential response had an invalid runId")
    }
    if (typeof value.apiKey !== "string" || Buffer.byteLength(value.apiKey, "utf8") > MAX_TOKEN_BYTES) {
        throw new GatewayCredentialError("Gateway credential response had an invalid token")
    }
    const gatewayBaseUrl = canonicalGatewayBaseUrl(value.gatewayBaseUrl)
    if (typeof value.expiresAt !== "string") {
        throw new GatewayCredentialError("Gateway credential response had an invalid expiry")
    }
    const expiresAt = value.expiresAt
    const expiresAtMs = parseCanonicalTimestamp(expiresAt)
    const nowSecs = Math.floor(nowMs / 1000)
    const expiresAtSecs = Math.floor(expiresAtMs / 1000)
    if (expiresAtSecs <= nowSecs || expiresAtSecs - nowSecs > MAX_ISSUED_TTL_SECS + CLOCK_SKEW_SECS) {
        throw new GatewayCredentialError("Gateway credential response had an invalid expiry")
    }

    const parts = value.apiKey.split(".")
    if (parts.length !== 3 || parts[0] !== "gk_v1") {
        throw new GatewayCredentialError("Gateway credential response had an invalid token")
    }
    const claims = decodeClaims(parts[1])
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(parts[2])) {
        throw new GatewayCredentialError("Gateway credential response had an invalid token signature")
    }
    if (!hasExactKeys(claims, [
        "aud",
        "exp",
        "iat",
        "iss",
        "jti",
        "nbf",
        "rid",
        "scp",
        "sub",
        "v",
    ])) {
        throw new GatewayCredentialError("Gateway credential token had an invalid claim set")
    }
    if (
        claims.v !== 1 ||
        claims.iss !== "baro-control" ||
        claims.aud !== new URL(gatewayBaseUrl).origin ||
        claims.rid !== value.runId ||
        !safeBoundedText(claims.sub, 256) ||
        !safeBoundedText(claims.jti, 256) ||
        !integerEpoch(claims.iat) ||
        !integerEpoch(claims.nbf) ||
        !integerEpoch(claims.exp) ||
        claims.exp !== expiresAtSecs ||
        claims.iat > nowSecs + CLOCK_SKEW_SECS ||
        claims.nbf > nowSecs + CLOCK_SKEW_SECS ||
        claims.exp <= nowSecs ||
        claims.exp - claims.iat > MAX_ISSUED_TTL_SECS ||
        !exactScopes(claims.scp)
    ) {
        throw new GatewayCredentialError("Gateway credential token claims did not match the response")
    }

    return Object.freeze({
        schemaVersion: 1,
        runId: value.runId,
        gatewayBaseUrl,
        apiKey: value.apiKey,
        expiresAt,
    })
}

export function canonicalControlHttpOrigin(value: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new GatewayCredentialError("stored Baro control URL is invalid")
    }
    if (!["wss:", "ws:", "https:", "http:"].includes(url.protocol)) {
        throw new GatewayCredentialError("stored Baro control URL uses an unsupported protocol")
    }
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
        throw new GatewayCredentialError("stored Baro control URL is not an origin")
    }
    if ((url.protocol === "ws:" || url.protocol === "http:") && !isLoopback(url.hostname)) {
        throw new GatewayCredentialError("stored Baro control URL must use TLS")
    }
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:"
    return url.origin
}

function canonicalGatewayBaseUrl(value: unknown): string {
    if (typeof value !== "string" || value !== value.trim()) {
        throw new GatewayCredentialError("Gateway credential response had an invalid base URL")
    }
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new GatewayCredentialError("Gateway credential response had an invalid base URL")
    }
    if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        (url.protocol === "http:" && !isLoopback(url.hostname)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new GatewayCredentialError("Gateway credential response had an unsafe base URL")
    }
    const path = url.pathname.replace(/\/+$/, "")
    if (path !== "/v1") {
        throw new GatewayCredentialError("Gateway credential response had an unexpected API path")
    }
    url.pathname = "/v1"
    return url.toString().replace(/\/$/, "")
}

function decodeClaims(segment: string): Record<string, unknown> {
    if (!/^[A-Za-z0-9_-]{16,8192}$/.test(segment)) {
        throw new GatewayCredentialError("Gateway credential token payload was invalid")
    }
    let decoded: Buffer
    try {
        decoded = Buffer.from(segment, "base64url")
    } catch {
        throw new GatewayCredentialError("Gateway credential token payload was invalid")
    }
    if (decoded.toString("base64url") !== segment) {
        throw new GatewayCredentialError("Gateway credential token payload was not canonical")
    }
    let value: unknown
    try {
        value = JSON.parse(decoded.toString("utf8"))
    } catch {
        throw new GatewayCredentialError("Gateway credential token payload was invalid")
    }
    if (!isPlainObject(value)) {
        throw new GatewayCredentialError("Gateway credential token payload was invalid")
    }
    return value
}

function parseCanonicalTimestamp(value: unknown): number {
    if (typeof value !== "string" || value.length > 64) {
        throw new GatewayCredentialError("Gateway credential response had an invalid expiry")
    }
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
        throw new GatewayCredentialError("Gateway credential response had an invalid expiry")
    }
    return timestamp
}

function exactScopes(value: unknown): boolean {
    return Array.isArray(value) &&
        value.length === LOCAL_GATEWAY_SCOPES.length &&
        value.every((scope, index) => scope === LOCAL_GATEWAY_SCOPES[index])
}

function integerEpoch(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

function safeBoundedText(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort()
    return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function isLoopback(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function boundedInteger(value: number, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new GatewayCredentialError(`timeoutMs must be an integer from ${min} to ${max}`)
    }
    return value
}
