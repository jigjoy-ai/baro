/**
 * MemoryLibrarian — semantic memory for cross-agent context sharing.
 *
 * Simple architecture:
 * 1. Agents read files → cached in ChromaDB
 * 2. New story launches → semantic search for relevant context
 * 3. Context injected at launch (not mid-flight spam)
 *
 * Log: ~/.baro/runs/memory-*.log
 * Debug: BARO_DEBUG=memory
 */

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    Knowledge,
    StoryResult,
    StorySpawned,
} from "../semantic-events.js"

// ── Logging ──────────────────────────────────────────────────

const DEBUG = process.env.BARO_DEBUG?.includes("memory") ?? false
import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"

const LOG_DIR = join(process.env.HOME || "/tmp", ".baro", "runs")
const LOG_FILE = join(LOG_DIR, `memory-${Date.now()}.log`)
try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}

const stats = {
    stored: 0,
    cached: 0,
    queries: 0,
    hits: 0,
    charsStored: 0,
    charsReturned: 0,
}

function log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    try { appendFileSync(LOG_FILE, line) } catch {}
    if (DEBUG) process.stderr.write(`[memory] ${msg}\n`)
}

function logStats(): void {
    const hitRate = stats.queries > 0 ? Math.round((stats.hits / stats.queries) * 100) : 0
    log("")
    log("╔═══════════════════════════════════════════════════════════╗")
    log("║              MEMORY STATS                                ║")
    log("╠═══════════════════════════════════════════════════════════╣")
    log(`║  Findings stored:     ${String(stats.stored).padEnd(35)}║`)
    log(`║  Files cached:        ${String(stats.cached).padEnd(35)}║`)
    log(`║  Context queries:     ${String(stats.queries).padEnd(35)}║`)
    log(`║  Context hits:        ${String(stats.hits).padEnd(30)}(${hitRate}%) ║`)
    log(`║  Chars stored:        ${String(stats.charsStored).padEnd(35)}║`)
    log(`║  Chars returned:      ${String(stats.charsReturned).padEnd(35)}║`)
    log("╚═══════════════════════════════════════════════════════════╝")
}

// ── Types ────────────────────────────────────────────────────

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "LSP"])

interface PendingCall {
    agentId: string
    tool: string
    args: Record<string, unknown>
}

export interface MemoryLibrarianOptions {
    disabled?: boolean
    minSimilarity?: number
    maxInjectedChars?: number
    /**
     * Session path for persisting memory to disk.
     * When set, the memory store writes JSON files here so the CLI
     * and orchestrator can share state across processes.
     * Typically: ~/.baro/sessions/<session-id>/memory
     */
    sessionPath?: string
}

// ── Implementation ───────────────────────────────────────────

export class MemoryLibrarian extends BaseObserver {
    private readonly opts: Required<MemoryLibrarianOptions>
    private readonly pending = new Map<string, PendingCall>()
    private readonly inFlight = new Set<string>()
    private store: any = null
    private initPromise: Promise<void> | null = null

    constructor(opts: MemoryLibrarianOptions = {}) {
        super()
        this.opts = {
            disabled: opts.disabled ?? false,
            minSimilarity: opts.minSimilarity ?? 0.3,
            maxInjectedChars: opts.maxInjectedChars ?? 20000,
            sessionPath: opts.sessionPath ?? '',
        }
        if (this.opts.sessionPath) {
            log(`MemoryLibrarian initialized with sessionPath: ${this.opts.sessionPath}`)
        } else {
            log("MemoryLibrarian initialized (in-memory only, no shared path)")
        }
    }

    private async ensureStore(): Promise<any> {
        if (this.opts.disabled) return null
        if (!this.store && !this.initPromise) {
            this.initPromise = (async () => {
                try {
                    log("Loading memory store...")
                    const start = Date.now()
                    const { createMemoryStore } = await import("@baro/memory")
                    this.store = await createMemoryStore({
                        defaultMinSimilarity: this.opts.minSimilarity,
                        sessionPath: this.opts.sessionPath || undefined,
                    })
                    log(`Memory store ready in ${Date.now() - start}ms`)
                } catch (err) {
                    log(`Memory store failed: ${err}`)
                    this.store = null
                }
            })()
        }
        await this.initPromise
        return this.store
    }

    // ── Called at story launch ────────────────────────────────

    /**
     * Semantic search for relevant context from other agents.
     * Called by Conductor's onBeforeStoryLaunch hook.
     * Returns context + instructions that survive compaction.
     */
    async gatherContext(storyId: string, hints: readonly string[] = []): Promise<string | null> {
        const store = await this.ensureStore()
        if (!store) return null

        stats.queries++
        const storeStats = await store.getStats()

        log(`gatherContext(${storyId}): ${storeStats.totalFindings} findings, ${storeStats.cachedFiles} cached files`)

        // Get relevant context via semantic search (may be empty if no findings yet)
        let context: string | null = null
        if (storeStats.totalFindings > 0) {
            context = await store.gatherContext(storyId, [...hints], this.opts.maxInjectedChars)
        }

        // Get list of cached files
        const cachedPaths = await store.getCachedPaths()

        // ALWAYS inject CLI instructions so agents can query mid-flight,
        // even when no findings exist yet (other agents will store findings
        // as they work, and this agent can query them dynamically).
        const parts: string[] = []

        // Memory instructions (survive compaction)
        parts.push("## Shared Memory System (from parallel agents)")
        parts.push("")
        parts.push("This project uses a shared memory system. Other agents have")
        parts.push("already explored the codebase. Use these commands via Bash:")
        parts.push("")
        parts.push("	# Find relevant context from other agents")
        parts.push("	node ~/.baro/bin/baro-memory.mjs query \"JWT authentication\"")
        parts.push("")
        parts.push("	# List files already read by other agents")
        parts.push("	node ~/.baro/bin/baro-memory.mjs cache list")
        parts.push("")
        parts.push("	# Get cached file content (no disk read needed)")
        parts.push("	node ~/.baro/bin/baro-memory.mjs cache get src/auth.ts")
        parts.push("")
        parts.push("	# Store a finding for other agents")
        parts.push("	node ~/.baro/bin/baro-memory.mjs store \"found X\" --tool Read --file src/foo.ts")
        parts.push("")
        parts.push("IMPORTANT: Check cached files BEFORE reading from disk.")
        parts.push("If a file is cached, use `baro-memory cache get` instead of Read.")
        parts.push("")

        // List cached files
        if (cachedPaths.length > 0) {
            parts.push("### Cached files (already read by other agents):")
            for (const p of cachedPaths.slice(0, 20)) {
                parts.push(`- ${p}`)
            }
            if (cachedPaths.length > 20) {
                parts.push(`- ... and ${cachedPaths.length - 20} more`)
            }
            parts.push("")
        }

        // Add relevant context
        if (context) {
            stats.hits++
            stats.charsReturned += context.length
            parts.push("### Relevant discoveries from other agents:")
            parts.push(context)
        }

        const result = parts.join("\n")
        const lines = result.split("\n").length
        log(`gatherContext(${storyId}): ✓ ${lines} lines, ${result.length} chars, ${cachedPaths.length} cached files`)

        return result
    }

    // ── Bus observers: store findings ─────────────────────────

    override async onExternalFunctionCall(source: Participant, item: FunctionCallItem): Promise<void> {
        if (!EXPLORATION_TOOLS.has(item.name)) return
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(item.args) } catch {}
        this.pending.set(item.callId, { agentId, tool: item.name, args })
    }

    override async onExternalFunctionCallOutput(source: Participant, item: FunctionCallOutputItem): Promise<void> {
        const json = item.toJSON() as { call_id: string; output: Array<{ text: string }> }
        const pending = this.pending.get(json.call_id)
        if (!pending) return
        this.pending.delete(json.call_id)

        const store = await this.ensureStore()
        if (!store) return

        const content = json.output.map(b => b.text).join("\n")
        const filePath = pending.tool === "Read" ? (pending.args.file_path ?? pending.args.path) as string : undefined

        // Cache file reads
        if (pending.tool === "Read" && filePath) {
            await store.cacheFile(filePath, content, pending.agentId)
            stats.cached++
            log(`CACHED: ${filePath} (${content.length} chars)`)
        }

        // Store finding for semantic search
        await store.remember({
            tool: pending.tool,
            agentId: pending.agentId,
            content: content.slice(0, 4000),
            filePath,
            pattern: pending.tool === "Grep" ? pending.args.pattern as string : undefined,
        })
        stats.stored++
        stats.charsStored += Math.min(content.length, 4000)
        log(`STORED: ${pending.tool} ${filePath || ""} from ${pending.agentId}`)

        // Emit Knowledge event
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, Knowledge.create({
                sourceAgentId: pending.agentId,
                tags: [pending.tool.toLowerCase()],
                summary: `${pending.tool} ${filePath || ""}`,
                content: content.slice(0, 1000),
                tool: pending.tool,
            }))
        }
    }

    override async onExternalEvent(_source: Participant, event: SemanticEvent<unknown>): Promise<void> {
        if (StorySpawned.is(event)) {
            this.inFlight.add(event.data.storyId)
            log(`Story ${event.data.storyId} started (${this.inFlight.size} active)`)
            return
        }
        if (StoryResult.is(event)) {
            this.inFlight.delete(event.data.storyId)
            log(`Story ${event.data.storyId} done (${this.inFlight.size} active)`)
            if (this.inFlight.size === 0) logStats()
        }
    }
}
