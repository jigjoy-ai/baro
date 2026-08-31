import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"

/** WorktreeManager keys its base dir off the run id, so a fixed id is a fixed
 * path: two lanes sharing one would inherit each other's filesystem state. */
export function uniqueRunId(prefix: string): string {
    return `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`
}

export function worktreeRunRoot(runId: string): string {
    return join(tmpdir(), "baro-worktrees", runId)
}

function tryGit(cwd: string, args: string[]): string | null {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            timeout: 30_000,
            stdio: ["ignore", "pipe", "ignore"],
        })
    } catch {
        return null
    }
}

function registeredWorktreesUnder(repoDir: string, root: string): string[] {
    const listing = tryGit(repoDir, ["worktree", "list", "--porcelain"])
    if (listing === null) return []
    return listing
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim())
        .filter((path) => path === root || path.startsWith(root + sep))
}

/** Best-effort and idempotent, so it is safe in a `finally` reached after a
 * partial create or a rollback where none of these entries may exist. */
export async function removeWorktreeRun(
    repoDir: string | null,
    runId: string,
): Promise<void> {
    const root = worktreeRunRoot(runId)
    if (repoDir !== null) {
        for (const path of registeredWorktreesUnder(repoDir, root)) {
            tryGit(repoDir, ["worktree", "remove", "--force", path])
        }
    }
    try {
        rmSync(root, { recursive: true, force: true })
    } catch { /* best-effort fixture cleanup */ }
    if (repoDir === null) return
    tryGit(repoDir, ["worktree", "prune"])
    const branches = tryGit(repoDir, [
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/baro-wt/${runId}/`,
    ])
    for (const branch of (branches ?? "").split("\n")) {
        if (branch.trim() !== "") tryGit(repoDir, ["branch", "-D", branch.trim()])
    }
}
