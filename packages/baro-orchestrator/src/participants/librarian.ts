/**
 * Librarian — cross-agent runtime memory observer with mid-flight
 * broadcast.
 *
 * Listens to FunctionCallItem / FunctionCallOutputItem on the bus,
 * extracts knowledge from "exploration" tools (Read, Grep, Bash, Glob,
 * LSP), and shares it three ways:
 *
 *   1. `gatherContext(storyId, hints?)` — at story launch. Conductor's
 *      `onBeforeStoryLaunch` hook calls this and prepends the result
 *      to the story's initial prompt. Same as before, just with much
 *      bigger budget and a stronger authoritative framing.
 *
 *   2. `KnowledgeItem` bus events — emitted on every new finding so
 *      other observers can react.
 *
 *   3. **NEW**: `AgentTargetedMessageItem` mid-flight broadcasts.
 *      When Story A indexes a finding, Librarian pushes a
 *      just-in-time message into every other *in-flight* story
 *      whose hints match the finding. Those messages reach the
 *      receiving Claude process via its existing stdin user-message
 *      route (ClaudeCliParticipant already handles
 *      AgentTargetedMessageItem). The receiving Claude sees the
 *      finding as authoritative codebase context on its next turn
 *      and skips redundant Read/Grep calls.
 *
 * In-flight tracking:
 *   - StorySpawnRequestItem → captures story hints (title tokens)
 *     so we can match findings against them later.
 *   - StorySpawnedItem      → mark story as in-flight.
 *   - StoryResultItem       → clear story from in-flight set.
 *
 * Library-grade: no PRD knowledge, no story specifics.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    Participant,
} from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "../bus.js"

import {
    AgentTargetedMessageItem,
    KnowledgeItem,
    StorySpawnRequestItem,
    StorySpawnedItem,
} from "../types.js"
import { StoryResultItem } from "./story-agent.js"

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
 * Tools whose findings we broadcast mid-flight. Bash is intentionally
 * excluded from broadcast (its output is heterogeneous — sometimes a
 * one-liner, sometimes a 50KB build log — and noise outweighs signal
 * for cross-agent reuse). Bash findings still go into the on-launch
 * `gatherContext` for the next level. Same for WebFetch/WebSearch.
 */
const BROADCAST_TOOLS = new Set(["Read", "Grep", "Glob", "LSP"])

interface PendingCall {
    agentId: string
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
    /**
     * Cap the body of each indexed entry to this many characters
     * (truncated with a marker). Default: 4000.
     */
    maxContentChars?: number
    /**
     * Cap the total injected context per story at launch to this
     * many characters. Default: 20000.
     */
    maxInjectedChars?: number
    /**
     * Cap the total mid-flight broadcast bytes pushed into any one
     * story over the run, to keep a chatty Librarian from drowning
     * a single agent in injected text. Default: 50000.
     */
    maxBroadcastBytesPerStory?: number
}

export class Librarian extends BaroParticipant {
    private readonly opts: Required<LibrarianOptions>
    private readonly pending = new Map<string, PendingCall>()
    private readonly knowledge: IndexedKnowledge[] = []

    // Mid-flight bookkeeping
    private readonly inFlight = new Set<string>()
    private readonly storyHints = new Map<string, string[]>()
    private readonly broadcastBytes = new Map<string, number>()

    constructor(opts: LibrarianOptions = {}) {
        super()
        this.opts = {
            maxContentChars: opts.maxContentChars ?? 4000,
            maxInjectedChars: opts.maxInjectedChars ?? 20000,
            maxBroadcastBytesPerStory: opts.maxBroadcastBytesPerStory ?? 50000,
        }
    }

    /** All indexed knowledge entries, in order discovered. */
    getKnowledge(): readonly IndexedKnowledge[] {
        return this.knowledge
    }

    /**
     * Build a context blob to prepend to a new story's prompt. Returns
     * `null` if there's nothing relevant. Hints (e.g. tags from the
     * story title/description) bias relevance ranking.
     */
    gatherContext(storyId: string, hints: readonly string[] = []): string | null {
        if (this.knowledge.length === 0) return null

        // Skip findings the story itself produced — we only inject
        // *cross-agent* knowledge.
        const candidates = this.knowledge.filter(
            (k) => k.sourceAgentId !== storyId,
        )
        if (candidates.length === 0) return null

        // Rank by hint overlap (strict substring match, case-insensitive).
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

    override async onExternalBusEvent(_source: Participant, event: BusEvent): Promise<void> {
        if (event instanceof StorySpawnRequestItem) {
            this.storyHints.set(event.storyId, tokenizeHints(event.prompt))
            return
        }
        if (event instanceof StorySpawnedItem) {
            this.inFlight.add(event.storyId)
            return
        }
        if (event instanceof StoryResultItem) {
            this.inFlight.delete(event.storyId)
        }
    }

    private recordPending(source: Participant, item: FunctionCallItem): void {
        if (!EXPLORATION_TOOLS.has(item.name)) return
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        let parsedArgs: Record<string, unknown> = {}
        try {
            parsedArgs = JSON.parse(item.args) as Record<string, unknown>
        } catch {
            // ignore malformed arg JSON; we'll still record summary
        }
        const { tags, summary } = describeCall(item.name, parsedArgs)
        this.pending.set(item.callId, {
            agentId,
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
        const pending = this.pending.get(json.call_id)
        if (!pending) return
        this.pending.delete(json.call_id)

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

        // Surface as a bus event for any other observers (and Phase-3
        // mid-flight injectors).
        for (const env of this.getEnvironments()) {
            (env as BaroEnvironment).deliverBusEvent(
                this,
                new KnowledgeItem(
                    entry.sourceAgentId,
                    entry.tags,
                    entry.summary,
                    entry.content,
                    entry.tool,
                ),
            )
        }

        // Mid-flight broadcast: push this finding to every other
        // in-flight story whose stored hints overlap with the
        // finding's tags. The receiving ClaudeCliParticipant already
        // routes AgentTargetedMessageItem into its agent's stdin as a
        // user message, so the next turn opens with the finding
        // already in context — and the agent skips its own Read.
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

            // Hint overlap: at least one finding token appears in the
            // recipient's stored hints. Liberal threshold for v1.
            const recipientHints = this.storyHints.get(recipientId) ?? []
            if (recipientHints.length > 0) {
                const overlap = recipientHints.some((h) =>
                    findingTokens.has(h.toLowerCase()),
                )
                if (!overlap) continue
            }
            // If no hints were captured for this recipient, fall through
            // and broadcast anyway — safer to over-share early than
            // miss a relevant finding because hints weren't ready.

            // Per-story broadcast budget.
            const already = this.broadcastBytes.get(recipientId) ?? 0
            if (already + bytes > this.opts.maxBroadcastBytesPerStory) continue
            this.broadcastBytes.set(recipientId, already + bytes)

            for (const env of envs) {
                (env as BaroEnvironment).deliverBusEvent(
                    this,
                    new AgentTargetedMessageItem(recipientId, text, {
                        source: "librarian",
                        finding: finding.summary,
                        from_agent: finding.sourceAgentId,
                    }),
                )
            }
        }
    }
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

/**
 * Pull short, lowercase tokens from a story prompt to use as
 * broadcast-relevance hints. We grab anything alphanumeric with
 * dots/slashes/dashes (so we catch filenames like `invoice.service.ts`),
 * lowercase everything, and drop tokens shorter than 3 chars.
 */
function tokenizeHints(prompt: string): string[] {
    return prompt
        .toLowerCase()
        .split(/[^a-z0-9_/.\-]+/)
        .filter((t) => t.length >= 3)
}
