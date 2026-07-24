/**
 * Wraps a one-shot `codex exec --json` subprocess as a Mozaik Participant.
 * Event shapes: docs/stream-protocols.md § Codex.
 * The process/stream skeleton lives in CliParticipant.
 */

import { Participant, SemanticEvent } from "../runtime/mozaik.js"

import {
    AgentTargetedMessage,
    CodexSystem,
    CodexTurnEvent,
} from "../semantic-events.js"
import { mapCodexEvent } from "../codex-stream-mapper.js"
import { acceptsTargetedMessage } from "../runtime/targeted-message-authority.js"
import {
    CliParticipant,
    type CliRunSummaryCore,
} from "./cli-participant.js"

export interface CodexCliParticipantOptions {
    cwd: string
    prompt: string
    /** Omit to let Codex pick (gpt-5.5 on Plus+, a Mini variant on Free). */
    model?: string
    /**
     * Pass `--dangerously-bypass-approvals-and-sandbox` (`--yolo`).
     * workspace-write sandboxing blocks `.git/` writes so the agent can't
     * commit; per-story worktrees (#50) bound the blast radius.
     * Default: false — leave off for read-only probes.
     */
    bypassSandbox?: boolean
    /**
     * Pass `--skip-git-repo-check` — Codex refuses to run when cwd is not a
     * git repo. Only needed for tests or one-off runs from /tmp.
     */
    skipGitRepoCheck?: boolean
    extraArgs?: string[]
    codexBin?: string
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
    targetedMessageAuthority?: Participant
    targetedMessageCorrelation?: Readonly<{
        runId?: string
        leaseId?: string
        generation?: number
    }>
}

export interface CodexRunSummary extends CliRunSummaryCore {
    threadId: string | null
    /** Bounded tail used only to classify terminal operational failures. */
    stderrTail: string | null
}

export class CodexCliParticipant extends CliParticipant<CodexRunSummary> {
    /** Send a signal to every active Codex child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        CliParticipant.killAllInstances(CodexCliParticipant, signal)
    }

    private readonly options: CodexCliParticipantOptions
    private threadId: string | null = null

    constructor(agentId: string, opts: CodexCliParticipantOptions) {
        super(agentId, {
            name: "codex",
            // Nullish-coalesce so an explicit `undefined` can't clobber a default.
            binary: opts.codexBin ?? "codex",
            cwd: opts.cwd,
            stdinMode: "ignore",
            closeDrainTimeoutMs: opts.closeDrainTimeoutMs ?? 7_500,
            captureStderrTail: true,
        })
        this.options = opts
    }

    getThreadId(): string | null {
        return this.threadId
    }

    protected override readyFailureMessage(): string {
        return "codex exited before thread.started"
    }

    protected override buildArgs(): string[] {
        const args = ["exec", "--json"]
        if (this.options.skipGitRepoCheck) args.push("--skip-git-repo-check")
        if (this.options.bypassSandbox) {
            // Full bypass, not workspace-write: `.git/` is read-only in
            // workspace-write mode (openai/codex#15505) and stories must commit.
            args.push("--dangerously-bypass-approvals-and-sandbox")
        }
        if (this.options.model) args.push("--model", this.options.model)
        if (this.options.extraArgs?.length) args.push(...this.options.extraArgs)
        args.push(this.options.prompt)
        return args
    }

    protected override summarize(): CodexRunSummary {
        return {
            threadId: this.threadId,
            exitCode: this.exitCode,
            error: this.spawnError,
            stderrTail: this.stderrTail,
        }
    }

    protected override consumeLine(parsed: Record<string, unknown>): void {
        const { items, threadId } = mapCodexEvent(this.agentId, parsed)
        if (threadId && !this.threadId) {
            this.threadId = threadId
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                // Lifecycle mapping per docs/stream-protocols.md § Codex.
                // Gotcha: one-shot exec ends at turn.completed;
                // thread.completed appears only on multi-turn sessions.
                if (
                    CodexSystem.is(item) &&
                    item.data.subtype === "thread.started"
                ) {
                    this.transition("running", "codex thread started")
                    this.settleReady()
                }
                if (CodexTurnEvent.is(item)) {
                    const phase = item.data.phase
                    if (phase === "failed") {
                        this.transition("failed", "codex turn failed")
                    }
                }
                // Don't transition to "done" on thread.completed — the
                // process-close listener owns that, so the real exit code is
                // observed first.
            }
            this.dispatch(item)
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Codex exec is one-shot — no stdin channel; targeted messages are
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
                `[codex:${this.agentId}] received AgentTargetedMessage but Codex exec is one-shot — dropped\n`,
            )
        }
    }
}
