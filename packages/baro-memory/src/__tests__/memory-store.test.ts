/**
 * Tests for @baro/memory - Vectra-backed semantic memory for baro agents.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createMemoryStore, MemoryStore, Finding } from '../index.js'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

describe('VectraMemoryStore (persisted)', () => {
    let store: MemoryStore
    let sessionPath: string

    beforeAll(async () => {
        sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-test-'))
        store = await createMemoryStore({ sessionPath })
    }, 60000) // 60s timeout for model download on first run

    afterAll(async () => {
        await store.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    })

    describe('remember', () => {
        it('should store a finding', async () => {
            const finding: Finding = {
                tool: 'Read',
                agentId: 'story-1',
                content: 'JWT token validation using jsonwebtoken library',
                filePath: 'src/auth/jwt.ts',
                tags: ['auth', 'jwt'],
            }

            const result = await store.remember(finding)
            expect(result).toBe(true)
        })

        it('should store multiple findings', async () => {
            const findings: Finding[] = [
                {
                    tool: 'Grep',
                    agentId: 'story-1',
                    content: 'Found 3 files with authentication middleware',
                    pattern: 'authenticate',
                },
                {
                    tool: 'Read',
                    agentId: 'story-2',
                    content: 'PostgreSQL connection pool config: max 10 connections',
                    filePath: 'src/config/database.ts',
                },
                {
                    tool: 'Bash',
                    agentId: 'story-2',
                    content: 'npm test: 47 tests passing, 85% coverage',
                    command: 'npm test',
                },
            ]

            for (const finding of findings) {
                await store.remember(finding)
            }

            const stats = await store.getStats()
            expect(stats.totalFindings).toBeGreaterThanOrEqual(4) // 1 from first test + 3
        })

        it('should upsert (replace) findings with same ID', async () => {
            await store.remember({
                tool: 'Read',
                agentId: 'story-1',
                content: 'UPDATED: JWT validation with refresh tokens',
                filePath: 'src/auth/jwt.ts',
            })

            // Should not increase count (same agent:tool:filePath = same ID)
            const stats = await store.getStats()
            expect(stats.totalFindings).toBeGreaterThanOrEqual(4)

            // Should return updated content
            const results = await store.recall('JWT refresh tokens', {
                maxResults: 1,
                minSimilarity: 0.2,
            })
            expect(results.length).toBeGreaterThan(0)
            expect(results[0].content).toContain('UPDATED')
        })
    })

    describe('recall', () => {
        it('should find relevant findings by semantic search', async () => {
            const results = await store.recall('JWT authentication', {
                maxResults: 5,
                minSimilarity: 0.3,
            })

            expect(results.length).toBeGreaterThan(0)
            expect(results[0].similarity).toBeGreaterThan(0.3)
        })

        it('should filter by tool', async () => {
            const results = await store.recall('database configuration', {
                filterByTool: ['Read'],
                minSimilarity: 0.2,
            })

            for (const result of results) {
                expect(result.metadata.tool).toBe('Read')
            }
        })

        it('should exclude specific agent', async () => {
            const results = await store.recall('authentication', {
                excludeAgent: 'story-1',
                minSimilarity: 0.2,
            })

            const hasStory1 = results.some((r) => r.metadata.agentId === 'story-1')
            expect(hasStory1).toBe(false)
        })
    })

    describe('gatherContext', () => {
        it('should build context excluding own findings', async () => {
            const context = await store.gatherContext('story-3', ['auth', 'JWT'])

            expect(context).not.toBeNull()
            expect(context).toContain('parallel agents')
        })

        it('should return null when no relevant findings from other agents', async () => {
            await store.remember({
                tool: 'Read',
                agentId: 'story-solo',
                content: 'Unique finding only story-solo knows about xyzzy quantum flux',
            })

            // story-solo should not get its own findings back
            const context = await store.gatherContext('story-solo', ['xyzzy quantum flux'])
            expect(context).toBeNull()
        })

        it('should return null for empty hints', async () => {
            const context = await store.gatherContext('story-x', [])
            expect(context).toBeNull()
        })
    })

    describe('getStats', () => {
        it('should return correct statistics', async () => {
            const stats = await store.getStats()

            expect(stats.totalFindings).toBeGreaterThan(0)
            expect(stats.uniqueTools).toBeGreaterThan(0)
            expect(stats.uniqueAgents).toBeGreaterThan(0)
            expect(Array.isArray(stats.toolsList)).toBe(true)
            expect(Array.isArray(stats.agentsList)).toBe(true)
            expect(stats.toolsList).toContain('Read')
        })
    })

    describe('file cache', () => {
        it('should cache and retrieve file content', async () => {
            await store.cacheFile('src/auth.ts', 'const auth = true', 'story-1')

            const content = await store.getCachedFile('src/auth.ts')
            expect(content).toBe('const auth = true')

            const has = await store.hasFile('src/auth.ts')
            expect(has).toBe(true)
        })

        it('should return null for uncached files', async () => {
            const content = await store.getCachedFile('src/unknown.ts')
            expect(content).toBeNull()

            const has = await store.hasFile('src/unknown.ts')
            expect(has).toBe(false)
        })

        it('should list cached paths', async () => {
            await store.cacheFile('src/a.ts', 'content a', 'story-1')
            await store.cacheFile('src/b.ts', 'content b', 'story-2')

            const paths = await store.getCachedPaths()
            expect(paths).toContain('src/a.ts')
            expect(paths).toContain('src/b.ts')
        })

        it('should include cache stats', async () => {
            const stats = await store.getStats()
            expect(stats.cachedFiles).toBeGreaterThan(0)
            expect(stats.cacheSizeBytes).toBeGreaterThan(0)
        })

        it('should not overwrite cache if content is identical', async () => {
            await store.cacheFile('src/stable.ts', 'same content', 'story-1')
            await store.cacheFile('src/stable.ts', 'same content', 'story-2')

            const content = await store.getCachedFile('src/stable.ts')
            expect(content).toBe('same content')
        })
    })
})

describe('Cross-process persistence', () => {
    it('should persist data readable by a second store instance', async () => {
        const sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-persist-'))

        // Process 1: write findings
        const store1 = await createMemoryStore({ sessionPath })
        await store1.remember({
            tool: 'Read',
            agentId: 'writer-agent',
            content: 'Authentication uses bcrypt for password hashing',
            filePath: 'src/auth/passwords.ts',
        })
        await store1.cacheFile('src/main.ts', 'import express from "express"', 'writer-agent')
        await store1.close()

        // Process 2: read findings (simulates CLI opening same index)
        const store2 = await createMemoryStore({ sessionPath })

        const results = await store2.recall('password hashing bcrypt', {
            maxResults: 3,
            minSimilarity: 0.2,
        })
        expect(results.length).toBeGreaterThan(0)
        expect(results[0].metadata.agentId).toBe('writer-agent')
        expect(results[0].metadata.filePath).toBe('src/auth/passwords.ts')

        const cached = await store2.getCachedFile('src/main.ts')
        expect(cached).toBe('import express from "express"')

        const stats = await store2.getStats()
        expect(stats.totalFindings).toBe(1)
        expect(stats.cachedFiles).toBe(1)

        await store2.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    }, 60000)
})

describe('Cross-process recall on a live reader (#51 regression)', () => {
    // The bug: a long-lived reader store, created BEFORE another process
    // writes findings to the shared on-disk index, never saw those writes —
    // Vectra's LocalIndex caches its data in-memory at first query and never
    // reloads, so recall()/getStats() returned 0 forever. The fix reloads
    // the index when its on-disk mtime changes. This test reproduces the
    // exact ordering: reader opened first, writer (a SECOND store on the same
    // session path, standing in for the subprocess CLI writer) writes after,
    // then the pre-existing reader must see the finding.
    it('reader created before an external write still recalls it after reload', async () => {
        const sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-stale-'))

        // Reader opens first, against an empty index — this is the instance
        // that, pre-fix, froze on the empty snapshot.
        const reader = await createMemoryStore({ sessionPath })

        // Sanity: nothing there yet.
        const before = await reader.getStats()
        expect(before.totalFindings).toBe(0)

        // A separate store on the same session path writes a finding (stands
        // in for the out-of-process baro-memory CLI writer).
        const writer = await createMemoryStore({ sessionPath })
        await writer.remember({
            tool: 'Codex',
            agentId: 'writer-process',
            content: 'Chemical hazard mitigation already applied in docx-generator',
            filePath: 'packages/core/src/docx-generator.ts',
        })
        await writer.close()

        // The pre-existing reader must now observe the write (mtime-triggered
        // reload). Pre-fix this returned 0 / [].
        const stats = await reader.getStats()
        expect(stats.totalFindings).toBe(1)

        const results = await reader.recall('chemical hazard docx', {
            maxResults: 5,
            minSimilarity: 0.2,
        })
        expect(results.length).toBeGreaterThan(0)
        expect(results[0].metadata.agentId).toBe('writer-process')
        expect(results[0].metadata.filePath).toBe(
            'packages/core/src/docx-generator.ts',
        )

        await reader.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    }, 60000)
})

describe('Corruption recovery', () => {
    it('should handle corrupt cache.json gracefully', async () => {
        const sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-corrupt-'))

        // Create a store and cache a file
        const store1 = await createMemoryStore({ sessionPath })
        await store1.cacheFile('src/good.ts', 'good content', 'agent-1')
        await store1.close()

        // Corrupt the cache.json
        const cachePath = join(sessionPath, 'cache.json')
        writeFileSync(cachePath, '{ invalid json !!!', 'utf-8')

        // New store should handle corruption gracefully
        const store2 = await createMemoryStore({ sessionPath })
        const content = await store2.getCachedFile('src/good.ts')
        expect(content).toBeNull() // Data lost due to corruption, but no crash

        // Should still work for new writes
        await store2.cacheFile('src/new.ts', 'new content', 'agent-2')
        const newContent = await store2.getCachedFile('src/new.ts')
        expect(newContent).toBe('new content')

        await store2.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    }, 60000)

    it('should handle empty/missing cache.json', async () => {
        const sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-empty-'))

        const store = await createMemoryStore({ sessionPath })

        // No cache.json exists yet — should return empty results
        const paths = await store.getCachedPaths()
        expect(paths).toEqual([])

        const content = await store.getCachedFile('nonexistent.ts')
        expect(content).toBeNull()

        await store.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    }, 60000)

    it('should return false for empty content in remember()', async () => {
        const sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-empty-content-'))
        const store = await createMemoryStore({ sessionPath })

        const result1 = await store.remember({ tool: 'Read', agentId: 'a', content: '' })
        expect(result1).toBe(false)

        const result2 = await store.remember({ tool: 'Read', agentId: 'a', content: '   ' })
        expect(result2).toBe(false)

        await store.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    }, 60000)

    it('should return empty results for empty query in recall()', async () => {
        const sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-empty-query-'))
        const store = await createMemoryStore({ sessionPath })

        const results1 = await store.recall('')
        expect(results1).toEqual([])

        const results2 = await store.recall('   ')
        expect(results2).toEqual([])

        await store.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    }, 60000)
})

describe('NoOp MemoryStore (disabled)', () => {
    let store: MemoryStore

    beforeAll(async () => {
        store = await createMemoryStore({ disabled: true })
    })

    it('should return false on remember', async () => {
        const result = await store.remember({
            tool: 'Read',
            agentId: 'story-1',
            content: 'Test',
        })
        expect(result).toBe(false)
    })

    it('should return empty array on recall', async () => {
        const results = await store.recall('test')
        expect(results).toEqual([])
    })

    it('should return null on gatherContext', async () => {
        const context = await store.gatherContext('story-1', ['test'])
        expect(context).toBeNull()
    })

    it('should return zero stats', async () => {
        const stats = await store.getStats()
        expect(stats.totalFindings).toBe(0)
    })
})

describe('Token savings simulation', () => {
    it('should reduce context size via semantic recall vs full dump', async () => {
        const sessionPath = mkdtempSync(join(tmpdir(), 'baro-memory-tokens-'))
        const store = await createMemoryStore({ sessionPath })

        // Simulate multiple agents discovering files
        const files = [
            { agentId: 'story-1', filePath: 'src/auth/jwt.ts', content: 'JWT validation logic with token expiry and refresh mechanism' },
            { agentId: 'story-1', filePath: 'src/auth/middleware.ts', content: 'Express middleware for authentication checks' },
            { agentId: 'story-2', filePath: 'src/db/connection.ts', content: 'PostgreSQL connection pool with 10 max connections' },
            { agentId: 'story-2', filePath: 'src/db/migrations.ts', content: 'Database migration runner using knex' },
            { agentId: 'story-3', filePath: 'src/api/users.ts', content: 'User CRUD endpoints: GET /users, POST /users, etc.' },
            { agentId: 'story-3', filePath: 'src/api/auth.ts', content: 'Auth endpoints: POST /login, POST /register, POST /refresh' },
        ]

        for (const f of files) {
            await store.remember({
                tool: 'Read',
                agentId: f.agentId,
                content: f.content,
                filePath: f.filePath,
            })
        }

        // Total content size (raw findings only)
        const totalSize = files.reduce((sum, f) => sum + f.content.length, 0)

        // Semantic recall for auth-related context only
        const context = await store.gatherContext('story-4', ['auth', 'JWT', 'token'])
        const contextSize = context?.length ?? 0

        // Should include fewer findings than total
        const results = await store.recall('auth JWT token', { excludeAgent: 'story-4' })
        expect(results.length).toBeLessThan(files.length)
        expect(results.length).toBeGreaterThan(0)

        console.log(`\nToken savings simulation:`)
        console.log(`  Total findings: ${files.length}`)
        console.log(`  Relevant findings (auth): ${results.length}`)
        console.log(`  Full dump: ${totalSize} chars`)
        console.log(`  Semantic recall: ${contextSize} chars (includes headers)`)
        console.log(`  Reduction: ${Math.round((1 - results.length / files.length) * 100)}% fewer findings`)

        await store.close()
        try { rmSync(sessionPath, { recursive: true }) } catch {}
    }, 60000)
})
