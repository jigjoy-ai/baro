/**
 * A dependency edge has to point at a file, or it does not exist.
 *
 * Measured on a zod migration: the planner emitted S1→S2→S3→S4 and defended
 * it with "concurrent agents would collide on shared writes". They would not
 * have. S2 wrote shops DTOs, S3 wrote menus DTOs, S4 wrote promotions, tables,
 * public and internal DTOs — three disjoint sets, no file in common. Only
 * S1's foundation was genuinely shared. The chain cost about a thousand
 * seconds, 40% of the run, to avoid a collision that could not happen.
 *
 * The planner cannot check its own guess; the story text already names every
 * file. So the host checks it, and only ever in the direction of removing an
 * edge nothing supports. An edge is kept whenever evidence is missing —
 * a run that is slower than it needed to be beats a run that races.
 */

import type { PrdStory } from "../../prd.js"

export interface UnsupportedEdge {
    readonly from: string
    readonly to: string
}

export interface EdgePruneResult {
    readonly stories: PrdStory[]
    readonly removed: readonly UnsupportedEdge[]
}

const PATH_PATTERN =
    /(?:src|test|tests|lib|app|apps|packages|crates)\/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+|package\.json|tsconfig(?:\.[a-z]+)?\.json/gu

/** Files a story says it will write, when it says so at all. */
export function writeSurfaceOf(story: PrdStory): string[] {
    const declared = (story as PrdStory & { writes?: unknown }).writes
    if (!Array.isArray(declared)) return []
    return normalize(declared.filter((entry): entry is string => typeof entry === "string"))
}

/** Every path the story's own text mentions, whether it writes it or not. */
export function referencedPathsOf(story: PrdStory): string[] {
    const text = [
        story.description ?? "",
        ...(story.acceptance ?? []),
        ...(story.tests ?? []),
    ].join("\n")
    return normalize(text.match(PATH_PATTERN) ?? [])
}

/**
 * Edges no file supports.
 *
 * An edge A→B survives if B writes something A writes — they would collide —
 * or if B's own text names a file A writes, which is how a story says it
 * builds on another's output. Anything less is not evidence: `package.json`
 * and the test command appear in every story ever written.
 */
export function unsupportedEdges(stories: readonly PrdStory[]): UnsupportedEdge[] {
    const byId = new Map(stories.map((story) => [story.id, story]))
    const unsupported: UnsupportedEdge[] = []

    for (const story of stories) {
        const ownWrites = new Set(writeSurfaceOf(story))
        const mentioned = new Set(referencedPathsOf(story))
        for (const dependencyId of story.dependsOn ?? []) {
            const dependency = byId.get(dependencyId)
            if (!dependency) continue
            const dependencyWrites = writeSurfaceOf(dependency)
            // Silence from either side is not evidence of independence.
            if (dependencyWrites.length === 0 || ownWrites.size === 0) continue
            const supported = dependencyWrites.some(
                (path) => ownWrites.has(path) || mentioned.has(path),
            )
            if (!supported) unsupported.push({ from: dependencyId, to: story.id })
        }
    }
    return unsupported
}

export function pruneUnsupportedEdges(stories: readonly PrdStory[]): EdgePruneResult {
    const removed = unsupportedEdges(stories)
    if (removed.length === 0) return { stories: [...stories], removed }

    const drop = new Map<string, Set<string>>()
    for (const edge of removed) {
        const set = drop.get(edge.to) ?? new Set<string>()
        set.add(edge.from)
        drop.set(edge.to, set)
    }
    return {
        stories: stories.map((story) => {
            const dropped = drop.get(story.id)
            if (!dropped) return story
            return {
                ...story,
                dependsOn: (story.dependsOn ?? []).filter((id) => !dropped.has(id)),
            }
        }),
        removed,
    }
}

function normalize(paths: readonly string[]): string[] {
    const seen = new Set<string>()
    for (const path of paths) {
        const trimmed = path.trim().replace(/^\.\//u, "").replace(/^\/+/u, "")
        if (trimmed) seen.add(trimmed)
    }
    return [...seen]
}
