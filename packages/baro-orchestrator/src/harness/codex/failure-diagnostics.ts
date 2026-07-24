import { createHash } from "node:crypto"
import { stripVTControlCharacters } from "node:util"

const MAX_MESSAGE_BYTES = 2 * 1024
const MAX_IDENTIFIER_BYTES = 128
const MAX_RETAINED_BYTES = 8 * 1024
const MAX_FAILURE_SIGNALS = 8
const MAX_MCP_LIFECYCLE_SIGNALS = 8
const MAX_PENDING_MCP_CALLS = 8

type DiagnosticWriter = (line: string) => void

interface McpDiagnostic {
    key: string
    fields: string
}

interface RedactionCandidate {
    name: string
    secret: string
    exactLineOnly: boolean
}

/**
 * Retains the small subset of Codex JSONL needed to explain a failed one-shot
 * turn. Provider envelopes are untrusted: raw MCP arguments/results and opaque
 * metadata never enter stderr or the thrown error.
 */
export class CodexFailureDiagnostics {
    private readonly pendingMcp = new Map<string, McpDiagnostic>()
    private readonly retained: string[] = []
    private failureSignals = 0
    private mcpLifecycleSignals = 0
    private pendingMcpOmitted = 0
    private failureOmissionReported = false
    private mcpOmissionReported = false
    private abnormalFinalized = false
    private terminalFailureReported = false
    private terminalFailure: string | null = null

    constructor(
        private readonly label: string,
        private readonly write: DiagnosticWriter,
        private readonly redactionEnvironment: Readonly<Record<string, string>> = {},
    ) {}

    observe(event: Readonly<Record<string, unknown>>): void {
        const type = stringField(event.type)

        if (type === "error" || type === "turn.failed") {
            this.emitFailure(
                failureDiagnostic(type, event, this.redactionEnvironment),
                type === "turn.failed",
            )
            return
        }

        if (
            type !== "item.started" &&
            type !== "item.updated" &&
            type !== "item.completed"
        ) {
            return
        }

        const item = record(event.item)
        const itemType = stringField(item.type)
        if (itemType === "error") {
            this.emitFailure(
                failureDiagnostic(
                    `${type}:error`,
                    item,
                    this.redactionEnvironment,
                ),
            )
            return
        }
        if (itemType !== "mcp_tool_call") return

        const diagnostic = mcpDiagnostic(
            type,
            item,
            this.redactionEnvironment,
        )
        if (type === "item.completed") {
            this.pendingMcp.delete(diagnostic.key)
        } else if (
            this.pendingMcp.has(diagnostic.key) ||
            this.pendingMcp.size < MAX_PENDING_MCP_CALLS
        ) {
            this.pendingMcp.set(diagnostic.key, diagnostic)
        } else {
            this.pendingMcpOmitted += 1
        }

        const message = diagnosticMessage(
            item.error,
            0,
            this.redactionEnvironment,
        )
        const line = [
            `codex_event=${type}`,
            "item=mcp_tool_call",
            diagnostic.fields,
            message ? `message=${quoted(message)}` : null,
        ]
            .filter((value): value is string => value !== null)
            .join(" ")

        if (message || normalizedStatus(item.status) === "failed") {
            // A failed MCP completion is a failure signal even if earlier
            // lifecycle chatter exhausted the informational MCP allowance.
            this.emitFailure(line)
        } else {
            this.emitMcpLifecycle(line)
        }
    }

    /** Flush genuinely in-flight MCP calls and return a bounded error suffix. */
    abnormalSummary(): string {
        if (!this.abnormalFinalized) {
            this.abnormalFinalized = true
            for (const diagnostic of this.pendingMcp.values()) {
                this.emitForced(
                    `codex_event=mcp_tool_call.unfinished ${diagnostic.fields}`,
                )
            }
            if (this.pendingMcpOmitted > 0) {
                this.emitForced(
                    `codex_event=mcp_tool_call.tracking_overflow events=${this.pendingMcpOmitted}`,
                )
            }
            this.pendingMcp.clear()
        }
        return boundedSummary(this.retained, this.terminalFailure)
    }

    private emitFailure(line: string, terminal = false): void {
        if (terminal && !this.terminalFailureReported) {
            this.terminalFailureReported = true
            this.terminalFailure = this.emitForced(line)
            return
        }
        if (this.failureSignals < MAX_FAILURE_SIGNALS) {
            this.failureSignals += 1
            this.emitForced(line)
            return
        }
        if (!this.failureOmissionReported) {
            this.failureOmissionReported = true
            this.emitForced("codex_event=failure_diagnostic omitted=additional")
        }
    }

    private emitMcpLifecycle(line: string): void {
        if (this.mcpLifecycleSignals < MAX_MCP_LIFECYCLE_SIGNALS) {
            this.mcpLifecycleSignals += 1
            this.emitForced(line)
            return
        }
        if (!this.mcpOmissionReported) {
            this.mcpOmissionReported = true
            this.emitForced("codex_event=mcp_tool_call omitted=additional")
        }
    }

    private emitForced(line: string): string {
        const safeLine = boundUtf8(
            sanitizeDiagnosticText(line, this.redactionEnvironment),
            MAX_MESSAGE_BYTES + 768,
        )
        this.write(
            `[${safeIdentifier(this.label, this.redactionEnvironment)}] diagnostic ${safeLine}\n`,
        )
        this.retained.push(safeLine)
        while (
            this.retained.length > 1 &&
            Buffer.byteLength(this.retained.join(" | "), "utf8") >
                MAX_RETAINED_BYTES
        ) {
            this.retained.shift()
        }
        if (
            this.retained.length === 1 &&
            Buffer.byteLength(this.retained[0]!, "utf8") > MAX_RETAINED_BYTES
        ) {
            this.retained[0] = boundUtf8(
                this.retained[0]!,
                MAX_RETAINED_BYTES,
            )
        }
        return safeLine
    }
}

function failureDiagnostic(
    lifecycle: string,
    event: Readonly<Record<string, unknown>>,
    redactionEnvironment: Readonly<Record<string, string>>,
): string {
    const message =
        diagnosticMessage(event.message, 0, redactionEnvironment) ??
        diagnosticMessage(event.error, 0, redactionEnvironment) ??
        diagnosticMessage(event, 0, redactionEnvironment)
    const code =
        diagnosticCode(event.error) ??
        firstString(event, ["code", "status", "status_code", "http_status"])
    return [
        `codex_event=${safeIdentifier(lifecycle, redactionEnvironment)}`,
        message ? `message=${quoted(message)}` : "message=(not-reported)",
        code ? `code=${quoted(code)}` : null,
    ]
        .filter((value): value is string => value !== null)
        .join(" ")
}

function mcpDiagnostic(
    lifecycle: string,
    item: Readonly<Record<string, unknown>>,
    redactionEnvironment: Readonly<Record<string, string>>,
): McpDiagnostic {
    const id = firstString(item, ["id", "call_id", "item_id"])
    const server = firstString(item, ["server", "server_name"])
    const tool = firstString(item, ["tool", "tool_name", "name"])
    const status = normalizedStatus(item.status)
    const keyHash = createHash("sha256")
    if (id) keyHash.update("id\0").update(id)
    else {
        keyHash
            .update("anonymous\0")
            .update(server ?? "?")
            .update("\0")
            .update(tool ?? "?")
    }
    const key = keyHash.digest("hex")
    const fields = [
        id
            ? `id=${quoted(safeIdentifier(id, redactionEnvironment))}`
            : null,
        server
            ? `server=${quoted(safeIdentifier(server, redactionEnvironment))}`
            : null,
        tool
            ? `tool=${quoted(safeIdentifier(tool, redactionEnvironment))}`
            : null,
        status
            ? `status=${quoted(safeIdentifier(status, redactionEnvironment))}`
            : null,
        `lifecycle=${quoted(safeIdentifier(lifecycle, redactionEnvironment))}`,
    ]
        .filter((value): value is string => value !== null)
        .join(" ")
    return { key, fields }
}

function diagnosticMessage(
    value: unknown,
    depth = 0,
    redactionEnvironment: Readonly<Record<string, string>> = {},
): string | null {
    if (typeof value === "string") {
        const sanitized = sanitizeDiagnosticText(value, redactionEnvironment)
        return sanitized ? boundUtf8(sanitized, MAX_MESSAGE_BYTES) : null
    }
    if (depth > 3) return null
    const candidate = record(value)
    for (const key of [
        "message",
        "detail",
        "reason",
        "error_description",
    ]) {
        const message = diagnosticMessage(
            candidate[key],
            depth + 1,
            redactionEnvironment,
        )
        if (message) return message
    }
    for (const key of ["error", "cause"]) {
        const message = diagnosticMessage(
            candidate[key],
            depth + 1,
            redactionEnvironment,
        )
        if (message) return message
    }
    return null
}

function diagnosticCode(value: unknown): string | null {
    const candidate = record(value)
    return firstString(candidate, [
        "code",
        "type",
        "status",
        "status_code",
        "http_status",
    ])
}

export function sanitizeDiagnosticText(
    value: string,
    redactionEnvironment: Readonly<Record<string, string>> = {},
): string {
    // The caller explicitly supplies this environment to the provider/MCP
    // process. Its public contract permits arbitrary variable names, so every
    // non-trivial value is secret regardless of whether the name looks
    // credential-like.
    const secrets = [
        ...redactionCandidates(Object.entries(redactionEnvironment), true),
        ...redactionCandidates(Object.entries(process.env), false),
    ].sort((left, right) => right.secret.length - left.secret.length)
    const withoutAnsi = stripVTControlCharacters(value)
    const withoutControls = withoutAnsi.replace(
        /[\u0000-\u001F\u007F-\u009F]+/gu,
        "",
    )
    const hasControlSplitSecret = secrets.some(
        ({ exactLineOnly, secret }) =>
            !exactLineOnly &&
            occurrenceCount(withoutControls, secret) >
            occurrenceCount(withoutAnsi, secret),
    )
    let sanitized = hasControlSplitSecret
        ? withoutControls
        : withoutAnsi.replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ")
    const exactLine = secrets.find(
        ({ exactLineOnly, secret }) =>
            exactLineOnly && sanitized.trim() === secret,
    )
    const replaced = new Set<string>()
    if (exactLine) {
        sanitized = `[REDACTED:${exactLine.name}]`
    } else {
        for (const { exactLineOnly, name, secret } of secrets) {
            if (exactLineOnly || replaced.has(secret)) continue
            replaced.add(secret)
            sanitized = sanitized.split(secret).join(`[REDACTED:${name}]`)
        }
    }
    sanitized = sanitized
        .replace(
            /\b((?:Proxy-)?Authorization\s*:\s*)(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{4,}/giu,
            "$1[REDACTED]",
        )
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, "$1[REDACTED]")
        .replace(/\b(Basic\s+)[A-Za-z0-9+/=]{8,}/giu, "$1[REDACTED]")
        .replace(
            /\b(?:sk|rk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9._~+/=-]{8,}\b/giu,
            "[REDACTED:TOKEN]",
        )
        .replace(
            /((?:api[_.-]?key|access[_.-]?key|authorization|credential|password|private[_.-]?key|secret|token)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)(?!\[REDACTED(?::[A-Za-z0-9_]+)?\])[^\s"',;}\]]{4,}/giu,
            "$1[REDACTED]",
        )
        .replace(/\s+/gu, " ")
        .trim()

    const home = process.env.HOME
    if (home && home.length > 1) sanitized = sanitized.split(home).join("~")
    return sanitized
}

function redactionCandidates(
    entries: readonly [string, string | undefined][],
    explicit: boolean,
): RedactionCandidate[] {
    const candidates: RedactionCandidate[] = []
    for (const [rawName, rawSecret] of entries) {
        if (
            !rawSecret ||
            (!explicit && !sensitiveEnvironmentName(rawName))
        ) {
            continue
        }
        const name =
            rawName.replace(/[^A-Za-z0-9_]+/gu, "_").slice(0, 128) ||
            "SECRET"
        const wholeSecret = normalizeDiagnosticControls(rawSecret)
        if (wholeSecret.length < 4) continue
        candidates.push({ name, secret: wholeSecret, exactLineOnly: false })

        // Ordinary stderr is sanitized one complete physical line at a time.
        // Short pieces of an otherwise non-trivial multiline secret are too
        // common for substring replacement, but must still be hidden when the
        // physical line is exactly that piece.
        if (/[\r\n]/u.test(rawSecret)) {
            for (const variant of rawSecret.split(/[\r\n]+/u)) {
                const secret = normalizeDiagnosticControls(variant)
                if (!secret) continue
                candidates.push({
                    name,
                    secret,
                    exactLineOnly: secret.length < 4,
                })
            }
        }
    }
    return candidates
}

function normalizeDiagnosticControls(value: string): string {
    return stripVTControlCharacters(value).replace(
        /[\u0000-\u001F\u007F-\u009F]+/gu,
        "",
    )
}

function occurrenceCount(value: string, needle: string): number {
    return value.split(needle).length - 1
}

function sensitiveEnvironmentName(name: string): boolean {
    return (
        /^(?:ANTHROPIC|JIGJOY|OPENAI)_API_KEY$/iu.test(name) ||
        /^BARO_OPENAI_KEY_/iu.test(name) ||
        /(?:^|_)(?:ACCESS_?KEY|API_?KEY|AUTH_?TOKEN|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET(?:_?KEY)?|SESSION_?TOKEN|TOKEN)$/iu.test(
            name,
        )
    )
}

function normalizedStatus(value: unknown): string | null {
    if (typeof value !== "string") return null
    const normalized = value.trim().toLowerCase()
    return normalized || null
}

function firstString(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): string | null {
    for (const key of keys) {
        const candidate = stringField(value[key])
        if (candidate) return candidate
    }
    return null
}

function stringField(value: unknown): string {
    return typeof value === "string" ? value.trim() : ""
}

function safeIdentifier(
    value: string,
    redactionEnvironment: Readonly<Record<string, string>> = {},
): string {
    return (
        boundUtf8(
            sanitizeDiagnosticText(value, redactionEnvironment),
            MAX_IDENTIFIER_BYTES,
        ) || "?"
    )
}

function quoted(value: string): string {
    return JSON.stringify(value)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : {}
}

function boundUtf8(value: string, maxBytes: number): string {
    const bytes = Buffer.from(value, "utf8")
    if (bytes.length <= maxBytes) return value
    const marker = "…[truncated]"
    const markerBytes = Buffer.byteLength(marker, "utf8")
    const prefix = bytes
        .subarray(0, Math.max(0, maxBytes - markerBytes))
        .toString("utf8")
        .replace(/\uFFFD$/u, "")
    return `${prefix}${marker}`
}

function boundedSummary(
    retained: readonly string[],
    terminalFailure: string | null,
): string {
    const lines = terminalFailure
        ? retained.filter((line) => line !== terminalFailure)
        : [...retained]
    if (terminalFailure) lines.push(terminalFailure)

    while (
        lines.length > 1 &&
        Buffer.byteLength(lines.join(" | "), "utf8") > MAX_RETAINED_BYTES
    ) {
        lines.shift()
    }
    if (lines.length === 0) return ""
    if (Buffer.byteLength(lines[0]!, "utf8") > MAX_RETAINED_BYTES) {
        lines[0] = boundUtf8(lines[0]!, MAX_RETAINED_BYTES)
    }
    return lines.join(" | ")
}
