/**
 * @baro/memory — Vectra-backed semantic memory shared between parallel baro
 * agents (disk-persisted LocalIndex for cross-process access; CPU-only ONNX
 * embeddings via @xenova/transformers).
 */

export { createMemoryStore, pruneOldSessions } from './vectra-store.js'
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
