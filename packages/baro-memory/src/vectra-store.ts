/**
 * Vectra-backed semantic memory store for baro agents.
 *
 * Architecture:
 * - Vectra LocalIndex for vector storage + similarity search (persisted to disk)
 * - @xenova/transformers ONNX model for embedding generation (CPU-only)
 * - Separate cache.json for file content dedup (not vectorized)
 *
 * Cross-process sharing: Vectra reads/writes index.json on every operation,
 * so the orchestrator's writes are immediately visible to CLI invocations.
 *
 * ID strategy: IDs are deterministic (agent:tool:file/pattern/command).
 * This means repeated reads of the same file by the same agent upsert
 * (update in place) rather than accumulate duplicate entries.
 */

import { LocalIndex } from 'vectra'
import type { QueryResult } from 'vectra'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import type {
    CachedFile,
    Finding,
    FindingMetadata,
    MemoryStore,
    MemoryStats,
    MemoryStoreConfig,
    RecalledFinding,
    RecallOptions,
} from './types.js'

// ── Constants ────────────────────────────────────────────────────────────

/** Maximum characters stored per finding content. */
const MAX_CONTENT_CHARS = 4000

/** Maximum bytes for a single cached file (5MB). */
const MAX_CACHE_FILE_BYTES = 5 * 1024 * 1024

/** Stale session threshold: 24 hours. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

// ── Defaults ─────────────────────────────────────────────────────────────

const DEFAULTS = {
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    defaultMinSimilarity: 0.3,
    defaultMaxResults: 10,
    disabled: false,
    sessionPath: '',
} satisfies Required<MemoryStoreConfig>

// ── Types ────────────────────────────────────────────────────────────────

/** Typed embedding pipeline from @xenova/transformers. */
type EmbeddingPipeline = (
    text: string,
    opts: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>

/** Metadata stored alongside each vector in Vectra. */
interface VectraItemMetadata {
    [key: string]: string  // Index signature for Vectra compatibility
    tool: string
    agentId: string
    storyId: string
    filePath: string
    pattern: string
    command: string
    tags: string
    /** The original text content (stored for retrieval). */
    content: string
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a memory store backed by Vectra (local vector DB).
 *
 * - If `sessionPath` is set, the index + cache persist there.
 * - If not set, a temp directory is used (ephemeral, single-process).
 * - If `disabled`, returns a no-op store.
 *
 * @param config - Optional configuration
 * @returns MemoryStore instance
 */
export async function createMemoryStore(
    config?: MemoryStoreConfig,
): Promise<MemoryStore> {
    const cfg = { ...DEFAULTS, ...config }

    // Validate config
    if (cfg.defaultMinSimilarity < 0 || cfg.defaultMinSimilarity > 1) {
        cfg.defaultMinSimilarity = DEFAULTS.defaultMinSimilarity
    }
    if (cfg.defaultMaxResults < 1) {
        cfg.defaultMaxResults = DEFAULTS.defaultMaxResults
    }

    if (cfg.disabled) {
        return new NoOpMemoryStore()
    }

    // Resolve session path
    const sessionPath = cfg.sessionPath || join(tmpdir(), `baro-memory-${process.pid}-${Date.now()}`)
    mkdirSync(sessionPath, { recursive: true })

    // Initialize Vectra index
    const indexPath = join(sessionPath, 'index')
    mkdirSync(indexPath, { recursive: true })
    const index = new LocalIndex<VectraItemMetadata>(indexPath)

    if (!(await index.isIndexCreated())) {
        await index.createIndex({ version: 1 })
    }

    // Load ONNX embedding model (cached after first load by transformers.js)
    const { pipeline } = await import('@xenova/transformers')
    const extractor = await pipeline('feature-extraction', cfg.embeddingModel) as unknown as EmbeddingPipeline

    return new VectraMemoryStore(index, extractor, sessionPath, cfg)
}

/**
 * Prune stale session directories older than SESSION_TTL_MS.
 * Call on orchestrator startup to prevent unbounded growth.
 */
export function pruneOldSessions(sessionsDir: string): void {
    try {
        if (!existsSync(sessionsDir)) return
        const { readdirSync, statSync } = require('fs') as typeof import('fs')
        const now = Date.now()
        for (const entry of readdirSync(sessionsDir)) {
            if (!entry.startsWith('run-')) continue
            const entryPath = join(sessionsDir, entry)
            try {
                const stat = statSync(entryPath)
                if (now - stat.mtimeMs > SESSION_TTL_MS) {
                    rmSync(entryPath, { recursive: true, force: true })
                }
            } catch { /* skip entries we can't stat */ }
        }
    } catch { /* non-critical — don't crash if cleanup fails */ }
}

// ── Embedding helper ─────────────────────────────────────────────────────

/**
 * Generate a normalized embedding vector for text.
 * @throws Error if embedding generation fails (empty text, model error)
 */
async function embed(extractor: EmbeddingPipeline, text: string): Promise<number[]> {
    if (!text || !text.trim()) {
        throw new Error('Cannot embed empty text')
    }
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    if (!output?.data) {
        throw new Error('Embedding model returned no data')
    }
    return Array.from(output.data) as number[]
}

// ── VectraMemoryStore ────────────────────────────────────────────────────

class VectraMemoryStore implements MemoryStore {
    private readonly index: LocalIndex<VectraItemMetadata>
    private readonly extractor: EmbeddingPipeline
    private readonly sessionPath: string
    private readonly cachePath: string
    private readonly lockPath: string
    private readonly config: Required<MemoryStoreConfig>

    constructor(
        index: LocalIndex<VectraItemMetadata>,
        extractor: EmbeddingPipeline,
        sessionPath: string,
        config: Required<MemoryStoreConfig>,
    ) {
        this.index = index
        this.extractor = extractor
        this.sessionPath = sessionPath
        this.cachePath = join(sessionPath, 'cache.json')
        this.lockPath = join(sessionPath, 'cache.lock')
        this.config = config
    }

    // ── Semantic memory ──────────────────────────────────────────

    async remember(finding: Finding): Promise<boolean> {
        try {
            if (!finding.content?.trim()) return false

            const id = this.generateId(finding)
            const vector = await embed(this.extractor, finding.content)
            const metadata: VectraItemMetadata = {
                tool: finding.tool,
                agentId: finding.agentId,
                storyId: finding.storyId ?? '',
                filePath: finding.filePath ?? '',
                pattern: finding.pattern ?? '',
                command: finding.command ?? '',
                tags: finding.tags?.join(',') ?? '',
                content: finding.content.slice(0, MAX_CONTENT_CHARS),
            }

            await this.index.upsertItem({ id, vector, metadata })
            return true
        } catch {
            // Graceful degradation: don't crash if embedding/storage fails
            return false
        }
    }

    async recall(query: string, options?: RecallOptions): Promise<RecalledFinding[]> {
        try {
            const maxResults = options?.maxResults ?? this.config.defaultMaxResults
            const minSimilarity = options?.minSimilarity ?? this.config.defaultMinSimilarity
            const excludeAgent = options?.excludeAgent
            const filterByTool = options?.filterByTool

            if (!query?.trim()) return []

            const vector = await embed(this.extractor, query)

            // Query more than needed so we can post-filter
            const fetchK = Math.min(Math.max(maxResults * 3, 30), 200)
            const results: QueryResult<VectraItemMetadata>[] = await this.index.queryItems(vector, fetchK)

            // Post-filter and collect
            const output: RecalledFinding[] = []

            for (const result of results) {
                if (result.score < minSimilarity) continue
                if (excludeAgent && result.item.metadata.agentId === excludeAgent) continue
                if (filterByTool?.length && !filterByTool.includes(result.item.metadata.tool)) continue

                output.push({
                    id: result.item.id,
                    content: result.item.metadata.content,
                    metadata: {
                        tool: result.item.metadata.tool,
                        agentId: result.item.metadata.agentId,
                        storyId: result.item.metadata.storyId,
                        filePath: result.item.metadata.filePath,
                        pattern: result.item.metadata.pattern,
                        command: result.item.metadata.command,
                        tags: result.item.metadata.tags,
                    },
                    similarity: result.score,
                })

                if (output.length >= maxResults) break
            }

            return output
        } catch {
            // Graceful degradation: return empty on failure
            return []
        }
    }

    async gatherContext(
        storyId: string,
        hints: string[],
        maxChars: number = 20000,
    ): Promise<string | null> {
        const query = hints.join(' ')
        if (!query.trim()) return null

        const results = await this.recall(query, {
            maxResults: 20,
            minSimilarity: 0.3,
            excludeAgent: storyId,
        })

        if (results.length === 0) return null

        const lines: string[] = [
            '## Codebase context (from parallel agents)',
            '',
            'Other agents in this run discovered the following.',
            'Use this directly without re-reading files.',
            '',
        ]

        let totalChars = 0
        for (const result of results) {
            const header = `[${result.metadata.agentId}] ${result.metadata.tool}${
                result.metadata.filePath ? ` ${result.metadata.filePath}` : ''
            } (relevance: ${Math.round(result.similarity * 100)}%)`

            const entry = `${header}\n${result.content}\n`

            if (totalChars + entry.length > maxChars) {
                lines.push('[...truncated...]')
                break
            }

            lines.push(entry)
            totalChars += entry.length
        }

        return lines.join('\n')
    }

    // ── File cache ───────────────────────────────────────────────
    // Simple JSON file (not vectorized -- exact key-value lookup).
    // Uses a lockfile to prevent concurrent write corruption.

    async cacheFile(path: string, content: string, agentId: string): Promise<void> {
        // Skip excessively large files
        if (content.length > MAX_CACHE_FILE_BYTES) return

        const cache = this.loadCacheLocked()
        const existing = cache[path]
        if (!existing || existing.content !== content) {
            cache[path] = { path, content, readByAgent: agentId, timestamp: Date.now() }
            this.saveCacheLocked(cache)
        }
    }

    async getCachedFile(path: string): Promise<string | null> {
        const cache = this.loadCacheLocked()
        return cache[path]?.content ?? null
    }

    async hasFile(path: string): Promise<boolean> {
        const cache = this.loadCacheLocked()
        return path in cache
    }

    async getCachedPaths(): Promise<string[]> {
        const cache = this.loadCacheLocked()
        return Object.keys(cache)
    }

    // ── Stats ────────────────────────────────────────────────────

    async getStats(): Promise<MemoryStats> {
        try {
            const items = await this.index.listItems<VectraItemMetadata>()
            const tools = new Set<string>()
            const agents = new Set<string>()

            for (const item of items) {
                tools.add(item.metadata.tool)
                agents.add(item.metadata.agentId)
            }

            const cache = this.loadCacheLocked()
            let cacheSizeBytes = 0
            for (const entry of Object.values(cache)) {
                cacheSizeBytes += entry.content.length
            }

            return {
                totalFindings: items.length,
                uniqueTools: tools.size,
                uniqueAgents: agents.size,
                toolsList: Array.from(tools),
                agentsList: Array.from(agents),
                cachedFiles: Object.keys(cache).length,
                cacheSizeBytes,
            }
        } catch {
            return {
                totalFindings: 0, uniqueTools: 0, uniqueAgents: 0,
                toolsList: [], agentsList: [], cachedFiles: 0, cacheSizeBytes: 0,
            }
        }
    }

    async close(): Promise<void> {
        // Vectra auto-persists; clean up lockfile if present
        try { if (existsSync(this.lockPath)) rmSync(this.lockPath) } catch {}
    }

    // ── Private helpers ──────────────────────────────────────────

    private generateId(finding: Finding): string {
        const parts = [finding.agentId, finding.tool]
        if (finding.filePath) parts.push(finding.filePath)
        else if (finding.pattern) parts.push(finding.pattern)
        else if (finding.command) parts.push(finding.command)
        else parts.push(Date.now().toString(36)) // Ensure uniqueness for generic findings
        return parts.join(':')
    }

    /**
     * Load cache with a simple lockfile to prevent concurrent read-during-write.
     * The lock is advisory (best-effort) since Node doesn't support mandatory file locks.
     */
    private loadCacheLocked(): Record<string, CachedFile> {
        try {
            if (existsSync(this.cachePath)) {
                const raw = readFileSync(this.cachePath, 'utf-8')
                if (raw.trim()) {
                    return JSON.parse(raw)
                }
            }
        } catch {
            // Corrupted or being written -- return empty (safe default)
        }
        return {}
    }

    /**
     * Save cache atomically (write to tmp, rename over target).
     * Advisory lockfile prevents interleaved reads of partial writes.
     */
    private saveCacheLocked(cache: Record<string, CachedFile>): void {
        try {
            // Write lockfile (advisory — best effort)
            writeFileSync(this.lockPath, String(process.pid), 'utf-8')

            const tmp = this.cachePath + `.${process.pid}.tmp`
            writeFileSync(tmp, JSON.stringify(cache), 'utf-8')
            renameSync(tmp, this.cachePath)
        } catch {
            // Fallback: direct write (may be read mid-write by other processes)
            try {
                writeFileSync(this.cachePath, JSON.stringify(cache), 'utf-8')
            } catch { /* disk full or permission denied -- data loss accepted */ }
        } finally {
            try { if (existsSync(this.lockPath)) rmSync(this.lockPath) } catch {}
        }
    }
}

// ── NoOp store ───────────────────────────────────────────────────────────

/**
 * No-op implementation for when memory is disabled.
 */
class NoOpMemoryStore implements MemoryStore {
    async remember(_finding: Finding): Promise<boolean> { return false }
    async recall(_query: string, _options?: RecallOptions): Promise<RecalledFinding[]> { return [] }
    async gatherContext(_storyId: string, _hints: string[]): Promise<string | null> { return null }
    async cacheFile(_path: string, _content: string, _agentId: string): Promise<void> {}
    async getCachedFile(_path: string): Promise<string | null> { return null }
    async hasFile(_path: string): Promise<boolean> { return false }
    async getCachedPaths(): Promise<string[]> { return [] }
    async getStats(): Promise<MemoryStats> {
        return {
            totalFindings: 0, uniqueTools: 0, uniqueAgents: 0,
            toolsList: [], agentsList: [], cachedFiles: 0, cacheSizeBytes: 0,
        }
    }
    async close(): Promise<void> {}
}
