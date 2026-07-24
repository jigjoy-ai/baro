/**
 * Wraps a long-lived Claude Code CLI process (stream-json in/out) as a
 * Mozaik Participant. Event shapes: docs/stream-protocols.md § Claude Code.
 * The process/stream skeleton lives in CliParticipant; this backend adds
 * the live stdin session (continuation turns + targeted-message injection).
 */

import { Participant, SemanticEvent } from "../runtime/mozaik.js"

import {
    AgentResult,
    AgentTargetedMessage,
    ClaudeSystem,
    type AgentResultData,
} from "../semantic-events.js"
import { mapClaudeEvent } from "../stream-json-mapper.js"
import { acceptsTargetedMessage } from "../runtime/targeted-message-authority.js"
import {
    CliParticipant,
    type CliRunSummaryCore,
} from "./cli-participant.js"

export interface ClaudeCliParticipantOptions {
    cwd: string
    model?: string
    /**
     * Pass `--include-partial-messages` (a `stream_event` chunk per token
     * delta — adds ~80% bus volume). Default: false.
     */
    includePartialMessages?: boolean
    /**
     * Pass `--replay-user-messages` so Claude echoes stdin user events back
     * on stdout. Default: true.
     */
    replayUserMessages?: boolean
    permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan"
    extraArgs?: string[]
    claudeBin?: string
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
    effort?: string
    /** `--resume <sessionId>` — needed by agents that span multiple infer() calls. */
    resumeSessionId?: string
    /** Compatibility targeted messages from this exact participant are
     * ignored because the owning StoryAgent consumes correlated Critique
     * events directly. */
    ignoredTargetedMessageAuthority?: Participant
    /** Exact Bridge and lease capability required in collective execution. */
    targetedMessageAuthority?: Participant
    targetedMessageCorrelation?: Readonly<{
        runId?: string
        leaseId?: string
        generation?: number
    }>
    /** Reviewed workers consume Critique directly; ignore its correlated
     * targeted compatibility twin. */
    ignoreCorrelatedTerminalFeedback?: boolean
}

export interface ClaudeRunSummary extends CliRunSummaryCore {
    sessionId: string | null
    /**
     * Last `result` event observed. Stored as the payload shape, not the
     * live SemanticEvent, so callers don't have to peel `.data`.
     */
    lastResult: AgentResultData | null
}

export class ClaudeCliParticipant extends CliParticipant<ClaudeRunSummary> {
    /** Send a signal to every active Claude child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        CliParticipant.killAllInstances(ClaudeCliParticipant, signal)
    }

    private readonly options: ClaudeCliParticipantOptions & {
        includePartialMessages: boolean
        replayUserMessages: boolean
        permissionMode: NonNullable<ClaudeCliParticipantOptions["permissionMode"]>
    }
    private sessionId: string | null = null
    private lastResult: AgentResultData | null = null

    constructor(agentId: string, opts: ClaudeCliParticipantOptions) {
        super(agentId, {
            name: "claude",
            // Nullish-coalesce so an explicit `undefined` from the caller
            // can't clobber a default (esp. claudeBin → spawn crash).
            binary: opts.claudeBin ?? "claude",
            cwd: opts.cwd,
            stdinMode: "pipe",
            closeDrainTimeoutMs: opts.closeDrainTimeoutMs ?? 7_500,
            captureStderrTail: false,
        })
        this.options = {
            ...opts,
            includePartialMessages: opts.includePartialMessages ?? false,
            replayUserMessages: opts.replayUserMessages ?? true,
            permissionMode: opts.permissionMode ?? "bypassPermissions",
        }
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    sendUserMessage(text: string): void {
        const stdin = this.processStdin
        if (!stdin) {
            throw new Error(`[${this.agentId}] proc not started`)
        }
        const event = {
            type: "user",
            message: { role: "user", content: text },
        }
        stdin.write(JSON.stringify(event) + "\n")
    }

    /** Close stdin so Claude knows no more input is coming. */
    closeStdin(): void {
        this.processStdin?.end()
    }

    protected override readyFailureMessage(): string {
        return "claude exited before system:init"
    }

    protected override buildArgs(): string[] {
        const args = [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            this.options.permissionMode,
        ]
        if (this.options.includePartialMessages) {
            args.push("--include-partial-messages")
        }
        if (this.options.replayUserMessages) {
            args.push("--replay-user-messages")
        }
        if (this.options.model) {
            args.push("--model", this.options.model)
        }
        if (this.options.effort) {
            args.push("--effort", this.options.effort)
        }
        if (this.options.resumeSessionId) {
            args.push("--resume", this.options.resumeSessionId)
        }
        if (this.options.extraArgs && this.options.extraArgs.length > 0) {
            args.push(...this.options.extraArgs)
        }
        return args
    }

    protected override summarize(): ClaudeRunSummary {
        return {
            sessionId: this.sessionId,
            exitCode: this.exitCode,
            error: this.spawnError,
            lastResult: this.lastResult,
        }
    }

    protected override consumeLine(parsed: Record<string, unknown>): void {
        const { items, sessionId } = mapClaudeEvent(this.agentId, parsed)
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                if (ClaudeSystem.is(item) && item.data.subtype === "init") {
                    this.transition("running", "claude init received")
                    this.settleReady()
                }
                if (AgentResult.is(item)) {
                    this.lastResult = item.data
                    this.transition(
                        item.data.isError ? "failed" : "done",
                        `result:${item.data.subtype}`,
                    )
                }
            }
            this.dispatch(item)
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // This participant owns bus → stdin forwarding for its agentId;
        // StoryAgent observes these events for lifecycle only and must NOT
        // also write to stdin (double-delivery).
        if (
            AgentTargetedMessage.is(event) &&
            acceptsTargetedMessage(
                source,
                event.data,
                this.agentId,
                this.options.targetedMessageAuthority,
                this.options.targetedMessageCorrelation ?? {},
            ) &&
            source !== this.options.ignoredTargetedMessageAuthority &&
            !(
                this.options.ignoreCorrelatedTerminalFeedback === true &&
                source === this.options.targetedMessageAuthority &&
                typeof event.data.metadata.terminalId === "string"
            )
        ) {
            if (!this.processStdin) return
            this.sendUserMessage(event.data.text)
        }
    }
}
