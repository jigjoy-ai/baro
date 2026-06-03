/**
 * @baro/memory - Vectra-backed semantic memory for baro agents.
 *
 * Purpose: Share context between parallel agents within a single baro session.
 * Uses Vectra (local vector DB) for persistent disk-backed similarity search
 * and @xenova/transformers for CPU-only ONNX embeddings.
 *
 * @example
 * ```typescript
 * import { createMemoryStore } from '@baro/memory'
 *
 * // Create store with shared session path (for cross-process access)
 * const store = await createMemoryStore({
 *     sessionPath: '~/.baro/sessions/run-123/memory',
 * })
 *
 * // Agent 1 discovers something
 * await store.remember({
 *     tool: 'Read',
 *     agentId: 'story-1',
 *     content: 'JWT validation uses jsonwebtoken with 15-min expiry',
 *     filePath: 'src/auth/jwt.ts',
 * })
 *
 * // Agent 2 (separate process) queries the same store
 * const results = await store.recall('JWT authentication', {
 *     excludeAgent: 'story-2',
 * })
 *
 * // Or get formatted context for prompt injection
 * const context = await store.gatherContext('story-2', ['auth', 'JWT'])
 * // → "Other agents discovered: [story-1] Read src/auth/jwt.ts..."
 * ```
 *
 * @module @baro/memory
 */

export { createMemoryStore } from './vectra-store.js'
export type {
    CachedFile,
    Finding,
    FindingMetadata,
    MemoryStore,
    MemoryStats,
    MemoryStoreConfig,
    RecalledFinding,
    RecallOptions,
} from './types.js'
