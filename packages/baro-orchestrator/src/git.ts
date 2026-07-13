/**
 * Git helpers via direct git CLI calls (no library dependency).
 *
 * Concurrency: writes to git state (push, pull --rebase) must serialize
 * across stories — GitGate is the async mutex-of-one for that.
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
    push = true,
): Promise<void> {
    // Strip accidental double-prefixes ("baro/baro/foo") — a caller already
    // on a baro-prefixed branch can prepend "baro/" again.
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

    if (!push) {
        onLog?.(`[git] local-only; not pushing ${branchName}`)
        return
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

        // Stash tracked edits before rebasing via `stash create` (SHA, not
        // the named stack) — with `stash push`/`pop`, concurrent story-passed
        // callbacks would pop each other's entries and silently lose work.
        // Untracked files are deliberately NOT stashed: they can't conflict
        // with a rebase, and stashing them made user-managed files vanish
        // whenever stash apply hit a conflict.
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
            // --rebase=merges so per-story `--no-ff` merge commits survive
            // the replay instead of being flattened or dropped.
            await exec("git", ["pull", "--rebase=merges", "origin", branch], { cwd })
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

        // One line per push; full stderr only when the final attempt fails.
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

            options.onLog?.(
                `[git] push rejected (attempt ${attempt}/${max}), pulling and retrying...`,
            )
            try {
                // --rebase=merges: preserve per-story `--no-ff` merge
                // commits when reconciling a rejected push.
                await exec("git", ["pull", "--rebase=merges", "origin", branch], {
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

/** Best-effort number of commits introduced after an immutable run base. */
export async function getCommitCount(
    cwd: string,
    baseSha: string,
    toSha = "HEAD",
): Promise<number> {
    try {
        const { stdout } = await exec(
            "git",
            ["rev-list", "--count", `${baseSha}..${toSha}`],
            { cwd },
        )
        const count = Number.parseInt(stdout.trim(), 10)
        return Number.isSafeInteger(count) && count >= 0 ? count : 0
    } catch {
        return 0
    }
}

export interface DiffFile {
    path: string
    added: number
    removed: number
}

export interface StoryDiffResult {
    files: DiffFile[]
    /** Unified diff text, capped so the stdout event stream stays small. */
    diff: string
}

/** Max diff lines carried in a story_diff event; the rest is truncated. */
const DIFF_LINE_CAP = 180

/** Best-effort — returns empty on any git failure. */
export async function getDiff(
    cwd: string,
    fromSha: string,
    toSha = "HEAD",
): Promise<StoryDiffResult> {
    const files: DiffFile[] = []
    try {
        const { stdout } = await exec("git", ["diff", "--numstat", fromSha, toSha], { cwd })
        for (const line of stdout.split("\n")) {
            if (!line.trim()) continue
            const parts = line.split("\t")
            if (parts.length < 3) continue
            const [a, r] = parts
            const path = parts.slice(2).join("\t")
            files.push({
                path,
                added: a === "-" ? 0 : parseInt(a, 10) || 0,
                removed: r === "-" ? 0 : parseInt(r, 10) || 0,
            })
        }
    } catch {
        // ignore
    }
    let diff = ""
    try {
        const { stdout } = await exec("git", ["diff", fromSha, toSha], {
            cwd,
            maxBuffer: 16 * 1024 * 1024,
        })
        const lines = stdout.split("\n")
        diff =
            lines.length > DIFF_LINE_CAP
                ? lines.slice(0, DIFF_LINE_CAP).join("\n") +
                  `\n… (${lines.length - DIFF_LINE_CAP} more lines truncated)`
                : stdout
    } catch {
        // ignore
    }
    return { files, diff }
}

export async function hasRemoteOrigin(cwd: string): Promise<boolean> {
    try {
        await exec("git", ["remote", "get-url", "origin"], { cwd })
        return true
    } catch {
        return false
    }
}

/**
 * Keep baro's own working artifacts (prd.json, generated context docs, ADRs)
 * out of the user's diff/PR. Repo-local .git/info/exclude — never the user's
 * tracked .gitignore — and only affects UNTRACKED files, so a repo that
 * already tracks e.g. CLAUDE.md is untouched. Worktrees share the common
 * dir's info/exclude, so one write covers story worktrees too.
 */
export async function excludeBaroArtifacts(cwd: string): Promise<void> {
    try {
        const { appendFileSync } = await import("fs")
        const patterns = ["prd.json", "adr/", "AGENTS.md", "CLAUDE.md"]
        appendFileSync(
            `${cwd}/.git/info/exclude`,
            `\n# baro: run artifacts (never commit into the user's branch)\n${patterns.join("\n")}\n`,
        )
    } catch {
        /* best-effort */
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
