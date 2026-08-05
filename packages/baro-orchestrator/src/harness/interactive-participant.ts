/**
 * A model that stays open for the length of a phase, listening.
 *
 * Planning, architecture and scouting are conversations, not calls: the host
 * asks, the model answers, findings arrive from elsewhere and are handed to it
 * mid-session, and a rejected outcome comes back as a correction rather than a
 * dead phase. Everything those sessions need from a model is below — nine
 * operations, three of which every mozaik participant already has.
 *
 * Until now they could only be had from a CLI, which is why they were
 * Claude-only. That was never a mozaik limitation. A CLI is a separate
 * process, so a tool it calls has to travel back: Claude's planner tool goes
 * through a spawned MCP server, a JSON-RPC stdio protocol, a loopback TCP
 * socket and a shared secret, to reach `publisher.publish(args)` in the very
 * process that started it. A participant that runs inside our loop is handed
 * the function.
 */

import type { AgenticEnvironment, Participant, Tool } from "../runtime/mozaik.js"

export interface InteractiveModelParticipant<TSummary> extends Participant {
    /** Stable bus identity; observers attribute events to it. */
    readonly agentId: string
    /** Settles when the session ends, with whatever the lane summarises. */
    readonly done: Promise<TSummary>
    /** Called on any sign of life. Silence — not a stopwatch — ends a session. */
    onActivity: (() => void) | null

    /** Begin the session on this environment. Idempotent. */
    start(environment: AgenticEnvironment): void
    /**
     * Hand the model something to read. Delivered mid-session: a scout's
     * finding, an admission receipt, a named reason its outcome was refused.
     */
    sendUserMessage(text: string): void
    /** No more input is coming; let the model finish on its own terms. */
    closeStdin(): void
    /** Stop now and resolve once nothing of this session's is still running. */
    abortAndWait(signal?: NodeJS.Signals): Promise<boolean>
    /**
     * One sentence on how the session ended, for the caller's failure text.
     *
     * The sessions only ever read the summary to explain a session that
     * stopped early, and what explains it differs per lane — an exit code and
     * a signal for a process, a round count and an abort reason for a loop.
     * Normalising it here is what keeps `exitCode` out of shared planning code.
     */
    sessionEndDetail(): string
}

/**
 * What a lane needs to build one. `tools` is the whole difference between the
 * two implementations: a CLI takes names of tools it already owns plus an MCP
 * config to reach ours, while a native participant takes the functions.
 */
export interface InteractiveParticipantRequest {
    readonly agentId: string
    readonly cwd: string
    readonly model?: string
    readonly effort?: string
    readonly systemPrompt: string
    /** Native tools. Ignored by the CLI lane, which names its own instead. */
    readonly tools?: readonly Tool[]
    /** CLI-only extras (`--tools Read,Glob,Grep`, mcp config, safe mode). */
    readonly cliExtraArgs?: readonly string[]
    /** Exact bus authority allowed to deliver a targeted message to it. */
    readonly targetedMessageAuthority?: Participant
    readonly targetedMessageCorrelation?: {
        runId: string
        leaseId: string
        generation: number
    }
}
