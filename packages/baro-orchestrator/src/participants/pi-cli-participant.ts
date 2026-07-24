/**
 * Wraps a one-shot `pi --mode json -p` subprocess as a Mozaik Participant.
 * Event shapes: docs/stream-protocols.md § Pi.
 * The process/stream skeleton lives in CliParticipant.
 */

import { Participant, SemanticEvent } from "../runtime/mozaik.js"

import { AgentTargetedMessage, PiSystem } from "../semantic-events.js"
import { mapPiEvent } from "../pi-stream-mapper.js"
import { acceptsTargetedMessage } from "../runtime/targeted-message-authority.js"
import {
    CliParticipant,
    type CliRunSummaryCore,
} from "./cli-participant.js"

export interface PiCliParticipantOptions {
    cwd: string
    prompt: string
    /** Provider override (e.g. "anthropic"); Pi's default is "google". */
    provider?: string
    model?: string
    piBin?: string
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
    targetedMessageAuthority?: Participant
    targetedMessageCorrelation?: Readonly<{
        runId?: string
        leaseId?: string
        generation?: number
    }>
}

export interface PiRunSummary extends CliRunSummaryCore {
    sessionId: string | null
    /** Bounded tail used only to classify terminal operational failures. */
    stderrTail: string | null
    /** At least one `agent_end` seen; Pi exits 0 even on a refused turn. */
    sawAgentEnd: boolean
    /** `tool_execution_start` count — zero means a prose-only answer. */
    toolCallCount: number
    /** `tool_execution_end` without `isError` — proof the worktree changed. */
    toolSuccessCount: number
}

export class PiCliParticipant extends CliParticipant<PiRunSummary> {
    /** Send a signal to every active Pi child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        CliParticipant.killAllInstances(PiCliParticipant, signal)
    }

    private readonly options: PiCliParticipantOptions
    private sessionId: string | null = null
    private sawAgentEnd = false
    private toolCallCount = 0
    private toolSuccessCount = 0

    constructor(agentId: string, opts: PiCliParticipantOptions) {
        super(agentId, {
            name: "pi",
            // Nullish-coalesce so an explicit `undefined` can't clobber a default.
            binary: opts.piBin ?? "pi",
            cwd: opts.cwd,
            stdinMode: "ignore",
            closeDrainTimeoutMs: opts.closeDrainTimeoutMs ?? 7_500,
            captureStderrTail: true,
        })
        this.options = opts
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    protected override readyFailureMessage(code: number | null): string {
        return `pi exited (code ${code}) before signalling ready`
    }

    protected override buildArgs(): string[] {
        const args = ["--mode", "json", "-p", "--no-session"]
        if (this.options.provider) args.push("--provider", this.options.provider)
        if (this.options.model) args.push("--model", this.options.model)
        args.push(this.options.prompt)
        return args
    }

    protected override summarize(): PiRunSummary {
        return {
            sessionId: this.sessionId,
            exitCode: this.exitCode,
            error: this.spawnError,
            stderrTail: this.stderrTail,
            sawAgentEnd: this.sawAgentEnd,
            toolCallCount: this.toolCallCount,
            toolSuccessCount: this.toolSuccessCount,
        }
    }

    protected override consumeLine(parsed: Record<string, unknown>): void {
        const { items, sessionId } = mapPiEvent(this.agentId, parsed)
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId
        }

        // Completion evidence for the success predicate — exit 0 alone is
        // not sufficient (see PiRunSummary field docs).
        if (parsed.type === "agent_end") this.sawAgentEnd = true
        if (parsed.type === "tool_execution_start") this.toolCallCount += 1
        if (parsed.type === "tool_execution_end" && parsed.isError !== true) {
            this.toolSuccessCount += 1
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                if (
                    PiSystem.is(item) &&
                    (item.data.subtype === "session" ||
                        item.data.subtype === "agent_start")
                ) {
                    this.transition("running", "pi agent started")
                    this.settleReady()
                }
                // Don't transition to "done" on agent_end — the process-close
                // listener owns that, so the real exit code is observed first.
            }
            this.dispatch(item)
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Pi `-p` is one-shot — no stdin channel; targeted messages are
        // logged and dropped.
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
                `[pi:${this.agentId}] received AgentTargetedMessage but Pi run is one-shot — dropped\n`,
            )
        }
    }
}
