#!/usr/bin/env node
/**
 * Integration test: Multi-process shared memory via Vectra.
 *
 * Simulates the orchestrator writing findings and a CLI subprocess
 * reading them from the same Vectra index on disk.
 *
 * Usage: node test-memory-integration.mjs
 * Exit code 0 = pass, 1 = fail
 */

import { createMemoryStore } from '@baro/memory'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sessionPath = mkdtempSync(join(tmpdir(), 'baro-integration-'))
console.log(`Session path: ${sessionPath}\n`)

// ── Phase 1: Orchestrator writes findings ────────────────────────────────

console.log('=== Phase 1: Orchestrator writes findings ===')
const store = await createMemoryStore({ sessionPath })

await store.remember({
    tool: 'Read',
    agentId: 'story-1',
    content: 'Authentication middleware uses passport.js with JWT strategy. Tokens expire in 15 minutes. Refresh tokens stored in Redis.',
    filePath: 'src/auth/passport.ts',
})
console.log('  Stored: src/auth/passport.ts (auth finding)')

await store.remember({
    tool: 'Grep',
    agentId: 'story-1',
    content: 'Found 5 files importing from src/auth: login.ts, register.ts, middleware.ts, refresh.ts, logout.ts',
    pattern: 'from.*src/auth',
})
console.log('  Stored: grep result (auth imports)')

await store.remember({
    tool: 'Read',
    agentId: 'story-2',
    content: 'PostgreSQL connection pool with max 20 connections, using pg-pool. Connection string from DATABASE_URL env.',
    filePath: 'src/db/pool.ts',
})
console.log('  Stored: src/db/pool.ts (database finding)')

await store.cacheFile('src/auth/passport.ts', 'import passport from "passport"\n// ...auth code...', 'story-1')
await store.cacheFile('src/db/pool.ts', 'import { Pool } from "pg"\n// ...pool config...', 'story-2')
console.log('  Cached: 2 files')

const stats = await store.getStats()
console.log(`  Stats: ${stats.totalFindings} findings, ${stats.cachedFiles} cached files\n`)
await store.close()

// ── Phase 2: Subprocess reads from same index ────────────────────────────

console.log('=== Phase 2: Subprocess reads from same Vectra index ===')

// Write a tiny script that opens the same store and queries it
const queryScript = join(sessionPath, '_query.mjs')
writeFileSync(queryScript, `
import { createMemoryStore } from '${join(process.cwd(), 'dist', 'index.js')}'
const store = await createMemoryStore({ sessionPath: '${sessionPath}' })
const results = await store.recall('JWT authentication passport', { maxResults: 3, minSimilarity: 0.2 })
const cached = await store.getCachedPaths()
const stats = await store.getStats()
console.log(JSON.stringify({ results: results.length, firstAgent: results[0]?.metadata?.agentId, cached, stats }))
await store.close()
`)

const output = execSync(`node ${queryScript}`, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: { ...process.env, BARO_MEMORY_PATH: sessionPath },
}).trim()

const data = JSON.parse(output)
console.log(`  Query results: ${data.results} findings`)
console.log(`  First result agent: ${data.firstAgent}`)
console.log(`  Cached files visible: ${data.cached.length} (${data.cached.join(', ')})`)
console.log(`  Stats from subprocess: ${data.stats.totalFindings} findings, ${data.stats.cachedFiles} cached\n`)

// ── Phase 3: Subprocess writes, orchestrator reads ───────────────────────

console.log('=== Phase 3: Subprocess writes, then new instance reads ===')

const writeScript = join(sessionPath, '_write.mjs')
writeFileSync(writeScript, `
import { createMemoryStore } from '${join(process.cwd(), 'dist', 'index.js')}'
const store = await createMemoryStore({ sessionPath: '${sessionPath}' })
await store.remember({
    tool: 'Bash',
    agentId: 'story-3',
    content: 'npm test output: 142 tests passing, 0 failures, coverage at 91%',
    command: 'npm test',
})
await store.cacheFile('package.json', '{ "name": "test-app" }', 'story-3')
const stats = await store.getStats()
console.log(JSON.stringify({ totalFindings: stats.totalFindings, cachedFiles: stats.cachedFiles }))
await store.close()
`)

const writeOutput = execSync(`node ${writeScript}`, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: { ...process.env, BARO_MEMORY_PATH: sessionPath },
}).trim()

const writeData = JSON.parse(writeOutput)
console.log(`  After subprocess write: ${writeData.totalFindings} findings, ${writeData.cachedFiles} cached`)

// Reopen from orchestrator perspective
const store2 = await createMemoryStore({ sessionPath })
const finalStats = await store2.getStats()
console.log(`  Orchestrator sees: ${finalStats.totalFindings} findings, ${finalStats.cachedFiles} cached`)

const testResults = await store2.recall('test coverage', { maxResults: 2, minSimilarity: 0.2 })
console.log(`  Query 'test coverage': ${testResults.length} results`)
if (testResults.length > 0) {
    console.log(`    → ${testResults[0].metadata.agentId}: ${testResults[0].content.slice(0, 80)}...`)
}
await store2.close()

// ── Verify ───────────────────────────────────────────────────────────────

console.log('\n=== Verification ===')
let pass = true

if (data.results < 1) { console.log('FAIL: subprocess query returned 0 results'); pass = false }
if (data.firstAgent !== 'story-1') { console.log('FAIL: expected first result from story-1'); pass = false }
if (data.cached.length !== 2) { console.log('FAIL: expected 2 cached files visible'); pass = false }
if (finalStats.totalFindings !== 4) { console.log(`FAIL: expected 4 total findings, got ${finalStats.totalFindings}`); pass = false }
if (finalStats.cachedFiles !== 3) { console.log(`FAIL: expected 3 cached files, got ${finalStats.cachedFiles}`); pass = false }
if (testResults.length < 1) { console.log('FAIL: cross-process query for test coverage returned 0'); pass = false }

if (pass) {
    console.log('ALL CHECKS PASSED ✓')
} else {
    console.log('\nSOME CHECKS FAILED ✗')
}

// Cleanup
rmSync(sessionPath, { recursive: true })
process.exit(pass ? 0 : 1)
