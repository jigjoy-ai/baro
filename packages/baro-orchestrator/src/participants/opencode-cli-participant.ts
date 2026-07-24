/**
 * Wraps a one-shot `opencode run --format json` subprocess as a Mozaik
 * Participant. Event shapes: docs/stream-protocols.md § OpenCode.
 * The process/stream skeleton lives in CliParticipant.
 */

import { Participant, SemanticEvent } from "../runtime/mozaik.js"

import {
    AgentTargetedMessage,
    OpenCodeSystem,
} from "../semantic-events.js"
import { mapOpenCodeEvent } from "../opencode-stream-mapper.js"
import { acceptsTargetedMessage } from "../runtime/targeted-message-authority.js"
import {
    CliParticipant,
    type CliRunSummaryCore,
} from "./cli-participant.js"

export interface OpenCodeCliParticipantOptions {
    cwd: string
    prompt: string
    /** `provider/model` format (e.g. "anthropic/claude-sonnet-4-20250514"). */
    model?: string
    opencodeBin?: string
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
    /**
     * Pass `--dangerously-skip-permissions` — OpenCode's default mode prompts
     * for tool approvals, which blocks autonomous runs. Default: true.
     */
    skipPermissions?: boolean
    targetedMessageAuthority?: Participant
    targetedMessageCorrelation?: Readonly<{
        runId?: string
        leaseId?: string
        generation?: number
    }>
}

export interface OpenCodeRunSummary extends CliRunSummaryCore {
    sessionId: string | null
    /** Bounded tail used only to classify terminal operational failures. */
    stderrTail: string | null
    /**
     * At least one `step_finish` seen. `opencode run` exits 0 even on a
     * refused/no-op turn (verified empirically), so exitCode alone is not
     * proof of completion — require this too.
     */
    sawStepFinish: boolean
    /**
     * `tool_use`/`tool_call` count. Zero tools on a code-writing story means
     * the agent likely answered in prose instead of editing the worktree.
     */
    toolCallCount: number
}

export class OpenCodeCliParticipant extends CliParticipant<OpenCodeRunSummary> {
    /** Send a signal to every active OpenCode child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        CliParticipant.killAllInstances(OpenCodeCliParticipant, signal)
    }

    private readonly options: OpenCodeCliParticipantOptions & {
        skipPermissions: boolean
    }
    private sessionId: string | null = null
    private sawStepFinish = false
    private toolCallCount = 0

    constructor(agentId: string, opts: OpenCodeCliParticipantOptions) {
        super(agentId, {
            name: "opencode",
            // Nullish-coalesce so an explicit `undefined` can't clobber a default.
            binary: opts.opencodeBin ?? "opencode",
            cwd: opts.cwd,
            stdinMode: "ignore",
            closeDrainTimeoutMs: opts.closeDrainTimeoutMs ?? 7_500,
            captureStderrTail: true,
        })
        this.options = { ...opts, skipPermissions: opts.skipPermissions ?? true }
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    protected override readyFailureMessage(code: number | null): string {
        return "opencode exited before step_start"
    }

    protected override buildArgs(): string[] {
        const args = ["run", "--format", "json"]
        if (this.options.skipPermissions) {
            args.push("--dangerously-skip-permissions")
        }
        if (this.options.model) args.push("-m", this.options.model)
        if (this.options.cwd) args.push("--dir", this.options.cwd)
        args.push(this.options.prompt)
        return args
    }

    protected override summarize(): OpenCodeRunSummary {
        return {
            sessionId: this.sessionId,
            exitCode: this.exitCode,
            error: this.spawnError,
            stderrTail: this.stderrTail,
            sawStepFinish: this.sawStepFinish,
            toolCallCount: this.toolCallCount,
        }
    }

    protected override consumeLine(parsed: Record<string, unknown>): void {
        const { items, sessionId } = mapOpenCodeEvent(this.agentId, parsed)
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId
        }
        // Completion evidence for the success predicate — exit 0 alone is
        // not sufficient (see OpenCodeRunSummary field docs).
        if (parsed.type === "step_finish") this.sawStepFinish = true
        // Real opencode emits `tool_use`; `tool_call` is the legacy fallback.
        if (parsed.type === "tool_use" || parsed.type === "tool_call") {
            this.toolCallCount += 1
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                if (
                    OpenCodeSystem.is(item) &&
                    item.data.subtype === "step_start"
                ) {
                    this.transition("running", "opencode step started")
                    this.settleReady()
                }
                // Don't transition to "done" on step_finish — the process-close
                // listener owns that, so the real exit code is observed first.
            }
            this.dispatch(item)
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // OpenCode run is one-shot — no stdin channel; targeted messages are
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
                `[opencode:${this.agentId}] received AgentTargetedMessage but OpenCode run is one-shot — dropped\n`,
            )
        }
    }
}
