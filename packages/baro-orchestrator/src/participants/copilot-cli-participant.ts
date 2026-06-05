/**
 * CopilotCliParticipant — wraps a GitHub Copilot CLI process as a
 * first-class Mozaik Participant. Sibling of `CodexCliParticipant`.
 *
 * Spawned with `copilot -p <PROMPT> --output-format json --yolo
 * --no-ask-user`. Copilot `-p` is one-shot non-interactive: takes a single
 * prompt as argv, streams JSONL events to stdout, exits when the agent
 * finishes (nonzero on LLM error). There is no stdin event loop (unlike
 * Claude Code's stream-json input). That makes this participant simpler
 * than ClaudeCliParticipant in one respect — `onExternalEvent` doesn't
 * forward AgentTargetedMessage to a running process; new prompts mean a
 * new Copilot invocation.
 *
 * Library-grade: knows nothing about baro, PRD, or stories. Only knows
 * about agent IDs, working directories, and Copilot.
 */

import { ChildProcess, spawn } from "child_process"

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import {
    AgentState,
    AgentTargetedMessage,
    CopilotSystem,
    type AgentPhase,
} from "../semantic-events.js"
import { mapCopilotEvent } from "../copilot-stream-mapper.js"
import { clampCopilotEffort } from "../copilot-one-shot.js"

export interface CopilotCliParticipantOptions {
    /** Working directory for the Copilot process. Required. */
    cwd: string
    /** Initial prompt — passed as the value of `-p` on `copilot`. */
    prompt: string
    /**
     * Model identifier (e.g. `claude-sonnet-4.5`, `gpt-5`). Pass undefined
     * to let Copilot use its default (`claude-sonnet-4.5`).
     */
    model?: string
    /**
     * Raw baro effort value (`low|medium|high|xhigh|max`). Clamped via the
     * shared `clampCopilotEffort` helper before being passed as
     * `--reasoning-effort`; omitted entirely when it clamps to undefined.
     */
    effort?: string
    /** Extra CLI arguments appended after the standard set. */
    extraArgs?: string[]
    /** Path to the `copilot` binary. Default: "copilot" (resolved via PATH). */
    copilotBin?: string
}

export interface CopilotRunSummary {
    sessionId: string | null
    exitCode: number | null
    error: Error | null
}

export class CopilotCliParticipant extends BaseObserver {
    /**
     * Process-wide registry of every Copilot child currently running. Used
     * by the orchestrator's SIGINT/SIGTERM handlers to nuke orphans so a
     * killed baro doesn't leave a swarm of background agents burning
     * quota.
     */
    private static readonly active = new Set<CopilotCliParticipant>()

    /** Send a signal to every active Copilot child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of CopilotCliParticipant.active) {
            try {
                p.proc?.kill(signal)
            } catch {
                // best-effort
            }
        }
    }

    private readonly options: Required<
        Pick<CopilotCliParticipantOptions, "copilotBin">
    > &
        CopilotCliParticipantOptions

    private proc: ChildProcess | null = null
    private buffer = ""
    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private sessionId: string | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private resolveDone!: (summary: CopilotRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void
    private readyResolved = false

    /** Resolves once Copilot emits its first recognized lifecycle/JSON line. */
    public readonly ready: Promise<void>
    /** Resolves once the Copilot process exits (regardless of success). */
    public readonly done: Promise<CopilotRunSummary>

    constructor(
        public readonly agentId: string,
        opts: CopilotCliParticipantOptions,
    ) {
        super()
        this.options = {
            copilotBin: "copilot",
            ...opts,
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        this.done = new Promise<CopilotRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    /**
     * Spawn the Copilot process and start streaming its events into the
     * environment. Idempotent: subsequent calls are a no-op.
     */
    start(environment: AgenticEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.options.copilotBin, args, {
                cwd: this.options.cwd,
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.rejectReady(this.spawnError)
            this.resolveDone({
                sessionId: null,
                exitCode: null,
                error: this.spawnError,
            })
            return
        }

        this.proc = proc
        CopilotCliParticipant.active.add(this)
        this.transition("starting")

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
        proc.stderr!.on("data", (chunk: string) => this.handleStderr(chunk))
        proc.on("error", (err) => {
            this.spawnError = err
            this.rejectReady(err)
        })
        proc.on("exit", (code) => {
            CopilotCliParticipant.active.delete(this)
            this.exitCode = code
            const finalPhase: AgentPhase =
                this.spawnError != null || (code != null && code !== 0)
                    ? "failed"
                    : "done"
            this.transition(
                finalPhase,
                code != null ? `exit code ${code}` : "no exit code",
            )
            this.resolveDone({
                sessionId: this.sessionId,
                exitCode: code,
                error: this.spawnError,
            })
        })
    }

    /** Kill the Copilot process. Resolves once exit fires. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        this.transition("aborted")
        this.proc?.kill(signal)
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // No-op for now. Copilot `-p` is one-shot: it doesn't have a stdin
        // user-message channel like Claude Code. AgentTargetedMessage
        // delivery to a running Copilot would require either a new
        // invocation or future Copilot support for session resumption.
        // Surface this as a noisy warning so we catch any assumption from
        // the orchestrator that messages route the way they do for Claude.
        if (
            AgentTargetedMessage.is(event) &&
            event.data.recipientId === this.agentId
        ) {
            process.stderr.write(
                `[copilot:${this.agentId}] received AgentTargetedMessage but Copilot -p is one-shot — dropped\n`,
            )
        }
    }

    private buildArgs(): string[] {
        // `copilot -p <PROMPT> --output-format json --yolo --no-ask-user`.
        // --yolo + --no-ask-user are always present: baro runs in per-story
        // git worktrees, so auto-approving tools and never pausing for input
        // is the correct autonomous posture (mirroring the Codex
        // bypassSandbox rationale).
        const args = [
            "-p",
            this.options.prompt,
            "--output-format",
            "json",
            "--yolo",
            "--no-ask-user",
        ]
        if (this.options.model) args.push("--model", this.options.model)
        // Effort flows through the SINGLE shared clamp helper so the
        // participant and the one-shot can never disagree on the mapping.
        const effort = clampCopilotEffort(this.options.effort)
        if (effort) args.push("--reasoning-effort", effort)
        if (this.options.extraArgs?.length) args.push(...this.options.extraArgs)
        return args
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk
        let nl: number
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim()
            this.buffer = this.buffer.slice(nl + 1)
            if (!line) continue
            this.processLine(line)
        }
    }

    private handleStderr(chunk: string): void {
        const trimmed = chunk.trimEnd()
        if (!trimmed) return
        process.stderr.write(`[copilot:${this.agentId}/stderr] ${trimmed}\n`)
    }

    private processLine(line: string): void {
        let parsed: Record<string, any>
        try {
            parsed = JSON.parse(line)
        } catch {
            process.stderr.write(
                `[copilot:${this.agentId}] non-JSON stdout: ${line.slice(0, 200)}\n`,
            )
            return
        }

        const { items, sessionId } = mapCopilotEvent(this.agentId, parsed)
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                // Lifecycle signals. Copilot's stream opens with a burst of
                // session.* envelopes before the first assistant turn (real
                // shape observed in S1 probe, copilot v1.0.59); the first
                // recognized lifecycle event flips us to "running" and
                // resolves `ready`.
                if (CopilotSystem.is(item)) {
                    this.markReady("copilot lifecycle event")
                }
                // Don't transition to "done" / "failed" on the terminal
                // `result` envelope — the process-exit listener owns that, so
                // we observe the real exit code before locking in the
                // AgentPhase (mirror of CodexCliParticipant).
            }
            this.dispatch(item)
        }

        // Fallback: if we got a parseable line but no recognized lifecycle
        // event yet, resolve `ready` anyway so the orchestrator isn't blocked
        // waiting on a session.* envelope that a future schema may drop.
        this.markReady("first parsed JSON line")
    }

    /** Idempotently flip to "running" and resolve the `ready` promise. */
    private markReady(detail: string): void {
        if (this.readyResolved) return
        this.readyResolved = true
        this.transition("running", detail)
        this.resolveReady()
    }

    /**
     * Route a mapped event to the right Mozaik delivery channel.
     * Mirror of CodexCliParticipant.dispatch — assistant-side LLM items
     * use Mozaik's typed channels; everything else goes through
     * deliverSemanticEvent.
     */
    private dispatch(
        item:
            | ModelMessageItem
            | FunctionCallItem
            | FunctionCallOutputItem
            | SemanticEvent<unknown>,
    ): void {
        if (!this.envRef) return
        if (item instanceof ModelMessageItem) {
            this.envRef.deliverModelMessage(this, item)
            return
        }
        if (item instanceof FunctionCallItem) {
            this.envRef.deliverFunctionCall(this, item)
            return
        }
        if (item instanceof FunctionCallOutputItem) {
            this.envRef.deliverFunctionCallOutput(this, item)
            return
        }
        this.envRef.deliverSemanticEvent(this, item)
    }

    private transition(next: AgentPhase, detail?: string): void {
        if (next === this.currentPhase) return
        this.currentPhase = next
        this.envRef?.deliverSemanticEvent(
            this,
            AgentState.create({
                agentId: this.agentId,
                phase: next,
                detail,
            }),
        )
    }
}
