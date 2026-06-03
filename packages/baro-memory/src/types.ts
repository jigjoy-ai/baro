/**
 * Types for @baro/memory - Vectra-backed semantic memory for baro agents.
 *
 * Purpose: Share context between parallel agents within a single baro session.
 * Persisted to disk via Vectra LocalIndex so multiple processes (orchestrator
 * + CLI invocations from story agents) can share the same memory.
 *
 * Token savings via:
 * 1. Semantic search for relevant context (avoid blind re-exploration)
 * 2. File content cache (avoid redundant file reads)
 */

/**
 * A piece of knowledge discovered by a baro agent.
 */
export interface Finding {
    /** Tool that discovered this (Read, Grep, Bash, etc.) */
    tool: string
    /** Agent that discovered this (story-1, story-2, etc.) */
    agentId: string
    /** The actual content to store */
    content: string
    /** File path (for Read tool) */
    filePath?: string
    /** Search pattern (for Grep tool) */
    pattern?: string
    /** Command (for Bash tool) */
    command?: string
    /** Story ID that discovered this */
    storyId?: string
    /** Tags for categorization */
    tags?: string[]
}

/**
 * Cached file content (for avoiding redundant reads).
 */
export interface CachedFile {
    /** File path */
    path: string
    /** File content */
    content: string
    /** Which agent first read this */
    readByAgent: string
    /** When it was read */
    timestamp: number
}

/**
 * Options for semantic recall queries.
 */
export interface RecallOptions {
    /** Maximum results to return (default: 10) */
    maxResults?: number
    /** Minimum similarity threshold 0-1 (default: 0.3) */
    minSimilarity?: number
    /** Exclude findings from this agent (avoid self-context) */
    excludeAgent?: string
    /** Filter by tool types */
    filterByTool?: string[]
}

/**
 * A recalled finding with similarity score.
 */
export interface RecalledFinding {
    /** Unique ID */
    id: string
    /** The content */
    content: string
    /** Metadata */
    metadata: FindingMetadata
    /** Similarity score 0-1 */
    similarity: number
}

/**
 * Metadata stored with each finding in Vectra.
 */
export interface FindingMetadata {
    tool: string
    agentId: string
    storyId: string
    filePath: string
    pattern: string
    command: string
    tags: string
}

/**
 * Statistics about the memory store.
 */
export interface MemoryStats {
    /** Total number of findings stored */
    totalFindings: number
    /** Number of unique tools */
    uniqueTools: number
    /** Number of unique agents */
    uniqueAgents: number
    /** List of tools */
    toolsList: string[]
    /** List of agents */
    agentsList: string[]
    /** Number of cached files */
    cachedFiles: number
    /** Total bytes of cached file content */
    cacheSizeBytes: number
}

/**
 * Configuration for the memory store.
 */
export interface MemoryStoreConfig {
    /** Embedding model name (default: all-MiniLM-L6-v2) */
    embeddingModel?: string
    /** Default similarity threshold (default: 0.3) */
    defaultMinSimilarity?: number
    /** Default max results (default: 10) */
    defaultMaxResults?: number
    /** Disable memory (falls back to no-op) */
    disabled?: boolean
    /**
     * Path to a directory for persisting memory across processes.
     * Vectra LocalIndex files + cache.json are stored here.
     *
     * REQUIRED for cross-process sharing (orchestrator + CLI).
     * If not set, uses a temp directory (single-process only).
     *
     * Typically: ~/.baro/sessions/run-<timestamp>/memory
     */
    sessionPath?: string
}

/**
 * The memory store interface.
 *
 * Backed by Vectra (local vector DB) for semantic search and a JSON
 * file for the file content cache. Both persist to `sessionPath`.
 */
export interface MemoryStore {
    // ── Semantic memory ──────────────────────────────────────────

    /**
     * Store a finding with automatic embedding generation.
     * Persists immediately to the Vectra index on disk.
     * @returns true if stored successfully, false if disabled
     */
    remember(finding: Finding): Promise<boolean>

    /**
     * Semantic search across stored findings.
     * Reads the latest state from disk (sees writes from other processes).
     */
    recall(query: string, options?: RecallOptions): Promise<RecalledFinding[]>

    /**
     * Build context string for a story agent.
     * Combines recall + formatting for injection into prompts.
     */
    gatherContext(storyId: string, hints: string[], maxChars?: number): Promise<string | null>

    // ── File cache ───────────────────────────────────────────────

    /**
     * Cache a file's content (from Read tool).
     * If file already cached, updates only if content differs.
     */
    cacheFile(path: string, content: string, agentId: string): Promise<void>

    /**
     * Get cached file content.
     * @returns The cached content, or null if not cached.
     */
    getCachedFile(path: string): Promise<string | null>

    /**
     * Check if a file is cached.
     */
    hasFile(path: string): Promise<boolean>

    /**
     * Get all cached file paths (for diagnostics).
     */
    getCachedPaths(): Promise<string[]>

    // ── Stats ────────────────────────────────────────────────────

    /**
     * Get collection statistics.
     */
    getStats(): Promise<MemoryStats>

    /**
     * Close the store and release resources.
     */
    close(): Promise<void>
}
