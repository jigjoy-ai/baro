/**
 * Wraps one `devin acp` turn as a Mozaik Participant. Unlike the print-mode
 * CLIs, stdin stays open: the ACP handshake, the prompt and permission
 * answers all travel over it, and closing it after the turn ends the process.
 * The process/stream skeleton lives in CliParticipant.
 */

import { AgenticEnvironment, Participant, SemanticEvent } from "../../runtime/mozaik.js"

import {
    AgentTargetedMessage,
    DevinSystem,
    DevinTurnEvent,
} from "../../semantic-events.js"
import { acceptsTargetedMessage } from "../../runtime/targeted-message-authority.js"
import { CliParticipant, type CliRunSummaryCore } from "../cli-participant.js"
import {
    DevinAcpTurn,
    type DevinAcpTurnEvent,
    type DevinPermissionPolicy,
    type DevinTurnTokens,
} from "./acp-turn.js"
import { DevinStreamMapper, type MappedDevinItem } from "./stream-mapper.js"

export type DevinDeliveredItem = MappedDevinItem

export interface DevinCliParticipantOptions {
    /** Absolute worktree path. */
    cwd: string
    prompt: string
    /** Devin model name (fuzzy, e.g. "opus", "swe-2-medium"); omit for the account default. */
    model?: string
    devinBin?: string
    /** `devin acp --agent-type`; "summarizer" is Devin's agent with no tools. */
    agentType?: string
    /** Devin session mode. Default "bypass": a story worker acts without asking. */
    mode?: string
    /** Answer to a permission request the mode did not settle. Default "allow". */
    permissions?: DevinPermissionPolicy
    /** Sees every item this participant delivers, with or without a bus. */
    onItem?: (item: DevinDeliveredItem) => void
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
    targetedMessageAuthority?: Participant
    targetedMessageCorrelation?: Readonly<{
        runId?: string
        leaseId?: string
        generation?: number
    }>
}

export interface DevinRunSummary extends CliRunSummaryCore {
    sessionId: string | null
    stderrTail: string | null
    /** ACP stopReason of the prompt; null when the turn never finished. */
    stopReason: string | null
    /** Protocol-level failure (e.g. expired login) reported by Devin. */
    acpFailure: string | null
    toolCallCount: number
    toolSuccessCount: number
    tokens: DevinTurnTokens | null
}

export class DevinCliParticipant extends CliParticipant<DevinRunSummary> {
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        CliParticipant.killAllInstances(DevinCliParticipant, signal)
    }

    private readonly options: DevinCliParticipantOptions
    private readonly mapper: DevinStreamMapper
    private turn: DevinAcpTurn | null = null
    private stopReason: string | null = null
    private acpFailure: string | null = null
    private tokens: DevinTurnTokens | null = null

    constructor(agentId: string, opts: DevinCliParticipantOptions) {
        super(agentId, {
            name: "devin",
            binary: opts.devinBin ?? "devin",
            cwd: opts.cwd,
            stdinMode: "pipe",
            closeDrainTimeoutMs: opts.closeDrainTimeoutMs ?? 7_500,
            captureStderrTail: true,
            // Devin logs every startup step at INFO; errors are what classify a failure.
            env: { RUST_LOG: process.env.RUST_LOG ?? "error" },
        })
        this.options = opts
        this.mapper = new DevinStreamMapper(agentId)
    }

    getSessionId(): string | null {
        return this.turn?.getSessionId() ?? null
    }

    override start(environment: AgenticEnvironment): void {
        if (this.turn) return
        super.start(environment)
        const stdin = this.processStdin
        if (!stdin) return
        stdin.on("error", () => { /* the exit status decides */ })
        this.turn = new DevinAcpTurn(
            {
                cwd: this.options.cwd,
                prompt: this.options.prompt,
                mode: this.options.mode ?? "bypass",
                permissions: this.options.permissions ?? "allow",
            },
            (line) => { stdin.write(`${line}\n`) },
        )
        this.turn.start()
    }

    protected override readyFailureMessage(code: number | null): string {
        return `devin exited (code ${code}) before opening a session`
    }

    protected override buildArgs(): string[] {
        return [
            "acp",
            ...(this.options.agentType ? ["--agent-type", this.options.agentType] : []),
            ...(this.options.model ? ["--model", this.options.model] : []),
        ]
    }

    protected override summarize(): DevinRunSummary {
        return {
            sessionId: this.getSessionId(),
            exitCode: this.exitCode,
            exitSignal: this.exitSignal,
            error: this.spawnError,
            stderrTail: this.stderrTail,
            stopReason: this.stopReason,
            acpFailure: this.acpFailure,
            toolCallCount: this.mapper.toolCallCount,
            toolSuccessCount: this.mapper.toolSuccessCount,
            tokens: this.tokens,
        }
    }

    protected override consumeLine(parsed: Record<string, unknown>): void {
        if (!this.turn) return
        for (const event of this.turn.consume(parsed)) this.apply(event)
    }

    private apply(event: DevinAcpTurnEvent): void {
        switch (event.kind) {
            case "session":
                this.dispatch(this.system("session", { sessionId: event.sessionId }))
                this.transition("running", "devin session opened")
                this.settleReady()
                return
            case "update":
                for (const item of this.mapper.map(event.update)) this.dispatch(item)
                return
            case "turn_stats":
                this.tokens = event.tokens
                return
            case "stopped":
                this.dispatch(this.system("stopped", { cause: event.cause }))
                return
            case "permission":
                this.dispatch(this.system("permission", { title: event.title, granted: event.granted }))
                return
            case "finished":
                this.stopReason = event.stopReason
                for (const item of this.mapper.flush()) this.dispatch(item)
                this.dispatch(DevinTurnEvent.create({
                    agentId: this.agentId,
                    turnType: "turn_end",
                    raw: { stopReason: event.stopReason, usage: turnUsage(this.tokens, event.usage), model: this.tokens?.model ?? null },
                }))
                this.dispatch(this.system("finished", { stopReason: event.stopReason }))
                this.processStdin?.end()
                return
            case "failed":
                this.acpFailure = event.message
                this.dispatch(this.system("failed", { message: event.message }))
                this.processStdin?.end()
                return
        }
    }

    protected override dispatch(item: DevinDeliveredItem): void {
        this.options.onItem?.(item)
        super.dispatch(item)
    }

    private system(subtype: string, raw: Record<string, unknown>): SemanticEvent<unknown> {
        return DevinSystem.create({ agentId: this.agentId, subtype, raw })
    }

    override abort(signal: NodeJS.Signals = "SIGTERM"): void {
        this.turn?.cancel()
        super.abort(signal)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (
            AgentTargetedMessage.is(event) &&
            acceptsTargetedMessage(
                source,
                event.data,
                this.agentId,
                this.options.targetedMessageAuthority,
                this.options.targetedMessageCorrelation ?? {},
            )
        ) {
            process.stderr.write(
                `[devin:${this.agentId}] received AgentTargetedMessage but the Devin turn is one-shot — dropped\n`,
            )
        }
    }
}

/** Turn totals when Devin sent them, else the last model call from the prompt result. */
export function turnUsage(
    tokens: DevinTurnTokens | null,
    promptUsage: Record<string, unknown>,
): Record<string, number> {
    const usage: Record<string, number> = {}
    if (tokens && tokens.inputTokens !== null) {
        usage.input_tokens = tokens.inputTokens
        if (tokens.cachedInputTokens !== null) usage.cached_input_tokens = tokens.cachedInputTokens
        if (tokens.outputTokens !== null) usage.output_tokens = tokens.outputTokens
        return usage
    }
    const n = (key: string): number | null => {
        const value = promptUsage[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
    }
    const input = n("inputTokens")
    const cached = n("cachedReadTokens") ?? 0
    if (input !== null) {
        usage.input_tokens = Math.max(0, input - cached)
        usage.cached_input_tokens = cached
    }
    const output = n("outputTokens")
    if (output !== null) usage.output_tokens = output
    return usage
}
