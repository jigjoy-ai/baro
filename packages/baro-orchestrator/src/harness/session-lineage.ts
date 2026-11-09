/**
 * Context follows the work. A story started cold re-read the repository its
 * prerequisite had just studied (one bench story spent 2.3M input tokens and
 * six minutes on that before its first edit). A story may instead start as a
 * fork of another story's session, or continue its own after a host
 * suspension. Lanes that cannot resume a session start cold as before.
 * BARO_SESSION_FORK=0 turns inheritance off.
 */

import type { ContextItem } from "../runtime/mozaik.js"

export type SessionInheritMode = "fork" | "continue"

/** Chosen by the Board, which knows the graph; resolved by the factory, which knows the sessions. */
export interface StorySessionSource {
    readonly storyId: string
    readonly mode: SessionInheritMode
}

export type SessionBackend = "claude" | "openai"

export interface SessionRecord {
    readonly backend: SessionBackend
    /** Claude Code session id (`--resume`). */
    readonly sessionId?: string
    /** Native lane: context items up to the last completed round. */
    readonly items?: readonly ContextItem[]
    /** Size of the session's last model request; null when never observed. */
    readonly contextTokens: number | null
    readonly cwd: string
}

export interface SessionInheritance {
    readonly mode: SessionInheritMode
    readonly fromStoryId: string
    readonly parentCwd: string
    readonly contextTokens: number
    readonly claudeSessionId?: string
    readonly items?: readonly ContextItem[]
}

/**
 * Latest resumable session of each story in one run. Read lazily: a dependent
 * forks a story that is still running, the moment it publishes a checkpoint.
 */
export class SessionLedger {
    private readonly readers = new Map<string, () => SessionRecord | null>()

    track(storyId: string, read: () => SessionRecord | null): void {
        this.readers.set(storyId, read)
    }

    record(storyId: string, record: SessionRecord): void {
        this.readers.set(storyId, () => record)
    }

    get(storyId: string): SessionRecord | undefined {
        return this.readers.get(storyId)?.() ?? undefined
    }
}

export function sessionForkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.BARO_SESSION_FORK !== "0"
}

/** A fork that starts near the window compacts at once and loses what it inherited. */
const DEFAULT_MAX_INHERITED_TOKENS = 120_000

export function maxInheritedContextTokens(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number.parseInt(env.BARO_SESSION_FORK_MAX_TOKENS ?? "", 10)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_INHERITED_TOKENS
}

export type InheritanceDecision =
    | { readonly inherit: SessionInheritance }
    | { readonly skipped: string }

/** Why a story starts cold is always stated: a silent miss looks like a slow story. */
export function resolveInheritance(
    source: StorySessionSource | undefined,
    backend: string,
    ledger: SessionLedger,
    env: NodeJS.ProcessEnv = process.env,
): InheritanceDecision | null {
    if (!source) return null
    if (!sessionForkEnabled(env)) return { skipped: "session inheritance is off (BARO_SESSION_FORK=0)" }
    const record = ledger.get(source.storyId)
    if (!record) return { skipped: `${source.storyId} has no recorded session` }
    if (record.backend !== backend) {
        return { skipped: `${source.storyId} ran on ${record.backend}, this story runs on ${backend}` }
    }
    if (record.contextTokens === null) {
        return { skipped: `the size of ${source.storyId}'s session is unknown` }
    }
    const limit = maxInheritedContextTokens(env)
    if (record.contextTokens > limit) {
        return {
            skipped:
                `${source.storyId}'s session holds ${record.contextTokens} tokens, over the ${limit} limit ` +
                "(BARO_SESSION_FORK_MAX_TOKENS)",
        }
    }
    if (record.backend === "claude" ? !record.sessionId : !record.items?.length) {
        return { skipped: `${source.storyId}'s session cannot be resumed` }
    }
    return {
        inherit: {
            mode: source.mode,
            fromStoryId: source.storyId,
            parentCwd: record.cwd,
            contextTokens: record.contextTokens,
            ...(record.sessionId ? { claudeSessionId: record.sessionId } : {}),
            ...(record.items ? { items: record.items } : {}),
        },
    }
}

/**
 * First message of an inheriting session. A fork believes it is still its
 * parent, in its parent's worktree, unless told otherwise.
 */
export function inheritancePreamble(
    inherit: Pick<SessionInheritance, "mode" | "fromStoryId" | "parentCwd">,
    storyId: string,
    cwd: string,
): string {
    if (inherit.mode === "continue") {
        return [
            `## You are resuming story ${storyId}`,
            "",
            "Everything above is your own earlier session on this story. It was suspended until its",
            "prerequisites integrated, and they now have: your worktree was re-based onto the run branch,",
            "so files may differ from what you last saw. Check `git log` and `git status` before relying",
            "on earlier line numbers, then finish the story. The task statement below is current and",
            "supersedes the earlier one where they differ.",
        ].join("\n")
    }
    return [
        `## You are a fork of story ${inherit.fromStoryId}'s session`,
        "",
        `Everything above is the session of story ${inherit.fromStoryId}: what it read, decided and did. You`,
        "inherit it so you do not have to rediscover it. Do not re-read files you already know unless",
        "they may have changed.",
        "",
        `You are now story ${storyId}, a separate agent with its own task, stated below. ${inherit.fromStoryId} is`,
        "not you and goes on separately: do not continue its task and do not redo its work.",
        "",
        `Your worktree is ${cwd}. ${inherit.fromStoryId} worked in ${inherit.parentCwd}; paths above that point`,
        `there belong to ${inherit.fromStoryId}. Use the same relative paths under your own worktree and never`,
        "write outside it. Your tree holds the run branch plus any checkpoints named below, so it can",
        `differ from what ${inherit.fromStoryId} last saw: check with git before relying on a line number.`,
    ].join("\n")
}
