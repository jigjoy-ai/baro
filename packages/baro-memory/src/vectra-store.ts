// Cross-process sharing: Vectra reads/writes index.json on every operation,
// so the orchestrator's writes are immediately visible to CLI invocations.
// IDs are deterministic (agent:tool:file/pattern/command), so repeated reads
// of the same file by the same agent upsert rather than duplicate.

import { LocalIndex } from 'vectra'
import type { QueryResult } from 'vectra'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync, statSync, lstatSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

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

const MAX_CONTENT_CHARS = 4000
const MAX_CACHE_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_CACHE_BYTES = 50 * 1024 * 1024
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const ALLOWED_SESSION_PARENTS = ['.baro', 'baro-memory', 'tmp']

const DEFAULTS = {
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    defaultMinSimilarity: 0.3,
    defaultMaxResults: 10,
    disabled: false,
    sessionPath: '',
} satisfies Required<MemoryStoreConfig>

type EmbeddingPipeline = (
    text: string,
    opts: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>

interface VectraItemMetadata {
    [key: string]: string  // Index signature for Vectra compatibility
    tool: string
    agentId: string
    storyId: string
    filePath: string
    pattern: string
    command: string
    tags: string
    content: string
}

/**
 * Create a Vectra-backed memory store. Without `sessionPath` the index lives
 * in a temp dir (ephemeral, single-process); `disabled` returns a no-op store.
 */
export async function createMemoryStore(
    config?: MemoryStoreConfig,
): Promise<MemoryStore> {
    const cfg = { ...DEFAULTS, ...config }

    if (cfg.defaultMinSimilarity < 0 || cfg.defaultMinSimilarity > 1) {
        cfg.defaultMinSimilarity = DEFAULTS.defaultMinSimilarity
    }
    if (cfg.defaultMaxResults < 1) {
        cfg.defaultMaxResults = DEFAULTS.defaultMaxResults
    }

    if (cfg.disabled) {
        return new NoOpMemoryStore()
    }

    const sessionPath = cfg.sessionPath || join(tmpdir(), `baro-memory-${process.pid}-${Date.now()}`)
    validateSessionPath(sessionPath)
    mkdirSync(sessionPath, { recursive: true })

    const indexPath = join(sessionPath, 'index')
    mkdirSync(indexPath, { recursive: true })
    const index = new LocalIndex<VectraItemMetadata>(indexPath)

    if (!(await index.isIndexCreated())) {
        await index.createIndex({ version: 1 })
    }

    // Pin the transformers.js model cache to a writable persistent dir: the
    // default node_modules/@xenova/transformers/.cache can be read-only on a
    // global install, and ~/.baro/models survives so MiniLM downloads once.
    const transformers = await import('@xenova/transformers')
    transformers.env.cacheDir = process.env.TRANSFORMERS_CACHE || join(homedir(), '.baro', 'models')
    const { pipeline } = transformers
    const extractor = await pipeline('feature-extraction', cfg.embeddingModel) as unknown as EmbeddingPipeline

    return new VectraMemoryStore(index, extractor, sessionPath, cfg)
}

/** Prevents path traversal / sensitive-dir writes via BARO_MEMORY_PATH. */
function validateSessionPath(sessionPath: string): void {
    const resolved = join(sessionPath) // normalize
    if (resolved.includes('..')) {
        throw new Error(`Invalid session path (contains ..): ${resolved}`)
    }
    const dangerous = ['/etc', '/usr', '/bin', '/sbin', '/var/run', '/System', '/Library']
    for (const d of dangerous) {
        if (resolved.startsWith(d + '/') || resolved === d) {
            throw new Error(`Invalid session path (sensitive directory): ${resolved}`)
        }
    }
    const normalizedPath = resolved.toLowerCase()
    const isSafe = ALLOWED_SESSION_PARENTS.some(p => normalizedPath.includes(p)) ||
        normalizedPath.startsWith(tmpdir().toLowerCase())
    if (!isSafe) {
        throw new Error(
            `Invalid session path (must be under ~/.baro, tmpdir, or contain 'baro-memory'): ${resolved}`
        )
    }
}

/**
 * Prune session dirs older than SESSION_TTL_MS; call on orchestrator startup.
 * lstatSync avoids following symlinks (symlink attack).
 */
export function pruneOldSessions(sessionsDir: string): void {
    try {
        if (!existsSync(sessionsDir)) return
        const now = Date.now()
        for (const entry of readdirSync(sessionsDir)) {
            if (!entry.startsWith('run-')) continue
            const entryPath = join(sessionsDir, entry)
            try {
                const stat = lstatSync(entryPath)
                if (stat.isSymbolicLink()) continue
                if (stat.isDirectory() && now - stat.mtimeMs > SESSION_TTL_MS) {
                    rmSync(entryPath, { recursive: true, force: true })
                }
            } catch { /* skip entries we can't stat */ }
        }
    } catch { /* non-critical — don't crash if cleanup fails */ }
}

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

class VectraMemoryStore implements MemoryStore {
    // Not readonly: the reader re-instantiates the index to pick up writes
    // made by other processes (see refreshIndexIfChanged).
    private index: LocalIndex<VectraItemMetadata>
    private readonly extractor: EmbeddingPipeline
    private readonly sessionPath: string
    private readonly indexPath: string
    private readonly indexFilePath: string
    /** mtimeMs of index.json last time we (re)loaded; -1 = never seen. */
    private lastIndexMtimeMs = -1
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
        this.indexPath = join(sessionPath, 'index')
        // Vectra persists the index to <folder>/index.json.
        this.indexFilePath = join(this.indexPath, 'index.json')
        this.cachePath = join(sessionPath, 'cache.json')
        this.lockPath = join(sessionPath, 'cache.lock')
        this.config = config
    }

    /**
     * Vectra's LocalIndex caches index.json in memory and never reloads, so
     * writes from other processes stay invisible to this long-lived reader
     * (issue #51). No public reload exists — on mtime change we swap in a
     * fresh LocalIndex. Read paths only: writers refresh via beginUpdate, and
     * reloading mid-write could clobber a pending batch. Never throws.
     */
    private refreshIndexIfChanged(): void {
        try {
            if (!existsSync(this.indexFilePath)) return
            const mtimeMs = statSync(this.indexFilePath).mtimeMs
            if (mtimeMs === this.lastIndexMtimeMs) return
            // Instantiate BEFORE advancing the mtime watermark: if this throws
            // we keep the old index AND old mtime, so the next call retries.
            const newIndex = new LocalIndex<VectraItemMetadata>(this.indexPath)
            this.lastIndexMtimeMs = mtimeMs
            this.index = newIndex
        } catch {
            // Keep the existing index on any error.
        }
    }

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
            // Never crash the agent if embedding/storage fails
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

            this.refreshIndexIfChanged()

            const vector = await embed(this.extractor, query)

            // Query more than needed so we can post-filter
            const fetchK = Math.min(Math.max(maxResults * 3, 30), 200)
            const results: QueryResult<VectraItemMetadata>[] = await this.index.queryItems(vector, fetchK)

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
            // Never crash the agent: return empty on failure
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

    // File cache is a plain JSON file (exact-path lookup, not vectorized).
    // Multi-process writes are merge-on-write best-effort — not ACID.

    async cacheFile(path: string, content: string, agentId: string): Promise<void> {
        if (content.length > MAX_CACHE_FILE_BYTES) return

        // Merge-on-write: reload fresh state before modifying (reduces race window)
        const cache = this.loadCache()
        const existing = cache[path]
        if (!existing || existing.content !== content) {
            cache[path] = { path, content, readByAgent: agentId, timestamp: Date.now() }
            this.evictIfNeeded(cache)
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

    async getStats(): Promise<MemoryStats> {
        try {
            this.refreshIndexIfChanged()
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
        } catch {
            return {
                totalFindings: 0, uniqueTools: 0, uniqueAgents: 0,
                toolsList: [], agentsList: [], cachedFiles: 0, cacheSizeBytes: 0,
            }
        }
    }

    async close(): Promise<void> {
        // Vectra auto-persists; clean up lockfile if present
        try { rmSync(this.lockPath, { force: true }) } catch {}
    }

    private evictIfNeeded(cache: Record<string, CachedFile>): void {
        let totalBytes = 0
        for (const entry of Object.values(cache)) {
            totalBytes += entry.content.length
        }
        if (totalBytes <= MAX_TOTAL_CACHE_BYTES) return

        const entries = Object.entries(cache).sort((a, b) => a[1].timestamp - b[1].timestamp)
        for (const [key, entry] of entries) {
            if (totalBytes <= MAX_TOTAL_CACHE_BYTES) break
            totalBytes -= entry.content.length
            delete cache[key]
        }
    }

    private generateId(finding: Finding): string {
        const parts = [finding.agentId, finding.tool]
        if (finding.filePath) parts.push(finding.filePath)
        else if (finding.pattern) parts.push(finding.pattern)
        else if (finding.command) parts.push(finding.command)
        else {
            // For generic findings (no file/pattern/command), use a short
            // content hash to maintain deterministic dedup while avoiding
            // collisions. Same content = same ID = upsert (not duplicate).
            let hash = 0
            const str = finding.content.slice(0, 100)
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
            }
            parts.push(Math.abs(hash).toString(36))
        }
        return parts.join(':')
    }

    /**
     * Reads are not locked: the atomic-rename write strategy means we see
     * either the old or new complete version, never a partial write.
     */
    private loadCache(): Record<string, CachedFile> {
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
     * Write to a PID-scoped tmp file then rename — atomic on POSIX, so
     * concurrent readers never see a partial write.
     */
    private saveCache(cache: Record<string, CachedFile>): void {
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
