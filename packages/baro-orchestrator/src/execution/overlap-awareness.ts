/**
 * What two agents writing the same file should be told, while both can still
 * do something about it.
 *
 * Sentry has detected this for a long time and emits a Coordination notice
 * naming the path and the agents. Nothing consumes it. The overlap is found,
 * recorded, and then nobody who could act on it ever hears about it — so the
 * first either agent learns of the other is at integration, after both have
 * paid for the work.
 *
 * The host detects; the agents decide. Deliberately no verdict here: this
 * states who else is in the file and how to reach them, and leaves the
 * question of who owns it to the two of them. A host that picked a winner
 * would be the central coordinator this architecture exists to avoid.
 */

export interface OverlapNotice {
    readonly recipientId: string
    readonly text: string
}

const MAX_NAMED_PEERS = 4

export function noticesForOverlap(
    path: string,
    agents: readonly string[],
): OverlapNotice[] {
    const involved = [...new Set(agents.map((id) => id.trim()).filter(Boolean))]
    if (!path.trim() || involved.length < 2) return []

    return involved.map((recipientId) => ({
        recipientId,
        text: render(path.trim(), recipientId, involved.filter((id) => id !== recipientId)),
    }))
}

function render(path: string, recipientId: string, peers: readonly string[]): string {
    const named = peers.slice(0, MAX_NAMED_PEERS).join(", ")
    const rest = peers.length > MAX_NAMED_PEERS
        ? ` and ${peers.length - MAX_NAMED_PEERS} other agent(s)`
        : ""
    return [
        `[baro] You are not alone in ${path}.`,
        "",
        `${named}${rest} ${peers.length === 1 ? "is" : "are"} writing it too, right now.`,
        "You are each in your own worktree, so neither of you can see the other's",
        "version until it merges — and only one of them will merge cleanly.",
        "",
        "Settle it between you: agree who owns the file, or split it so you touch",
        `different parts. You can reach ${peers.length === 1 ? "them" : "any of them"} directly with agent-collab.`,
        `Whoever gives it up should stop writing ${path} now rather than at the merge.`,
    ].join("\n")
}
