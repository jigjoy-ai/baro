// Types for @baro/memory. Findings persist to disk via Vectra LocalIndex so
// multiple processes (orchestrator + CLI invocations from story agents) can
// share one memory per session.

export interface Finding {
    tool: string
    agentId: string
    content: string
    filePath?: string
    pattern?: string
    command?: string
    storyId?: string
    tags?: string[]
}

export interface CachedFile {
    path: string
    content: string
    readByAgent: string
    timestamp: number
}

export interface RecallOptions {
    maxResults?: number
    minSimilarity?: number
    /** Exclude findings from this agent (avoid self-context). */
    excludeAgent?: string
    filterByTool?: string[]
}

export interface RecalledFinding {
    id: string
    content: string
    metadata: FindingMetadata
    similarity: number
}

export interface FindingMetadata {
    tool: string
    agentId: string
    storyId: string
    filePath: string
    pattern: string
    command: string
    tags: string
}

export interface MemoryStats {
    totalFindings: number
    uniqueTools: number
    uniqueAgents: number
    toolsList: string[]
    agentsList: string[]
    cachedFiles: number
    cacheSizeBytes: number
}

export interface MemoryStoreConfig {
    embeddingModel?: string
    defaultMinSimilarity?: number
    defaultMaxResults?: number
    disabled?: boolean
    /**
     * Directory persisting the Vectra index + cache.json across processes —
     * REQUIRED for orchestrator + CLI to share memory (typically
     * ~/.baro/sessions/run-<ts>/memory). Unset = temp dir, single-process.
     */
    sessionPath?: string
}

export interface MemoryStore {
    /**
     * Store a finding (embedded + persisted immediately).
     * @returns false if disabled or storage failed
     */
    remember(finding: Finding): Promise<boolean>

    /**
     * Semantic search across stored findings.
     * Reads the latest state from disk (sees writes from other processes).
     */
    recall(query: string, options?: RecallOptions): Promise<RecalledFinding[]>

    /** Recall + format for injection into a story agent's prompt. */
    gatherContext(storyId: string, hints: string[], maxChars?: number): Promise<string | null>

    cacheFile(path: string, content: string, agentId: string): Promise<void>

    getCachedFile(path: string): Promise<string | null>

    hasFile(path: string): Promise<boolean>

    getCachedPaths(): Promise<string[]>

    getStats(): Promise<MemoryStats>

    close(): Promise<void>
}
