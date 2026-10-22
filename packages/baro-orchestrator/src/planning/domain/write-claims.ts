import type { PrdStory } from "../../prd.js"

/**
 * A `writes` entry is a path (the whole file) or `path#region` (one symbol in
 * it). Region-disjoint stories may share a file; the merge gate, not this
 * declaration, decides whether that guess was right.
 */
export const REGION_SEPARATOR = "#"

export interface WriteClaim {
    readonly path: string
    readonly region: string | null
}

export function normalizeWritePath(path: string): string {
    return path.trim().replace(/^\.\//u, "").replace(/^\/+/u, "")
}

export function parseWriteEntry(entry: string): WriteClaim {
    const at = entry.indexOf(REGION_SEPARATOR)
    if (at < 0) return { path: normalizeWritePath(entry), region: null }
    const region = entry.slice(at + 1).trim()
    return {
        path: normalizeWritePath(entry.slice(0, at)),
        region: region || null,
    }
}

export function formatWriteClaim(claim: WriteClaim): string {
    return claim.region === null
        ? claim.path
        : `${claim.path}${REGION_SEPARATOR}${claim.region}`
}

function declaredEntries(story: PrdStory): string[] {
    const declared = (story as PrdStory & { writes?: unknown }).writes
    if (!Array.isArray(declared)) return []
    return declared.filter((entry): entry is string => typeof entry === "string")
}

/** path → regions claimed in it, or null when the whole file is claimed. */
export function writeClaimsOf(
    story: PrdStory,
): Map<string, ReadonlySet<string> | null> {
    const claims = new Map<string, Set<string> | null>()
    for (const entry of declaredEntries(story)) {
        const { path, region } = parseWriteEntry(entry)
        if (!path) continue
        const current = claims.get(path)
        if (region === null || current === null) {
            claims.set(path, null)
        } else {
            claims.set(path, (current ?? new Set<string>()).add(region))
        }
    }
    return claims
}

/** Normalized entries, whole-file claims absorbing their own regions. */
export function writeEntriesOf(story: PrdStory): string[] {
    const entries: string[] = []
    for (const [path, regions] of writeClaimsOf(story)) {
        if (regions === null) entries.push(path)
        else for (const region of regions) entries.push(formatWriteClaim({ path, region }))
    }
    return entries
}

/**
 * Paths two stories cannot both hold: shared, and either side claims the
 * whole file or both name the same region.
 */
export function conflictingWritePaths(a: PrdStory, b: PrdStory): string[] {
    const left = writeClaimsOf(a)
    const conflicts: string[] = []
    for (const [path, rightRegions] of writeClaimsOf(b)) {
        if (!left.has(path)) continue
        const leftRegions = left.get(path)!
        if (
            leftRegions === null ||
            rightRegions === null ||
            [...rightRegions].some((region) => leftRegions.has(region))
        ) {
            conflicts.push(path)
        }
    }
    return conflicts.sort()
}

/** Paths both stories write whether or not their regions collide. */
export function sharedWritePaths(a: PrdStory, b: PrdStory): string[] {
    const left = writeClaimsOf(a)
    return [...writeClaimsOf(b).keys()].filter((path) => left.has(path)).sort()
}
