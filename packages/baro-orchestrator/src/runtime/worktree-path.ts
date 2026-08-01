/**
 * One directory, both names macOS gives it.
 *
 * Agents report `/private/var/folders/…` because their tools resolve the
 * symlink; the worktree is recorded as `/var/folders/…`. Any host code that
 * compares an agent-reported path against a recorded root has to accept both,
 * or it silently matches nothing — which is how merge awareness ran for three
 * runs reporting zero collisions.
 */
export function pathAliases(root: string): string[] {
    if (root.startsWith("/private/")) return [root, root.slice("/private".length)]
    if (root.startsWith("/")) return [root, `/private${root}`]
    return [root]
}

/** The path as it reads from the repository root, under either name. */
export function repositoryRelativePath(root: string | null, path: string): string {
    if (!root) return path
    for (const candidate of pathAliases(root)) {
        if (path.startsWith(candidate)) {
            return path.slice(candidate.length).replace(/^[/\\]+/u, "")
        }
    }
    return path
}
