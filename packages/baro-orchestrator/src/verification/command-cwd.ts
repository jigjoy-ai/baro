/**
 * Where a verification command actually runs, and how long the one retry waits.
 *
 * A spec cwd captured before the merge can name a story worktree that
 * `git worktree remove` has since deleted. Retrying against an absent path
 * only burns the budget, so resolution happens once, here, and the caller
 * treats a missing directory as terminal.
 */

import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { canonicalPath } from "../integration/integration-worktree.js"
import { pathAliases } from "../runtime/worktree-path.js"

export const RETRY_BACKOFF_MS = 2000

/** Unref'd so a pending backoff never keeps the process alive past the gate. */
export function defaultSleep(ms: number): Promise<void> {
    return new Promise<void>((resolveSleep) => {
        const timer: unknown = setTimeout(resolveSleep, ms)
        ;(timer as { unref?: () => void }).unref?.()
    })
}

function strictlyUnder(root: string, candidate: string): boolean {
    const rel = relative(root, candidate)
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function sameDirectory(a: string, b: string): boolean {
    return a === b || pathAliases(a).includes(b)
}

/** `<tmpdir>/baro-worktrees/<runId>/<agentId>`, only when it is runCwd's sibling. */
function siblingWorktreeRoot(runCwd: string, candidate: string): string | null {
    const parts = candidate.split(sep)
    const at = parts.lastIndexOf("baro-worktrees")
    if (at < 0 || parts.length < at + 3) return null
    const root = parts.slice(0, at + 3).join(sep)
    return sameDirectory(dirname(root), dirname(runCwd)) ? root : null
}

export function resolveCommandCwd(
    runCwd: string,
    commandCwd: string | undefined,
): string {
    if (commandCwd === undefined) return runCwd
    const resolved = resolve(commandCwd)
    const runResolved = resolve(runCwd)
    if (sameDirectory(runResolved, resolved) || strictlyUnder(runResolved, resolved)) {
        return commandCwd
    }
    // /var vs /private/var is the same directory under two names.
    const canonical = canonicalPath(resolved)
    const runCanonical = canonicalPath(runResolved)
    if (sameDirectory(runCanonical, canonical) || strictlyUnder(runCanonical, canonical)) {
        return commandCwd
    }
    const worktreeRoot = siblingWorktreeRoot(runCanonical, canonical)
    if (worktreeRoot) {
        const remapped = join(runCwd, relative(worktreeRoot, canonical))
        if (existsSync(remapped)) return remapped
    }
    return runCwd
}
