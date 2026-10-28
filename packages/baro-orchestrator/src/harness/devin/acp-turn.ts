/**
 * One prompt turn against `devin acp` (Agent Client Protocol, JSON-RPC over
 * stdio): initialize → session/new → session/set_mode → session/prompt.
 * Pure over a line writer so the participant and the one-shot share it and
 * tests can drive it without a process. Wire notes: docs/stream-protocols.md § Devin.
 */

export type DevinPermissionPolicy = "allow" | "reject"

export interface DevinAcpTurnOptions {
    /** Absolute; ACP requires it. */
    cwd: string
    prompt: string
    /** Devin session mode id: "bypass" for stories, "ask" for evaluators. */
    mode: string
    /** Answer to a permission request the mode did not settle. */
    permissions: DevinPermissionPolicy
}

/** Turn totals from Devin's `_cognition.ai/turn_stats`; input excludes cached reads. */
export interface DevinTurnTokens {
    inputTokens: number | null
    cachedInputTokens: number | null
    outputTokens: number | null
    model: string | null
}

export type DevinAcpTurnEvent =
    | { kind: "session"; sessionId: string }
    | { kind: "update"; update: Record<string, unknown> }
    | { kind: "turn_stats"; tokens: DevinTurnTokens }
    | { kind: "stopped"; cause: string }
    | { kind: "permission"; title: string; granted: boolean }
    | {
          kind: "finished"
          stopReason: string
          usage: Record<string, unknown>
      }
    | { kind: "failed"; message: string }

type Step = "initialize" | "session/new" | "session/set_mode" | "session/prompt"

export class DevinAcpTurn {
    private nextId = 0
    private readonly pending = new Map<number, Step>()
    private sessionId: string | null = null
    private settled = false

    constructor(
        private readonly opts: DevinAcpTurnOptions,
        private readonly write: (line: string) => void,
    ) {}

    getSessionId(): string | null {
        return this.sessionId
    }

    start(): void {
        this.request("initialize", {
            protocolVersion: 1,
            // Devin keeps file and terminal work in its own tools; we host neither.
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
            },
        })
    }

    /** Ask Devin to stop; it answers the open prompt with `cancelled`. */
    cancel(): void {
        if (this.settled || !this.sessionId) return
        this.write(
            JSON.stringify({
                jsonrpc: "2.0",
                method: "session/cancel",
                params: { sessionId: this.sessionId },
            }),
        )
    }

    consume(message: Record<string, unknown>): DevinAcpTurnEvent[] {
        if (typeof message.method === "string") return this.onAgentMessage(message)
        if (typeof message.id !== "number") return []
        const step = this.pending.get(message.id)
        if (!step) return []
        this.pending.delete(message.id)
        if (message.error !== undefined) {
            return this.fail(`${step} failed: ${errorMessage(message.error)}`)
        }
        const result = record(message.result)
        switch (step) {
            case "initialize":
                this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] })
                return []
            case "session/new": {
                const sessionId = typeof result.sessionId === "string" ? result.sessionId : ""
                if (!sessionId) return this.fail("session/new returned no sessionId")
                this.sessionId = sessionId
                this.request("session/set_mode", { sessionId, modeId: this.opts.mode })
                return [{ kind: "session", sessionId }]
            }
            case "session/set_mode":
                this.request("session/prompt", {
                    sessionId: this.sessionId,
                    prompt: [{ type: "text", text: this.opts.prompt }],
                })
                return []
            case "session/prompt":
                this.settled = true
                return [{
                    kind: "finished",
                    stopReason: typeof result.stopReason === "string" ? result.stopReason : "unknown",
                    usage: record(result.usage),
                }]
        }
    }

    private onAgentMessage(message: Record<string, unknown>): DevinAcpTurnEvent[] {
        const params = record(message.params)
        switch (message.method) {
            case "session/update":
                return [{ kind: "update", update: record(params.update) }]
            case "session/request_permission":
                return [this.answerPermission(message.id, params)]
            case "_cognition.ai/turn_stats":
                return [{ kind: "turn_stats", tokens: turnTokens(params.responseDimensions) }]
            case "_cognition.ai/agent_stopped":
                return [{ kind: "stopped", cause: String(params.cause ?? "unknown") }]
            default:
                // Any other agent→client request must be answered or Devin waits on it.
                if (message.id !== undefined) {
                    this.write(JSON.stringify({
                        jsonrpc: "2.0",
                        id: message.id,
                        error: { code: -32601, message: `baro does not handle ${String(message.method)}` },
                    }))
                }
                return []
        }
    }

    private answerPermission(
        id: unknown,
        params: Record<string, unknown>,
    ): DevinAcpTurnEvent {
        const options = Array.isArray(params.options)
            ? params.options.map(record)
            : []
        const wanted = this.opts.permissions === "allow"
            ? ["allow_once", "allow_always"]
            : ["reject_once", "reject_always"]
        const option = options.find((o) => wanted.includes(String(o.kind)))
        const outcome = option
            ? { outcome: "selected", optionId: option.optionId }
            : { outcome: "cancelled" }
        this.write(JSON.stringify({ jsonrpc: "2.0", id, result: { outcome } }))
        const toolCall = record(params.toolCall)
        return {
            kind: "permission",
            title: String(toolCall.title ?? toolCall.toolCallId ?? "tool"),
            granted: this.opts.permissions === "allow" && option !== undefined,
        }
    }

    private request(method: Step, params: Record<string, unknown>): void {
        const id = ++this.nextId
        this.pending.set(id, method)
        this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    }

    private fail(message: string): DevinAcpTurnEvent[] {
        this.settled = true
        return [{ kind: "failed", message }]
    }
}

function turnTokens(dimensions: unknown): DevinTurnTokens {
    const byUid = new Map<string, unknown>()
    for (const raw of Array.isArray(dimensions) ? dimensions : []) {
        const dimension = record(raw)
        if (typeof dimension.uid === "string") {
            byUid.set(dimension.uid, record(dimension.kind).value)
        }
    }
    const count = (uid: string): number | null => {
        const value = byUid.get(uid)
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
    }
    const model = byUid.get("model")
    return {
        inputTokens: count("input_tokens"),
        cachedInputTokens: count("cached_input_tokens"),
        outputTokens: count("output_tokens"),
        model: typeof model === "string" && model.trim() ? model : null,
    }
}

function errorMessage(error: unknown): string {
    const e = record(error)
    return typeof e.message === "string" && e.message ? e.message : JSON.stringify(error)
}

export function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}
