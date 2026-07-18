/**
 * Librarian — cross-agent runtime memory. Captures exploration-tool
 * outputs and shares them via `gatherContext` at story launch, Knowledge
 * events, and mid-flight AgentTargetedMessage broadcasts to in-flight
 * stories whose hints match. Library-grade: no PRD knowledge, no story
 * specifics.
 */

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    AgentTargetedMessage,
    Knowledge,
    StoryResult,
    StorySpawnRequest,
    StorySpawned,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../semantic-events.js"
import type {
    StoryOutcomeAuthority,
    StoryResultAuthorityCorrelation,
} from "../runtime/story-outcome-authority.js"

/** Tools whose results are worth capturing for cross-agent reuse. */
const EXPLORATION_TOOLS = new Set([
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "LSP",
    "WebFetch",
    "WebSearch",
])

/**
 * Bash/WebFetch/WebSearch are deliberately excluded from mid-flight
 * broadcast — their output is too heterogeneous, noise outweighs signal.
 * Their findings still reach the next level via `gatherContext`.
 */
const BROADCAST_TOOLS = new Set(["Read", "Grep", "Glob", "LSP"])

interface PendingCall {
    agentId: string
    correlation: StoryResultAuthorityCorrelation | null
    tool: string
    args: Record<string, unknown>
    tags: string[]
    summary: string
}

interface IndexedKnowledge {
    sourceAgentId: string
    tool: string
    tags: string[]
    summary: string
    content: string
}

export interface LibrarianOptions {
    /** Per-entry content cap. Default: 4000. */
    maxContentChars?: number
    /** Total injected context per story at launch. Default: 20000. */
    maxInjectedChars?: number
    /**
     * Total mid-flight broadcast bytes per story over the run, so a chatty
     * Librarian can't drown a single agent in injected text. Default: 50000.
     */
    maxBroadcastBytesPerStory?: number
    /** Enables exact-source, active-lease filtering for collective tool
     * evidence before it can become a worker message. */
    collective?: {
        runId: string
        outcomeAuthority: StoryOutcomeAuthority
    }
}

export class Librarian extends BaseObserver {
    private readonly opts: Required<Omit<LibrarianOptions, "collective">> &
        Pick<LibrarianOptions, "collective">
    /** Tool protocols scope call ids to one producer. Preserve that namespace
     * explicitly so two parallel participants may reuse the same call id. */
    private readonly pending = new Map<
        Participant,
        Map<string, PendingCall>
    >()
    private readonly knowledge: IndexedKnowledge[] = []

    // Mid-flight bookkeeping
    private readonly inFlight = new Set<string>()
    private readonly storyHints = new Map<string, string[]>()
    private readonly broadcastBytes = new Map<string, number>()
    private readonly activeLeases = new Map<
        string,
        StoryResultAuthorityCorrelation
    >()
    private leaseAuthority: Participant | null = null

    constructor(opts: LibrarianOptions = {}) {
        super()
        this.opts = {
            maxContentChars: opts.maxContentChars ?? 4000,
            maxInjectedChars: opts.maxInjectedChars ?? 20000,
            maxBroadcastBytesPerStory: opts.maxBroadcastBytesPerStory ?? 50000,
            collective: opts.collective,
        }
        if (
            opts.collective &&
            opts.collective.outcomeAuthority.runId !== opts.collective.runId
        ) {
            throw new Error("Librarian collective authority runId mismatch")
        }
    }

    setLeaseAuthority(authority: Participant): void {
        if (this.leaseAuthority && this.leaseAuthority !== authority) {
            throw new Error("Librarian lease authority is already bound")
        }
        this.leaseAuthority = authority
    }

    /** All indexed knowledge entries, in order discovered. */
    getKnowledge(): readonly IndexedKnowledge[] {
        return this.knowledge
    }

    /**
     * Context blob to prepend to a new story's prompt; null when nothing
     * relevant. Hints bias relevance ranking.
     */
    gatherContext(storyId: string, hints: readonly string[] = []): string | null {
        if (this.knowledge.length === 0) return null

        // Only inject *cross-agent* knowledge.
        const candidates = this.knowledge.filter(
            (k) => k.sourceAgentId !== storyId,
        )
        if (candidates.length === 0) return null

        const lowerHints = hints.map((h) => h.toLowerCase())
        const scored = candidates.map((k) => {
            const haystack = (k.summary + " " + k.tags.join(" ")).toLowerCase()
            const score = lowerHints.reduce(
                (acc, h) => acc + (haystack.includes(h) ? 1 : 0),
                0,
            )
            return { k, score }
        })
        scored.sort((a, b) => b.score - a.score)

        const lines: string[] = []
        let total = 0
        for (const { k } of scored) {
            const block = formatEntry(k)
            if (total + block.length > this.opts.maxInjectedChars) {
                lines.push("[…librarian truncated remaining findings…]")
                break
            }
            lines.push(block)
            total += block.length
        }

        if (lines.length === 0) return null
        return [
            "## Codebase context (current as of this run)",
            "",
            "The following file contents and discovery results are authoritative",
            "and up-to-date. Do not re-read or re-search unless you have specific",
            "reason to suspect a file has changed since these were captured.",
            "",
            ...lines,
        ].join("\n")
    }

    override async onExternalFunctionCall(source: Participant, item: FunctionCallItem): Promise<void> {
        this.recordPending(source, item)
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        this.completeWithOutput(source, item)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        const collective = this.opts.collective
        if (collective && WorkLeaseGranted.is(event)) {
            if (
                source !== this.leaseAuthority ||
                event.data.runId !== collective.runId
            ) return
            const storyId = event.data.request.storyId
            const current = this.activeLeases.get(storyId)
            if (
                current &&
                (event.data.generation < current.generation ||
                    (event.data.generation === current.generation &&
                        event.data.leaseId !== current.leaseId))
            ) return
            if (
                current &&
                event.data.generation === current.generation &&
                event.data.leaseId === current.leaseId
            ) return
            if (current) this.dropPendingForCorrelation(current)
            this.activeLeases.set(storyId, {
                runId: collective.runId,
                storyId,
                leaseId: event.data.leaseId,
                generation: event.data.generation,
            })
            this.storyHints.set(storyId, tokenizeHints(event.data.request.prompt))
            this.inFlight.add(storyId)
            return
        }
        if (collective && WorkLeaseReleased.is(event)) {
            if (
                source !== this.leaseAuthority ||
                event.data.runId !== collective.runId
            ) return
            const current = this.activeLeases.get(event.data.storyId)
            if (current?.leaseId !== event.data.leaseId) return
            this.dropPendingForCorrelation(current)
            this.activeLeases.delete(event.data.storyId)
            this.inFlight.delete(event.data.storyId)
            this.storyHints.delete(event.data.storyId)
            return
        }
        if (collective) return
        if (StorySpawnRequest.is(event)) {
            this.storyHints.set(
                event.data.storyId,
                tokenizeHints(event.data.prompt),
            )
            return
        }
        if (StorySpawned.is(event)) {
            this.inFlight.add(event.data.storyId)
            return
        }
        if (StoryResult.is(event)) {
            this.inFlight.delete(event.data.storyId)
        }
    }

    private recordPending(source: Participant, item: FunctionCallItem): void {
        if (!EXPLORATION_TOOLS.has(item.name)) return
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        const correlation = this.opts.collective
            ? this.collectiveCorrelation(source, agentId)
            : null
        if (this.opts.collective && !correlation) return
        let parsedArgs: Record<string, unknown> = {}
        try {
            parsedArgs = JSON.parse(item.args) as Record<string, unknown>
        } catch {
            // ignore malformed arg JSON; we'll still record summary
        }
        const { tags, summary } = describeCall(item.name, parsedArgs)
        let sourcePending = this.pending.get(source)
        if (!sourcePending) {
            sourcePending = new Map()
            this.pending.set(source, sourcePending)
        }
        sourcePending.set(item.callId, {
            agentId,
            correlation,
            tool: item.name,
            args: parsedArgs,
            tags,
            summary,
        })
    }

    private completeWithOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): void {
        const json = item.toJSON() as {
            call_id: string
            output: Array<{ text: string }>
        }
        const pending = this.pending.get(source)?.get(json.call_id)
        if (!pending) return
        if (
            pending.correlation &&
            !sameCorrelation(
                pending.correlation,
                this.collectiveCorrelation(source, pending.agentId),
            )
        ) {
            this.deletePending(source, json.call_id)
            return
        }
        this.deletePending(source, json.call_id)

        const fullOutput = json.output.map((b) => b.text).join("\n")
        const content =
            fullOutput.length > this.opts.maxContentChars
                ? fullOutput.slice(0, this.opts.maxContentChars) +
                  "\n[…librarian truncated…]"
                : fullOutput

        const entry: IndexedKnowledge = {
            sourceAgentId: pending.agentId,
            tool: pending.tool,
            tags: pending.tags,
            summary: pending.summary,
            content,
        }
        this.knowledge.push(entry)

        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(
                this,
                Knowledge.create({
                    sourceAgentId: entry.sourceAgentId,
                    tags: entry.tags,
                    summary: entry.summary,
                    content: entry.content,
                    tool: entry.tool,
                }),
            )
        }

        // ClaudeCliParticipant routes AgentTargetedMessage into the agent's
        // stdin as a user message, so the finding lands before its next turn.
        if (BROADCAST_TOOLS.has(entry.tool)) {
            this.broadcastFinding(entry)
        }
    }

    private broadcastFinding(finding: IndexedKnowledge): void {
        if (this.inFlight.size === 0) return
        const envs = this.getEnvironments()
        if (envs.length === 0) return

        const findingTokens = new Set(
            [...finding.tags, finding.summary]
                .join(" ")
                .toLowerCase()
                .split(/[^a-z0-9_/.\\-]+/)
                .filter((t) => t.length >= 3),
        )

        const block = formatEntry(finding)
        const text = [
            "## Just-in-time codebase context",
            "",
            `Another agent in this run (${finding.sourceAgentId}) just`,
            "discovered the following. It is authoritative and current;",
            "use it directly without re-fetching.",
            "",
            block,
        ].join("\n")
        const bytes = text.length

        for (const recipientId of this.inFlight) {
            if (recipientId === finding.sourceAgentId) continue

            const recipientHints = this.storyHints.get(recipientId) ?? []
            if (recipientHints.length > 0) {
                const overlap = recipientHints.some((h) =>
                    findingTokens.has(h.toLowerCase()),
                )
                if (!overlap) continue
            }
            // No hints captured → broadcast anyway; safer to over-share than
            // miss a relevant finding because hints weren't ready.

            const already = this.broadcastBytes.get(recipientId) ?? 0
            if (already + bytes > this.opts.maxBroadcastBytesPerStory) continue
            this.broadcastBytes.set(recipientId, already + bytes)

            for (const env of envs) {
                env.deliverSemanticEvent(
                    this,
                    AgentTargetedMessage.create({
                        recipientId,
                        text,
                        metadata: {
                            source: "librarian",
                            finding: finding.summary,
                            from_agent: finding.sourceAgentId,
                        },
                    }),
                )
            }
        }
    }

    private collectiveCorrelation(
        source: Participant,
        storyId: string,
    ): StoryResultAuthorityCorrelation | null {
        const collective = this.opts.collective
        if (!collective) return null
        const active = this.activeLeases.get(storyId)
        const authenticated =
            collective.outcomeAuthority.terminalCorrelationForSource(
                source,
                storyId,
            )
        return sameCorrelation(active ?? null, authenticated) ? active! : null
    }

    private dropPendingForCorrelation(
        correlation: StoryResultAuthorityCorrelation,
    ): void {
        for (const [source, calls] of this.pending) {
            for (const [callId, pending] of calls) {
                if (sameCorrelation(pending.correlation, correlation)) {
                    calls.delete(callId)
                }
            }
            if (calls.size === 0) this.pending.delete(source)
        }
    }

    private deletePending(source: Participant, callId: string): void {
        const calls = this.pending.get(source)
        if (!calls) return
        calls.delete(callId)
        if (calls.size === 0) this.pending.delete(source)
    }
}

function sameCorrelation(
    left: StoryResultAuthorityCorrelation | null,
    right: StoryResultAuthorityCorrelation | null,
): boolean {
    return (
        left !== null &&
        right !== null &&
        left.runId === right.runId &&
        left.storyId === right.storyId &&
        left.leaseId === right.leaseId &&
        left.generation === right.generation
    )
}

function describeCall(
    tool: string,
    args: Record<string, unknown>,
): { tags: string[]; summary: string } {
    const tags: string[] = [tool.toLowerCase()]
    let summary = `${tool} call`

    if (tool === "Read") {
        const path = stringArg(args, "file_path") ?? stringArg(args, "path")
        if (path) {
            summary = `Read ${path}`
            tags.push(path)
            const base = path.split("/").pop()
            if (base) tags.push(base)
        }
    } else if (tool === "Grep") {
        const pattern = stringArg(args, "pattern")
        const path = stringArg(args, "path")
        summary = `Grep '${pattern ?? "?"}'${path ? ` in ${path}` : ""}`
        if (pattern) tags.push(pattern)
        if (path) tags.push(path)
    } else if (tool === "Glob") {
        const pattern = stringArg(args, "pattern")
        summary = `Glob '${pattern ?? "?"}'`
        if (pattern) tags.push(pattern)
    } else if (tool === "Bash") {
        const cmd = stringArg(args, "command")
        summary = `Bash ${truncate(cmd ?? "", 80)}`
        if (cmd) tags.push(cmd.split(/\s+/)[0] ?? "")
    } else if (tool === "WebFetch") {
        const url = stringArg(args, "url")
        summary = `WebFetch ${url ?? "?"}`
        if (url) tags.push(url)
    } else if (tool === "WebSearch") {
        const q = stringArg(args, "query")
        summary = `WebSearch '${truncate(q ?? "", 60)}'`
        if (q) tags.push(q)
    }
    return { tags: tags.filter((t) => t.length > 0), summary }
}

function stringArg(
    args: Record<string, unknown>,
    key: string,
): string | undefined {
    const v = args[key]
    return typeof v === "string" ? v : undefined
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n)}…` : s
}

function formatEntry(k: IndexedKnowledge): string {
    return [
        `--- [${k.sourceAgentId}] ${k.summary} ---`,
        k.content,
        "",
    ].join("\n")
}

// Keeps dots/slashes/dashes so filenames like `invoice.service.ts` survive.
function tokenizeHints(prompt: string): string[] {
    return prompt
        .toLowerCase()
        .split(/[^a-z0-9_/.\-]+/)
        .filter((t) => t.length >= 3)
}
