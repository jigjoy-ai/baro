/**
 * What a still-working agent should learn when a sibling's work lands.
 *
 * A measured failure: a story wrote `allowed_status_for_payment_test.go` and
 * `forbidden_status_transition_test.go`, and died at integration with
 * "conflicts with already-merged work" — files two earlier stories had already
 * merged. It could not have known. Nothing in the run tells a working agent
 * what landed while it was working; the bus carries StoryMerged, and no
 * participant turns that into something an agent can act on.
 *
 * This is the rule for what is worth saying. Silence is the default: an agent
 * reading a message it cannot use has paid a turn for nothing.
 */

export interface LandedWork {
    readonly storyId: string
    /** Files that story wrote, as observed on the bus — not a git diff. */
    readonly paths: readonly string[]
}

export interface AwarenessAudience {
    readonly agentId: string
    /** Files this agent has written so far, used to judge relevance. */
    readonly writes: readonly string[]
}

export interface AwarenessNotice {
    readonly recipientId: string
    readonly text: string
    /** True when the landed work touches a file the recipient also wrote. */
    readonly collides: boolean
}

/**
 * Who needs to hear about this, and what it means for them.
 *
 * Everyone still working hears that work landed — that is cheap and keeps an
 * agent from planning onto ground that is no longer free. An agent whose own
 * files are among them hears something stronger, because it is already in the
 * failure the merge is about to cause.
 */
export function noticesForLanding(
    landed: LandedWork,
    audience: readonly AwarenessAudience[],
): AwarenessNotice[] {
    const landedPaths = normalize(landed.paths)
    if (landedPaths.length === 0) return []

    const notices: AwarenessNotice[] = []
    for (const listener of audience) {
        if (listener.agentId === landed.storyId) continue
        const own = new Set(normalize(listener.writes))
        const shared = landedPaths.filter((path) => own.has(path))
        notices.push({
            recipientId: listener.agentId,
            collides: shared.length > 0,
            text: shared.length > 0
                ? renderCollision(landed.storyId, shared, landedPaths)
                : renderLanding(landed.storyId, landedPaths),
        })
    }
    return notices
}

/** Facts, and the one inference the agent cannot draw for itself. */
function renderCollision(
    storyId: string,
    shared: readonly string[],
    all: readonly string[],
): string {
    const lines = [
        `[baro] ${storyId} has merged, and it wrote ${plural(shared.length, "file")} you also wrote:`,
    ]
    for (const path of shared) lines.push(`  ${path}`)
    const others = all.filter((path) => !shared.includes(path))
    if (others.length > 0) {
        lines.push("", `It also landed: ${others.join(", ")}`)
    }
    lines.push(
        "",
        "Its version is on the branch now. Yours will not merge on top of it as it stands —",
        "read what landed and either build on it or drop your copy.",
    )
    return lines.join("\n")
}

function renderLanding(storyId: string, paths: readonly string[]): string {
    const lines = [`[baro] ${storyId} has merged and landed:`]
    for (const path of paths.slice(0, MAX_LISTED_PATHS)) lines.push(`  ${path}`)
    if (paths.length > MAX_LISTED_PATHS) {
        lines.push(`  … and ${paths.length - MAX_LISTED_PATHS} more`)
    }
    lines.push("", "These files exist on the branch now. Do not write them again.")
    return lines.join("\n")
}

const MAX_LISTED_PATHS = 12

function plural(count: number, word: string): string {
    return count === 1 ? `one ${word}` : `${count} ${word}s`
}

function normalize(paths: readonly string[]): string[] {
    const seen = new Set<string>()
    for (const path of paths) {
        const trimmed = path.trim().replace(/^\.\//u, "")
        if (trimmed) seen.add(trimmed)
    }
    return [...seen]
}
