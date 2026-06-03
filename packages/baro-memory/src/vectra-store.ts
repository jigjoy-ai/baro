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
 */

import { LocalIndex } from 'vectra'
import type { QueryResult } from 'vectra'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
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

// ── Defaults ─────────────────────────────────────────────────────────────

const DEFAULTS = {
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    defaultMinSimilarity: 0.3,
    defaultMaxResults: 10,
    disabled: false,
    sessionPath: '',
} satisfies Required<MemoryStoreConfig>

// ── Vectra metadata shape ────────────────────────────────────────────────

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

    if (cfg.disabled) {
        return new NoOpMemoryStore()
    }

    // Resolve session path
    const sessionPath = cfg.sessionPath || join(tmpdir(), `baro-memory-${process.pid}`)
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
    const extractor = await pipeline('feature-extraction', cfg.embeddingModel)

    return new VectraMemoryStore(index, extractor, sessionPath, cfg)
}

// ── Embedding helper ─────────────────────────────────────────────────────

/**
 * Generate a normalized embedding vector for text.
 */
async function embed(extractor: any, text: string): Promise<number[]> {
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data) as number[]
}

// ── VectraMemoryStore ────────────────────────────────────────────────────

class VectraMemoryStore implements MemoryStore {
    private readonly index: LocalIndex<VectraItemMetadata>
    private readonly extractor: any
    private readonly sessionPath: string
    private readonly cachePath: string
    private readonly config: Required<MemoryStoreConfig>

    constructor(
        index: LocalIndex<VectraItemMetadata>,
        extractor: any,
        sessionPath: string,
        config: Required<MemoryStoreConfig>,
    ) {
        this.index = index
        this.extractor = extractor
        this.sessionPath = sessionPath
        this.cachePath = join(sessionPath, 'cache.json')
        this.config = config
    }

    // ── Semantic memory ──────────────────────────────────────────

    async remember(finding: Finding): Promise<boolean> {
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
            content: finding.content.slice(0, 4000), // Cap stored content
        }

        await this.index.upsertItem({ id, vector, metadata })
        return true
    }

    async recall(query: string, options?: RecallOptions): Promise<RecalledFinding[]> {
        const maxResults = options?.maxResults ?? this.config.defaultMaxResults
        const minSimilarity = options?.minSimilarity ?? this.config.defaultMinSimilarity
        const excludeAgent = options?.excludeAgent
        const filterByTool = options?.filterByTool

        const vector = await embed(this.extractor, query)

        // Query more than needed so we can post-filter
        const fetchK = Math.max(maxResults * 3, 30)
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

    async cacheFile(path: string, content: string, agentId: string): Promise<void> {
        const cache = this.loadCache()
        const existing = cache[path]
        if (!existing || existing.content !== content) {
            cache[path] = { path, content, readByAgent: agentId, timestamp: Date.now() }
            this.saveCache(cache)
        }
    }

    async getCachedFile(path: string): Promise<string | null> {
        const cache = this.loadCache()
        return cache[path]?.content ?? null
    }

    async hasFile(path: string): Promise<boolean> {
        const cache = this.loadCache()
        return path in cache
    }

    async getCachedPaths(): Promise<string[]> {
        const cache = this.loadCache()
        return Object.keys(cache)
    }

    // ── Stats ────────────────────────────────────────────────────

    async getStats(): Promise<MemoryStats> {
        const items = await this.index.listItems<VectraItemMetadata>()
        const tools = new Set<string>()
        const agents = new Set<string>()

        for (const item of items) {
            tools.add(item.metadata.tool)
            agents.add(item.metadata.agentId)
        }

        const cache = this.loadCache()
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
    }

    async close(): Promise<void> {
        // Vectra auto-persists; nothing to close
    }

    // ── Private helpers ──────────────────────────────────────────

    private generateId(finding: Finding): string {
        const parts = [finding.agentId, finding.tool]
        if (finding.filePath) parts.push(finding.filePath)
        else if (finding.pattern) parts.push(finding.pattern)
        else if (finding.command) parts.push(finding.command)
        return parts.join(':')
    }

    private loadCache(): Record<string, CachedFile> {
        try {
            if (existsSync(this.cachePath)) {
                return JSON.parse(readFileSync(this.cachePath, 'utf-8'))
            }
        } catch {
            // Corrupted -- start fresh
        }
        return {}
    }

    private saveCache(cache: Record<string, CachedFile>): void {
        try {
            const tmp = this.cachePath + '.tmp'
            writeFileSync(tmp, JSON.stringify(cache), 'utf-8')
            renameSync(tmp, this.cachePath)
        } catch {
            try {
                writeFileSync(this.cachePath, JSON.stringify(cache), 'utf-8')
            } catch {}
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
