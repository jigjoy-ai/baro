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

export interface DisjointWidthEvidence {
    /** True when every story declares writes and no unordered pair overlaps. */
    readonly proven: boolean
    /** Stories that declared no write surface (silence is not evidence). */
    readonly undeclared: readonly string[]
    /** Unordered pairs whose declared writes overlap. */
    readonly conflicts: readonly { a: string; b: string; path: string }[]
}

/**
 * Can this plan's width stand on evidence? maxStories exists to protect a run
 * from guessed-at parallel edits colliding; that risk is zero for stories
 * whose declared write surfaces are pairwise disjoint (pairs ordered by a
 * dependency path may overlap — the DAG already serializes them). A story
 * that declares nothing keeps the cap: silence is not evidence.
 */
export function disjointWidthEvidence(
    stories: readonly PrdStory[],
): DisjointWidthEvidence {
    const undeclared = stories
        .filter((story) => writeSurfaceOf(story).length === 0)
        .map((story) => story.id)

    // Transitive reachability over dependsOn: ordered pairs may share files.
    const ids = stories.map((story) => story.id)
    const index = new Map(ids.map((id, i) => [id, i]))
    const reachable: boolean[][] = ids.map(() => ids.map(() => false))
    for (const story of stories) {
        for (const dep of story.dependsOn ?? []) {
            const from = index.get(dep)
            const to = index.get(story.id)
            if (from !== undefined && to !== undefined) reachable[from]![to] = true
        }
    }
    for (let k = 0; k < ids.length; k++) {
        for (let i = 0; i < ids.length; i++) {
            if (!reachable[i]![k]) continue
            for (let j = 0; j < ids.length; j++) {
                if (reachable[k]![j]) reachable[i]![j] = true
            }
        }
    }

    const surfaces = stories.map((story) => new Set(writeSurfaceOf(story)))
    const conflicts: { a: string; b: string; path: string }[] = []
    for (let i = 0; i < stories.length; i++) {
        for (let j = i + 1; j < stories.length; j++) {
            if (reachable[i]![j] || reachable[j]![i]) continue
            for (const path of surfaces[i]!) {
                if (surfaces[j]!.has(path)) {
                    conflicts.push({ a: ids[i]!, b: ids[j]!, path })
                    break
                }
            }
        }
    }
    return {
        proven: undeclared.length === 0 && conflicts.length === 0,
        undeclared,
        conflicts,
    }
}
