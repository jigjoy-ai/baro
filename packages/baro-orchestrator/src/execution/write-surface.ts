import type {
    PathClaimDecision,
    StorySpawnRequestData,
} from "../events/execution.js"
import { writeSurfaceOf } from "../planning/domain/dependency-evidence.js"
import type { PrdStory } from "../prd.js"

export type { PathClaimDecision }

/**
 * BARO_SHARED_WRITES=1: stories may write the same file and git decides. A
 * clean merge lands; a real conflict takes the existing retry path onto the
 * latest run branch. Read per call so a test can toggle it.
 */
export function sharedWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.BARO_SHARED_WRITES === "1"
}

/**
 * What this story may write, and who owns what it may not.
 *
 * Only active peers own paths: a story that integrated releases its surface.
 * It must be computed wherever stories are dispatched — a coordinator
 * that omits it silently returns the agent to learning the rule by breaking
 * it, an hour of work later.
 *
 * A story that declared nothing gets no surface rather than a boundary of
 * pure prohibitions: remediation work is created without writes and would
 * otherwise be refused every file it exists to repair.
 */
export function storyWriteSurface(
    story: PrdStory,
    stories: readonly PrdStory[],
    claims: PathClaims = new Map(),
): StorySpawnRequestData["surface"] {
    const writes = [
        ...new Set([...writeSurfaceOf(story), ...claimedBy(story.id, claims)]),
    ]
    if (writes.length === 0) return undefined
    return { writes, ownedElsewhere: heldElsewhere(story.id, stories, claims) }
}

/**
 * What active peers hold that `storyId` neither declared nor claimed. Computed
 * even for a story that declared nothing, which may write anywhere else; the
 * merge gate refuses a diff touching any of it. Empty under shared writes.
 */
export function heldElsewhere(
    storyId: string,
    stories: readonly PrdStory[],
    claims: PathClaims = new Map(),
): Record<string, string> {
    const held: Record<string, string> = {}
    if (sharedWritesEnabled()) return held
    const self = stories.find((candidate) => candidate.id === storyId)
    const own = new Set([
        ...(self ? writeSurfaceOf(self) : []),
        ...claimedBy(storyId, claims),
    ])
    for (const peer of stories) {
        if (peer.id === storyId || !isActiveOwner(peer)) continue
        for (const path of [...writeSurfaceOf(peer), ...claimedBy(peer.id, claims)]) {
            if (!own.has(path)) held[path] ??= peer.id
        }
    }
    return held
}

/** Paths claimed at runtime, path → claimant(s). A claim lasts while its
 * claimant is an active owner, exactly like a declared write; only shared
 * writes give one path several active claimants. */
export type PathClaims = ReadonlyMap<string, string | readonly string[]>

export function claimantsOf(claims: PathClaims, path: string): readonly string[] {
    const owners = claims.get(path)
    if (owners === undefined) return []
    return typeof owners === "string" ? [owners] : owners
}


/**
 * Whether `storyId` may take `path` now. A path no active peer declares or
 * holds is free: unowned, or released by a story that integrated. One that an
 * active peer owns stays with it, and the claimant asks that owner instead —
 * unless writes are shared, when the claimant co-owns it and git decides.
 */
export function decidePathClaim(
    storyId: string,
    path: string,
    stories: readonly PrdStory[],
    claims: PathClaims,
): PathClaimDecision {
    const self = stories.find((story) => story.id === storyId)
    const claimants = claimantsOf(claims, path)
    if (
        (self && writeSurfaceOf(self).includes(path)) ||
        claimants.includes(storyId)
    ) return { path, outcome: "already_owned" }
    const activeOwners = stories.filter(
        (peer) =>
            peer.id !== storyId &&
            isActiveOwner(peer) &&
            (writeSurfaceOf(peer).includes(path) || claimants.includes(peer.id)),
    )
    if (activeOwners.length > 0 && !sharedWritesEnabled()) {
        return { path, outcome: "held", ownerStoryId: activeOwners[0]!.id }
    }
    const released = stories.find(
        (peer) =>
            peer.id !== storyId &&
            !isActiveOwner(peer) &&
            writeSurfaceOf(peer).includes(path),
    )
    return {
        path,
        outcome: "granted",
        ...(released ? { releasedBy: released.id } : {}),
        ...(activeOwners.length > 0
            ? { sharedWith: activeOwners.map((peer) => peer.id) }
            : {}),
    }
}

function claimedBy(storyId: string, claims: PathClaims): string[] {
    const out: string[] = []
    for (const path of claims.keys()) {
        if (claimantsOf(claims, path).includes(storyId)) out.push(path)
    }
    return out.sort()
}

/** The one ownership rule shared by replan admission and the per-write gates. */
export function isActiveOwner(story: PrdStory): boolean {
    return story.passes !== true
}

export function surfacesOverlap(
    a: readonly string[],
    b: readonly string[],
): string[] {
    const left = new Set(a.map(normalizeSurfacePath))
    return [...new Set(b.map(normalizeSurfacePath))]
        .filter((path) => path && left.has(path))
        .sort()
}

function normalizeSurfacePath(path: string): string {
    return path.trim().replace(/^\.\//u, "").replace(/^\/+/u, "")
}

/** Order-independent identity, so a re-computation that changed nothing is
 * never re-announced to a running lease. */
export function surfaceKey(surface: StorySpawnRequestData["surface"]): string {
    if (!surface) return "none"
    return JSON.stringify({
        writes: [...surface.writes].sort(),
        ownedElsewhere: Object.fromEntries(
            Object.entries(surface.ownedElsewhere).sort(([a], [b]) =>
                a.localeCompare(b),
            ),
        ),
    })
}
