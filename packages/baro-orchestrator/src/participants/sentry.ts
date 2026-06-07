/**
 * Sentry — file-touch conflict detector.
 *
 * Listens to FunctionCallItem (Edit/Write/MultiEdit) on the bus and
 * tracks which files each running agent has touched. When a second
 * agent issues a write to the same path while another agent is still
 * "active" on it, Sentry emits a Coordination("notice") on the bus
 * so observers (Cartographer, future Critic) can see the overlap and
 * a warning lands in the audit log.
 *
 * Phase-2 scope: detect + emit notice, do NOT block tool execution
 * (Claude tools run inside the CLI subprocess; preempting requires
 * Phase-5 PreToolUse hooks). The point is to surface the overlap so
 * we can prove the architecture works and measure how often it fires
 * in real runs.
 *
 * Since per-story worktree isolation (#50), an overlap no longer means a
 * live shared-tree collision — each agent writes its own worktree — but
 * predicts a likely merge-back conflict, so the notice is still useful.
 *
 * Library-grade: no PRD knowledge.
 */

import {
    BaseObserver,
    FunctionCallItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import { AgentState, Coordination } from "../semantic-events.js"

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

interface PendingTouch {
    agentId: string
    path: string
    tool: string
    at: number
}

export interface SentryOptions {
    /**
     * If true, emit a Coordination event with kind="notice" the first
     * time two agents touch the same file in this run. Default: true.
     */
    emitNotice?: boolean
    /**
     * If provided, called whenever an overlap is detected. Mostly for
     * tests / metrics.
     */
    onOverlap?: (info: {
        path: string
        agents: string[]
    }) => void
}

export class Sentry extends BaseObserver {
    private readonly opts: Required<Pick<SentryOptions, "emitNotice">> &
        SentryOptions
    /** path → set of agentIds that have touched it. */
    private readonly touchedBy = new Map<string, Set<string>>()
    /** agentId → terminal phase reached (so we know who's still active). */
    private readonly terminalPhase = new Map<string, string>()
    /** Notices we've already emitted, keyed by `path`. */
    private readonly noticedPaths = new Set<string>()
    /** History of all touches for post-run inspection / tests. */
    private readonly touches: PendingTouch[] = []

    constructor(opts: SentryOptions = {}) {
        super()
        this.opts = {
            emitNotice: opts.emitNotice ?? true,
            ...opts,
        }
    }

    getTouches(): readonly PendingTouch[] {
        return this.touches
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (AgentState.is(event)) {
            const { agentId, phase } = event.data
            if (phase === "done" || phase === "failed" || phase === "aborted") {
                this.terminalPhase.set(agentId, phase)
            }
        }
    }

    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        if (!WRITE_TOOLS.has(item.name)) return
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        const path = extractPath(item)
        if (!path) return

        const touch: PendingTouch = {
            agentId,
            path,
            tool: item.name,
            at: Date.now(),
        }
        this.touches.push(touch)

        const set = this.touchedBy.get(path) ?? new Set<string>()
        set.add(agentId)
        this.touchedBy.set(path, set)

        const otherAgents = [...set].filter((a) => a !== agentId)
        if (otherAgents.length === 0) return

        this.opts.onOverlap?.({
            path,
            agents: [agentId, ...otherAgents],
        })

        if (!this.opts.emitNotice || this.noticedPaths.has(path)) return
        this.noticedPaths.add(path)

        const reason = `agents [${[agentId, ...otherAgents].join(", ")}] both touched ${path}`
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(
                this,
                Coordination.create({
                    fromAgentId: agentId,
                    recipientId: otherAgents[0]!,
                    kind: "notice",
                    reason,
                    payload: { path, agents: [agentId, ...otherAgents] },
                }),
            )
        }
    }
}

function extractPath(item: FunctionCallItem): string | null {
    let args: Record<string, unknown>
    try {
        args = JSON.parse(item.args) as Record<string, unknown>
    } catch {
        return null
    }
    // Common parameter names across Edit/Write/MultiEdit/NotebookEdit.
    for (const key of ["file_path", "path", "notebook_path"]) {
        const v = args[key]
        if (typeof v === "string") return v
    }
    return null
}
