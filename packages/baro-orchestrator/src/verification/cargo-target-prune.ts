import { lstatSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { packageCacheRoot } from "../harness/package-cache.js"
import { baroHome } from "../runtime/baro-home.js"
import { diskUsage, formatBytes } from "../runtime/disk-usage.js"

// Long enough that no build still running from a previous run start loses
// state it is about to reuse.
export const CARGO_LEFTOVER_MAX_AGE_MS = 2 * 24 * 60 * 60_000

/** Baro-owned cargo target roots; each holds one target dir per repository. */
export function cargoTargetCacheRoots(env: NodeJS.ProcessEnv = process.env): string[] {
    return [
        join(packageCacheRoot(env), "cargo-target"),
        join(baroHome(), "cargo-target"),
    ]
}

export interface CargoPruneOptions {
    roots: readonly string[]
    now?: number
    maxAgeMs?: number
    log: (line: string) => void
}

export interface CargoPruneSummary {
    objects: number
    incremental: number
    bytes: number
}

/**
 * Bound the shared target dirs without touching what builds reuse. Units keep
 * their names across worktrees, so rlibs and fingerprints are overwritten in
 * place; what piles up are codegen objects rustc leaves behind under a new
 * name each build (`deps/<unit>.<cgu>.<session>.rcgu.o`) and incremental
 * state. Nothing links against either: dropping one costs at most a slower
 * rebuild, or debug info for a binary that old.
 */
export function pruneCargoTargetCaches(opts: CargoPruneOptions): CargoPruneSummary {
    const summary: CargoPruneSummary = { objects: 0, incremental: 0, bytes: 0 }
    const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? CARGO_LEFTOVER_MAX_AGE_MS)
    for (const root of opts.roots) {
        for (const target of subdirs(root)) {
            for (const profile of profileDirs(target)) pruneProfile(profile, cutoff, summary)
        }
    }
    if (summary.objects + summary.incremental > 0) {
        opts.log(
            `pruned ${summary.objects} leftover object file(s) and ${summary.incremental} ` +
                `incremental dir(s) from cargo target caches (${formatBytes(summary.bytes)})`,
        )
    }
    return summary
}

/** `debug/`, `release/`, custom profiles, and `<triple>/<profile>/`. */
function profileDirs(target: string): string[] {
    const found: string[] = []
    for (const dir of subdirs(target)) {
        if (isProfile(dir)) found.push(dir)
        else for (const nested of subdirs(dir)) if (isProfile(nested)) found.push(nested)
    }
    return found
}

function isProfile(dir: string): boolean {
    return isDirectory(join(dir, ".fingerprint"))
}

function pruneProfile(profile: string, cutoff: number, summary: CargoPruneSummary): void {
    for (const dir of [join(profile, "deps"), join(profile, "examples")]) {
        for (const name of list(dir)) {
            if (!name.endsWith(".rcgu.o")) continue
            const path = join(dir, name)
            if (mtimeOf(path) >= cutoff) continue
            summary.bytes += remove(path)
            summary.objects += 1
        }
    }
    for (const crate of list(join(profile, "incremental"))) {
        const dir = join(profile, "incremental", crate)
        if (newestMtime(dir) >= cutoff) continue
        summary.bytes += remove(dir)
        summary.incremental += 1
    }
}

/** rustc adds a session dir per compile, so the crate dir's entries date its last use. */
function newestMtime(dir: string): number {
    let newest = mtimeOf(dir)
    for (const name of list(dir)) newest = Math.max(newest, mtimeOf(join(dir, name)))
    return newest
}

function remove(path: string): number {
    const bytes = diskUsage(path)
    try {
        rmSync(path, { recursive: true, force: true })
    } catch {
        return 0
    }
    return bytes
}

function subdirs(path: string): string[] {
    return list(path).map((name) => join(path, name)).filter(isDirectory)
}

function list(path: string): string[] {
    try {
        return readdirSync(path)
    } catch {
        return []
    }
}

function isDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory()
    } catch {
        return false
    }
}

function mtimeOf(path: string): number {
    try {
        return lstatSync(path).mtimeMs
    } catch {
        return 0
    }
}
