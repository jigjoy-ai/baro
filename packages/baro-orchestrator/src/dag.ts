/**
 * DAG levels via Kahn-style topological sort. Stories at the same level
 * have no dependencies on each other and run in parallel.
 */

export interface DagNode {
    id: string
    priority?: number
    dependsOn?: string[]
    passes?: boolean
}

export interface DagLevel {
    storyIds: string[]
}

export interface BuildOptions {
    /**
     * Exclude stories with `passes: true` and treat deps on them as
     * satisfied (the remaining-work DAG). Default: false.
     */
    onlyIncomplete?: boolean
}

export function buildDag(
    stories: readonly DagNode[],
    options: BuildOptions = {},
): DagLevel[] {
    const onlyIncomplete = options.onlyIncomplete ?? false
    const completedIds = new Set(
        stories.filter((s) => s.passes === true).map((s) => s.id),
    )
    const active = onlyIncomplete
        ? stories.filter((s) => s.passes !== true)
        : stories.slice()

    const storyMap = new Map<string, DagNode>(active.map((s) => [s.id, s]))

    const inDegree = new Map<string, number>()
    const dependents = new Map<string, string[]>()

    for (const s of active) {
        const activeDeps = (s.dependsOn ?? []).filter(
            (d) =>
                storyMap.has(d) && (!onlyIncomplete || !completedIds.has(d)),
        )
        inDegree.set(s.id, activeDeps.length)
        for (const dep of activeDeps) {
            const list = dependents.get(dep) ?? []
            list.push(s.id)
            dependents.set(dep, list)
        }
    }

    const levels: DagLevel[] = []
    let queue: DagNode[] = active.filter((s) => (inDegree.get(s.id) ?? 0) === 0)

    while (queue.length > 0) {
        queue.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
        levels.push({ storyIds: queue.map((s) => s.id) })

        const next: DagNode[] = []
        for (const s of queue) {
            const deps = dependents.get(s.id)
            if (!deps) continue
            for (const dependentId of deps) {
                const remaining = (inDegree.get(dependentId) ?? 0) - 1
                inDegree.set(dependentId, remaining)
                if (remaining === 0) {
                    const story = storyMap.get(dependentId)
                    if (story) next.push(story)
                }
            }
        }
        queue = next
    }

    const placed = new Set(levels.flatMap((l) => l.storyIds))
    if (placed.size !== active.length) {
        const cycled = active.filter((s) => !placed.has(s.id)).map((s) => s.id)
        throw new Error(`Dependency cycle detected: ${cycled.join(", ")}`)
    }

    return levels
}
