/**
 * baro-memory CLI - Query and store findings in the shared Vectra memory.
 *
 * Connects to the same Vectra index as the orchestrator via the
 * BARO_MEMORY_PATH environment variable. Story agents can use this
 * mid-flight to query context and store findings for sibling agents.
 *
 * Usage:
 *   baro-memory query "JWT authentication" [--top 5] [--agent story-1]
 *   baro-memory store "found auth pattern" --tool Read --file src/auth.ts --agent story-1
 *   baro-memory cache list
 *   baro-memory cache get src/auth.ts
 *   baro-memory stats
 *
 * Environment:
 *   BARO_MEMORY_PATH - Path to the shared session memory directory.
 *                      Set automatically by the baro orchestrator.
 */

import { createMemoryStore, type MemoryStore } from "@baro/memory"

const args = process.argv.slice(2)
const command = args[0]

function getFlag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`)
    if (idx < 0 || idx + 1 >= args.length) return undefined
    const value = args[idx + 1]
    // Don't treat the next flag as a value
    if (value.startsWith('--')) return undefined
    return value
}

function getPositionalArg(index: number): string | undefined {
    const val = args[index]
    if (!val || val.startsWith('--')) return undefined
    return val
}

async function main() {
    // Read session path from env (set by orchestrator) or --path flag
    const sessionPath = getFlag("path") || process.env.BARO_MEMORY_PATH

    if (!sessionPath) {
        console.error(
            "Error: No memory session path found.\n\n" +
            "Set BARO_MEMORY_PATH environment variable or pass --path <dir>.\n" +
            "This is normally set automatically by the baro orchestrator.\n"
        )
        process.exit(1)
    }

    let store: MemoryStore | null = null

    try {
        store = await createMemoryStore({ sessionPath })

        switch (command) {
            case "query": {
                const query = getPositionalArg(1)
                if (!query) {
                    console.error("Usage: baro-memory query <text> [--top N] [--agent id]")
                    process.exit(1)
                }
                const topRaw = getFlag("top")
                const top = topRaw ? parseInt(topRaw, 10) : 5
                if (isNaN(top) || top < 1) {
                    console.error("Error: --top must be a positive integer")
                    process.exit(1)
                }
                const agent = getFlag("agent")

                const results = await store.recall(query, {
                    maxResults: top,
                    minSimilarity: 0.3,
                    excludeAgent: agent,
                })

                if (results.length === 0) {
                    console.log("No relevant findings found.")
                } else {
                    console.log(`Found ${results.length} relevant findings:\n`)
                    for (const r of results) {
                        console.log(`[${r.metadata.tool}] ${r.metadata.agentId} (similarity: ${r.similarity.toFixed(2)})`)
                        if (r.metadata.filePath) console.log(`  File: ${r.metadata.filePath}`)
                        console.log(`  ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`)
                        console.log()
                    }
                }
                break
            }

            case "store": {
                const content = getPositionalArg(1)
                if (!content) {
                    console.error("Usage: baro-memory store <content> --tool <tool> [--file <path>] [--agent <id>]")
                    process.exit(1)
                }
                const tool = getFlag("tool") || "Bash"
                const file = getFlag("file")
                const agent = getFlag("agent") || "manual"

                const stored = await store.remember({
                    tool,
                    agentId: agent,
                    content,
                    filePath: file,
                })

                if (stored) {
                    console.log(`Stored: ${tool} ${file || ""} from ${agent}`)
                } else {
                    console.error("Failed to store finding (empty content or embedding error)")
                    process.exit(1)
                }
                break
            }

            case "cache": {
                const sub = getPositionalArg(1)
                if (sub === "list") {
                    const paths = await store.getCachedPaths()
                    if (paths.length === 0) {
                        console.log("No cached files.")
                    } else {
                        console.log(`Cached files (${paths.length}):`)
                        for (const p of paths) {
                            console.log(`  ${p}`)
                        }
                    }
                } else if (sub === "get") {
                    const path = getPositionalArg(2)
                    if (!path) {
                        console.error("Usage: baro-memory cache get <path>")
                        process.exit(1)
                    }
                    const content = await store.getCachedFile(path)
                    if (content) {
                        console.log(content)
                    } else {
                        console.error(`Not cached: ${path}`)
                        process.exit(1)
                    }
                } else {
                    console.error("Usage: baro-memory cache [list|get <path>]")
                    process.exit(1)
                }
                break
            }

            case "stats": {
                const memStats = await store.getStats()
                console.log("Memory Stats:")
                console.log(`  Findings: ${memStats.totalFindings}`)
                console.log(`  Cached files: ${memStats.cachedFiles}`)
                console.log(`  Cache size: ${memStats.cacheSizeBytes} bytes`)
                console.log(`  Tools: ${memStats.toolsList.join(", ") || "(none)"}`)
                console.log(`  Agents: ${memStats.agentsList.join(", ") || "(none)"}`)
                break
            }

            default:
                console.log("baro-memory - Shared semantic memory for baro agents\n")
                console.log("Commands:")
                console.log("  query <text> [--top N] [--agent id]  Search for relevant findings")
                console.log("  store <content> --tool <tool>         Store a finding")
                console.log("  cache list                            List cached files")
                console.log("  cache get <path>                      Get cached file content")
                console.log("  stats                                 Show memory statistics")
                console.log("")
                console.log("Environment:")
                console.log("  BARO_MEMORY_PATH  Session memory directory (set by orchestrator)")
        }
    } finally {
        // Always close store to release resources
        if (store) await store.close()
    }
}

main().catch(err => {
    console.error(`baro-memory error: ${err.message || err}`)
    process.exit(1)
})
