import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    GatewayCredentialError,
    LOCAL_GATEWAY_SCOPES,
    acquireGatewayCredential,
    canonicalControlHttpOrigin,
    parseIssuedGatewayCredential,
} from "../src/gateway-credentials.js"

const NOW_MS = Date.UTC(2026, 6, 14, 12, 0, 0)

function issued(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const { claims: claimOverrides, ...responseOverrides } = overrides
    const exp = Math.floor(NOW_MS / 1000) + 12 * 60 * 60
    const claims = {
        v: 1,
        iss: "baro-control",
        aud: "https://gw.baro.jigjoy.ai",
        sub: "tenant-1",
        rid: "run-local-abcdefghijklmnopqrstuvwxyz",
        scp: [...LOCAL_GATEWAY_SCOPES],
        iat: Math.floor(NOW_MS / 1000),
        nbf: Math.floor(NOW_MS / 1000),
        exp,
        jti: "credential-abcdefghijklmnopqrstuvwxyz",
        ...((claimOverrides as Record<string, unknown> | undefined) ?? {}),
    }
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")
    return {
        schemaVersion: 1,
        runId: "run-local-abcdefghijklmnopqrstuvwxyz",
        gatewayBaseUrl: "https://gw.baro.jigjoy.ai/v1",
        apiKey: `gk_v1.${payload}.${"a".repeat(43)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
        ...responseOverrides,
    }
}

describe("login-backed Gateway credential", () => {
    it("strictly accepts a response whose public fields match its scoped claims", () => {
        const parsed = parseIssuedGatewayCredential(issued(), NOW_MS)
        assert.equal(parsed.runId, "run-local-abcdefghijklmnopqrstuvwxyz")
        assert.equal(parsed.gatewayBaseUrl, "https://gw.baro.jigjoy.ai/v1")
        assert.equal(Object.isFrozen(parsed), true)
    })

    it("rejects authority-bearing extras, claim drift, unsafe URLs, and stale credentials", () => {
        assert.throws(
            () => parseIssuedGatewayCredential({ ...issued(), tenant: "attacker" }, NOW_MS),
            /invalid schema/,
        )
        assert.throws(
            () => parseIssuedGatewayCredential(issued({ claims: { rid: "run-local-wrongwrongwrongwrongwrong" } }), NOW_MS),
            /did not match/,
        )
        assert.throws(
            () => parseIssuedGatewayCredential(issued({ claims: { scp: ["model:invoke"] } }), NOW_MS),
            /did not match/,
        )
        assert.throws(
            () => parseIssuedGatewayCredential(issued({ gatewayBaseUrl: "https://evil.example/v1" }), NOW_MS),
            /did not match/,
        )
        assert.throws(
            () => parseIssuedGatewayCredential(issued({ gatewayBaseUrl: "http://gw.baro.jigjoy.ai/v1" }), NOW_MS),
            /unsafe base URL/,
        )
        const past = Math.floor(NOW_MS / 1000) - 1
        assert.throws(
            () => parseIssuedGatewayCredential(issued({
                claims: { exp: past },
                expiresAt: new Date(past * 1000).toISOString(),
            }), NOW_MS),
            /invalid expiry/,
        )
    })

    it("binds exchange to credentials.json controlUrl and ignores ambient CONTROL_URL", async () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-gateway-credential-"))
        const credentialsPath = join(dir, "credentials.json")
        writeFileSync(credentialsPath, JSON.stringify({
            token: "cli_abcdefghijklmnopqrstuvwxyz",
            controlUrl: "ws://127.0.0.1:4545",
        }))
        const oldControl = process.env.CONTROL_URL
        process.env.CONTROL_URL = "https://attacker.example"
        let request: { url: string; authorization: string | null; body: string | null } | undefined
        try {
            const result = await acquireGatewayCredential({
                credentialsPath,
                nowMs: NOW_MS,
                fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
                    const headers = new Headers(init?.headers)
                    request = {
                        url: String(input),
                        authorization: headers.get("authorization"),
                        body: typeof init?.body === "string" ? init.body : null,
                    }
                    return new Response(JSON.stringify(issued()), {
                        status: 200,
                        headers: {
                            "content-type": "application/json",
                            "cache-control": "private, no-store",
                        },
                    })
                }) as typeof fetch,
            })
            assert.equal(result.runId, "run-local-abcdefghijklmnopqrstuvwxyz")
            assert.deepEqual(request, {
                url: "http://127.0.0.1:4545/cli/gateway/credentials",
                authorization: "Bearer cli_abcdefghijklmnopqrstuvwxyz",
                body: "{}",
            })
        } finally {
            if (oldControl === undefined) delete process.env.CONTROL_URL
            else process.env.CONTROL_URL = oldControl
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("requires TLS off loopback and a no-store successful response", async () => {
        assert.throws(
            () => canonicalControlHttpOrigin("ws://api.baro.jigjoy.ai"),
            /must use TLS/,
        )
        assert.equal(
            canonicalControlHttpOrigin("wss://api.baro.jigjoy.ai/"),
            "https://api.baro.jigjoy.ai",
        )

        const dir = mkdtempSync(join(tmpdir(), "baro-gateway-credential-"))
        const credentialsPath = join(dir, "credentials.json")
        writeFileSync(credentialsPath, JSON.stringify({
            token: "cli_abcdefghijklmnopqrstuvwxyz",
            controlUrl: "https://api.baro.jigjoy.ai",
        }))
        try {
            await assert.rejects(
                acquireGatewayCredential({
                    credentialsPath,
                    nowMs: NOW_MS,
                    fetchImpl: (async () => new Response(JSON.stringify(issued()), {
                        status: 200,
                    })) as typeof fetch,
                }),
                /not marked no-store/,
            )
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("never includes a stored bearer or issued token in exchange errors", async () => {
        const secret = "cli_super-secret-credential-value"
        const dir = mkdtempSync(join(tmpdir(), "baro-gateway-credential-"))
        const credentialsPath = join(dir, "credentials.json")
        writeFileSync(credentialsPath, JSON.stringify({
            token: secret,
            controlUrl: "https://api.baro.jigjoy.ai",
        }))
        try {
            const error = await acquireGatewayCredential({
                credentialsPath,
                fetchImpl: (async () => new Response("do-not-echo-gk_v1.secret", {
                    status: 500,
                })) as typeof fetch,
            }).then(
                () => undefined,
                (reason: unknown) => reason,
            )
            assert.ok(error instanceof GatewayCredentialError)
            assert.doesNotMatch(error.message, /super-secret|do-not-echo|gk_v1/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
