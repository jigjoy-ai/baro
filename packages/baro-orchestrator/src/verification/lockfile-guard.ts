/**
 * Baro's own dependency refresh must not edit the tree it is judging. A repo
 * whose committed lockfile lags its package.json gets that lockfile rewritten
 * by `npm install`; in a story worktree that read as the story changing
 * JavaScript, so every gate ran the 10-minute TypeScript suite. A lockfile
 * that matched HEAD before the refresh is restored after it, unless a
 * manifest changed too: then the lock update belongs to the change.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]

function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 15_000,
        })
    } catch {
        return null
    }
}

/** Tracked lockfiles identical to HEAD, when no package.json differs from HEAD. */
export function pristineLockfiles(cwd: string): string[] {
    const changed = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"])
    if (changed === null) return []
    const paths = changed
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(3))
    if (paths.some((path) => path === "package.json" || path.endsWith("/package.json"))) return []
    return LOCKFILES.filter(
        (file) =>
            existsSync(join(cwd, file)) &&
            !paths.includes(file) &&
            git(cwd, ["ls-files", "--error-unmatch", "--", file]) !== null,
    )
}

/** Puts back the pristine lockfiles the refresh rewrote; returns their names. */
export function restoreLockfiles(cwd: string, pristine: readonly string[]): string[] {
    const restored: string[] = []
    for (const file of pristine) {
        if (git(cwd, ["diff", "--quiet", "HEAD", "--", file]) !== null) continue
        if (git(cwd, ["checkout", "HEAD", "--", file]) !== null) restored.push(file)
    }
    return restored
}
