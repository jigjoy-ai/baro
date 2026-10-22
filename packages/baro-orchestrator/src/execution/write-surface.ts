import type { StorySpawnRequestData } from "../events/execution.js"
import { writeSurfaceOf } from "../planning/domain/dependency-evidence.js"
import { normalizeWritePath, writeClaimsOf } from "../planning/domain/write-claims.js"
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
    const shared: Record<string, string[]> = {}
    const ordered = orderedWith(story.id, stories)
    for (const peer of stories) {
        if (peer.id === story.id || !isActiveOwner(peer)) continue
        for (const path of writeSurfaceOf(peer)) {
            if (!writes.includes(path)) ownedElsewhere[path] ??= peer.id
            else if (!ordered.has(peer.id)) (shared[path] ??= []).push(peer.id)
        }
    }
    const regions: Record<string, string[]> = {}
    for (const [path, claimed] of writeClaimsOf(story)) {
        if (claimed) regions[path] = [...claimed]
    }
    return {
        writes,
        ownedElsewhere,
        ...(Object.keys(regions).length > 0 ? { regions } : {}),
        ...(Object.keys(shared).length > 0 ? { shared } : {}),
    }
}

/** Transitive ancestors and descendants: peers the DAG never runs alongside. */
function orderedWith(storyId: string, stories: readonly PrdStory[]): Set<string> {
    const ordered = new Set<string>()
    const walk = (next: (id: string) => string[]) => {
        const stack = next(storyId)
        while (stack.length > 0) {
            const id = stack.pop()!
            if (ordered.has(id) || id === storyId) continue
            ordered.add(id)
            stack.push(...next(id))
        }
    }
    const byId = new Map(stories.map((entry) => [entry.id, entry]))
    walk((id) => [...(byId.get(id)?.dependsOn ?? [])])
    walk((id) =>
        stories
            .filter((entry) => (entry.dependsOn ?? []).includes(id))
            .map((entry) => entry.id),
    )
    return ordered
}

/** The one ownership rule shared by replan admission and the per-write gates. */
export function isActiveOwner(story: PrdStory): boolean {
    return story.passes !== true
}

export function surfacesOverlap(
    a: readonly string[],
    b: readonly string[],
): string[] {
    const left = new Set(a.map(normalizeWritePath))
    return [...new Set(b.map(normalizeWritePath))]
        .filter((path) => path && left.has(path))
        .sort()
}

/** Order-independent identity, so a re-computation that changed nothing is
 * never re-announced to a running lease. */
export function surfaceKey(surface: StorySpawnRequestData["surface"]): string {
    if (!surface) return "none"
    return JSON.stringify({
        writes: [...surface.writes].sort(),
        ownedElsewhere: sortedRecord(surface.ownedElsewhere, (owner) => owner),
        ...(surface.regions
            ? { regions: sortedRecord(surface.regions, (list) => [...list].sort()) }
            : {}),
        ...(surface.shared
            ? { shared: sortedRecord(surface.shared, (list) => [...list].sort()) }
            : {}),
    })
}

function sortedRecord<T, U>(
    record: Readonly<Record<string, T>>,
    value: (entry: T) => U,
): Record<string, U> {
    return Object.fromEntries(
        Object.entries(record)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, value(entry)]),
    )
}
