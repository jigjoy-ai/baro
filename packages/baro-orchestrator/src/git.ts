/**
 * Git helpers — port of crates/baro-tui/src/git.rs. Direct git CLI
 * calls (no library dependency), matching the original behavior.
 *
 * Concurrency: writes to git state (push, pull --rebase) must serialize
 * across stories. The `gitGate` helper provides a simple async
 * mutex-of-one for this.
 */

import { execFile } from "child_process"
import { promisify } from "util"

const exec = promisify(execFile)

const GIT_PUSH_MAX_ATTEMPTS = 3

export interface GitFileStats {
    created: number
    modified: number
}

export interface GitPushOptions {
    cwd: string
    maxAttempts?: number
    onLog?: (line: string) => void
}

// ─── Mutex-of-one for serialized git writes ─────────────────────────

type Releaser = () => void

export class GitGate {
    private chain: Promise<void> = Promise.resolve()

    async acquire(): Promise<Releaser> {
        let release!: Releaser
        const next = new Promise<void>((resolve) => {
            release = resolve
        })
        const wait = this.chain
        this.chain = this.chain.then(() => next)
        await wait
        return release
    }
}

// ─── Branch helpers ─────────────────────────────────────────────────

export async function getCurrentBranch(cwd: string): Promise<string> {
    try {
        const { stdout } = await exec("git", ["branch", "--show-current"], { cwd })
        const branch = stdout.trim()
        if (!branch) {
            throw new Error("could not determine current branch")
        }
        return branch
    } catch (e) {
        throw new Error(
            `Failed to get branch: ${(e as Error)?.message ?? String(e)}`,
        )
    }
}

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
    try {
        await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd })
        return true
    } catch {
        return false
    }
}

export async function getHeadSha(cwd: string): Promise<string | null> {
    try {
        const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd })
        return stdout.trim() || null
    } catch {
        return null
    }
}

/**
 * Create a new branch and best-effort push it with upstream tracking.
 * If the branch already exists, check it out instead. Push failures are
 * non-fatal (no remote yet, etc).
 */
export async function createOrCheckoutBranch(
    cwd: string,
    branchName: string,
    onLog?: (line: string) => void,
): Promise<void> {
    // Strip accidental double-prefixes ("baro/baro/foo" → "baro/foo").
    // Happens when the caller is already on a baro-prefixed branch from
    // a previous run and prepends "baro/" again to the PRD-supplied name.
    while (branchName.startsWith("baro/baro/")) {
        branchName = branchName.slice("baro/".length)
    }
    try {
        await exec("git", ["checkout", "-b", branchName], { cwd })
    } catch {
        try {
            await exec("git", ["checkout", branchName], { cwd })
        } catch (e) {
            throw new Error(
                `Failed to checkout branch '${branchName}': ${(e as Error)?.message ?? String(e)}`,
            )
        }
    }

    try {
        await exec("git", ["push", "-u", "origin", branchName], { cwd })
        onLog?.(`[git] pushed -u origin ${branchName}`)
    } catch (e) {
        onLog?.(
            `[git] push -u origin ${branchName} failed (best-effort): ${(e as Error)?.message ?? String(e)}`,
        )
    }
}

// ─── Pull / rebase ──────────────────────────────────────────────────

export async function safePullRebase(
    cwd: string,
    onLog?: (line: string) => void,
    gate?: GitGate,
): Promise<void> {
    const release = gate ? await gate.acquire() : null
    try {
        if (!(await hasRemoteOrigin(cwd))) {
            onLog?.("[git] no remote, skipping pull")
            return
        }

        let branch: string
        try {
            branch = await getCurrentBranch(cwd)
        } catch {
            onLog?.("[git] no branch, skipping pull")
            return
        }

        if (!(await hasRemoteBranch(cwd, branch))) {
            onLog?.("[git] remote branch not found, skipping pull")
            return
        }

        onLog?.("[git] pulling latest...")

        // Stash tracked edits (e.g. prd.json) before rebasing. We use
        // `stash create` (returns a SHA, does NOT push onto the named
        // stack) instead of `stash push`/`stash pop` because concurrent
        // story-passed callbacks would otherwise pop each other's
        // entries and silently lose work. Untracked files are
        // intentionally NOT stashed — they can't conflict with a rebase,
        // and including them previously caused user-managed files (e.g.
        // BARO_GOAL.md) to vanish whenever stash apply hit a conflict.
        let stashSha: string | null = null
        try {
            const { stdout } = await exec("git", ["stash", "create"], { cwd })
            stashSha = stdout.trim() || null
            if (stashSha) {
                await execSafe("git", ["reset", "--hard", "HEAD"], { cwd })
            }
        } catch {
            // no tracked changes to stash; continue
        }

        try {
            await exec("git", ["pull", "--rebase", "origin", branch], { cwd })
            onLog?.("[git] pull ok")
        } catch {
            onLog?.("[git] pull conflict, continuing without pull")
            await execSafe("git", ["rebase", "--abort"], { cwd })
        }

        if (stashSha) {
            try {
                await exec("git", ["stash", "apply", stashSha], { cwd })
            } catch (e) {
                onLog?.(
                    `[git] could not re-apply stashed edits (sha ${stashSha.slice(0, 8)}): ${
                        (e as Error)?.message ?? String(e)
                    }`,
                )
            }
        }
    } finally {
        release?.()
    }
}

// ─── Push with retry ────────────────────────────────────────────────

export async function gitPushWithRetry(
    gate: GitGate,
    options: GitPushOptions,
): Promise<void> {
    const release = await gate.acquire()
    try {
        if (!(await hasRemoteOrigin(options.cwd))) {
            options.onLog?.("[git] no remote, skipping push")
            return
        }

        const branch = await getCurrentBranch(options.cwd)
        const max = options.maxAttempts ?? GIT_PUSH_MAX_ATTEMPTS
        let lastError = ""

        // Only emit "pushing..." once at the start. Per-attempt lines
        // turn into a wall of noise when many stories push back-to-back
        // — the user just wants to see one line per push, with details
        // only when the final attempt fails.
        options.onLog?.("[git] pushing...")
        for (let attempt = 1; attempt <= max; attempt++) {
            try {
                await exec("git", ["push", "origin", branch], { cwd: options.cwd })
                options.onLog?.("[git] push ok")
                return
            } catch (e) {
                lastError = extractStderr(e)
            }

            if (attempt === max) break

            // One-liner per retry instead of dumping the full stderr
            // each time. The full stderr is logged exactly once at the
            // end if every attempt failed.
            options.onLog?.(
                `[git] push rejected (attempt ${attempt}/${max}), pulling and retrying...`,
            )
            try {
                await exec("git", ["pull", "--rebase", "origin", branch], {
                    cwd: options.cwd,
                })
            } catch {
                await execSafe("git", ["rebase", "--abort"], { cwd: options.cwd })
                options.onLog?.("[git] conflict detected, skipping")
                throw new Error("Rebase conflict detected, push skipped")
            }
        }

        const compactErr = lastError.split("\n")[0]?.trim() || lastError
        options.onLog?.(
            `[git] push failed after ${max} attempts: ${compactErr}`,
        )
        throw new Error(`Push failed after ${max} attempts: ${lastError}`)
    } finally {
        release()
    }
}

// ─── File stats ─────────────────────────────────────────────────────

export async function getGitFileStats(
    cwd: string,
    baseSha?: string | null,
): Promise<GitFileStats> {
    const args = baseSha
        ? ["diff", "--name-status", baseSha, "HEAD"]
        : ["diff", "--name-status", "HEAD~1", "HEAD"]
    try {
        const { stdout } = await exec("git", args, { cwd })
        let created = 0
        let modified = 0
        for (const line of stdout.split("\n")) {
            const ch = line.charAt(0)
            if (ch === "A") created += 1
            else if (ch === "M" || ch === "R") modified += 1
        }
        return { created, modified }
    } catch {
        return { created: 0, modified: 0 }
    }
}

// ─── Internal helpers ───────────────────────────────────────────────

async function hasRemoteOrigin(cwd: string): Promise<boolean> {
    try {
        await exec("git", ["remote", "get-url", "origin"], { cwd })
        return true
    } catch {
        return false
    }
}

async function hasRemoteBranch(cwd: string, branch: string): Promise<boolean> {
    try {
        const { stdout } = await exec(
            "git",
            ["ls-remote", "--heads", "origin", branch],
            { cwd },
        )
        return stdout.trim().length > 0
    } catch {
        return false
    }
}

async function execSafe(
    cmd: string,
    args: readonly string[],
    opts: { cwd: string },
): Promise<void> {
    try {
        await exec(cmd, args, opts)
    } catch {
        // best-effort, swallow
    }
}

function extractStderr(e: unknown): string {
    if (e && typeof e === "object" && "stderr" in e) {
        const s = (e as { stderr: unknown }).stderr
        if (typeof s === "string") return s.trim()
    }
    return e instanceof Error ? e.message : String(e)
}
