import type { StorySpawnRequestData } from "../events/execution.js"
import { writeSurfaceOf } from "../planning/domain/dependency-evidence.js"
import type { PrdStory } from "../prd.js"

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
): StorySpawnRequestData["surface"] {
    const writes = writeSurfaceOf(story)
    if (writes.length === 0) return undefined
    const ownedElsewhere: Record<string, string> = {}
    for (const peer of stories) {
        if (peer.id === story.id || !isActiveOwner(peer)) continue
        for (const path of writeSurfaceOf(peer)) {
            if (writes.includes(path)) continue
            ownedElsewhere[path] ??= peer.id
        }
    }
    return { writes, ownedElsewhere }
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
