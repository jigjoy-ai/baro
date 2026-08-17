import type { StorySpawnRequestData } from "../events/execution.js"
import { writeSurfaceOf } from "../planning/domain/dependency-evidence.js"
import type { PrdStory } from "../prd.js"

/**
 * What this story may write, and who owns what it may not.
 *
 * The merge gate has always refused a diff that reaches outside the story's
 * declared writes; this is the same boundary said out loud, early enough to
 * act on. It must be computed wherever stories are dispatched — a coordinator
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
        if (peer.id === story.id) continue
        for (const path of writeSurfaceOf(peer)) {
            if (writes.includes(path)) continue
            ownedElsewhere[path] ??= peer.id
        }
    }
    return { writes, ownedElsewhere }
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
