/**
 * Git helpers via direct git CLI calls (no library dependency).
 *
 * Concurrency: writes to git state (push, pull --rebase) must serialize
 * across stories — GitGate is the async mutex-of-one for that.
 */

import {
    isRepositoryCommandTimeout,
    runRepositoryCommand as exec,
} from "./repository-command.js"

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
        if (isRepositoryCommandTimeout(e)) throw e
        throw new Error(
            `Failed to get branch: ${(e as Error)?.message ?? String(e)}`,
        )
    }
}

/**
 * Greenfield bootstrap: an EMPTY directory (nothing but OS droppings)
 * becomes a git repository with one empty root commit, so branching,
 * worktree isolation and merging work for brand-new projects. Non-empty
 * non-git directories are left alone — initializing someone's Downloads
 * folder is worse than degraded git-less mode.
 */
export async function ensureGreenfieldRepo(
    cwd: string,
    onLog?: (line: string) => void,
): Promise<boolean> {
    if (await isInsideGitRepo(cwd)) return false
    const { readdir } = await import("node:fs/promises")
    const entries = (await readdir(cwd)).filter(
        (name) =>
            name !== ".DS_Store" &&
            name !== "Thumbs.db" &&
            // baro's own pre-branch artifacts don't make a directory a project.
            name !== "prd.json" &&
            name !== "baro.lock" &&
            name !== ".baro",
    )
    if (entries.length > 0) return false
    await exec("git", ["init"], { cwd })
    try {
        await exec(
            "git",
            ["commit", "--allow-empty", "-m", "baro: initialize repository"],
            { cwd },
        )
    } catch {
        // No committer identity configured — use a repo-local fallback so
        // the root commit still lands without touching global config.
        await exec(
            "git",
            [
                "-c",
                "user.name=baro",
                "-c",
                "user.email=baro@localhost",
                "commit",
                "--allow-empty",
                "-m",
                "baro: initialize repository",
            ],
            { cwd },
        )
    }
    onLog?.("[git] greenfield: initialized a fresh repository")
    return true
}

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
    try {
        await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd })
        return true
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
        return false
    }
}

export async function getHeadSha(cwd: string): Promise<string | null> {
    try {
        const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd })
        return stdout.trim() || null
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
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
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
        try {
            await exec("git", ["checkout", branchName], { cwd })
        } catch (e) {
            if (isRepositoryCommandTimeout(e)) throw e
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
        } catch (error) {
            if (isRepositoryCommandTimeout(error)) throw error
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
        } catch (error) {
            // no tracked changes to stash; continue
            if (isRepositoryCommandTimeout(error)) throw error
        }

        try {
            // --rebase=merges so per-story `--no-ff` merge commits survive
            // the replay instead of being flattened or dropped.
            await exec("git", ["pull", "--rebase=merges", "origin", branch], { cwd })
            onLog?.("[git] pull ok")
        } catch (error) {
            onLog?.("[git] pull conflict, continuing without pull")
            await execSafe("git", ["rebase", "--abort"], { cwd })
            if (isRepositoryCommandTimeout(error)) throw error
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
                if (isRepositoryCommandTimeout(e)) throw e
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
                if (isRepositoryCommandTimeout(e)) throw e
                lastError = extractStderr(e)
            }

            if (attempt === max) break

            // Only a remote that moved can be reconciled. Issue #106: three
            // runs died on "Rebase conflict detected" with the base unmoved —
            // a failed push of any kind fell into a pull, and a pull failing
            // for any reason (dirty tree left by a timed-out step, no remote
            // branch yet, network) was reported as a conflict and ended it.
            const summary = lastError.split("\n")[0]?.trim() || lastError
            if (!(await hasRemoteBranch(options.cwd, branch))) {
                options.onLog?.(
                    `[git] push failed (attempt ${attempt}/${max}) with no remote branch to reconcile: ${summary}; retrying`,
                )
                continue
            }
            options.onLog?.(
                `[git] push rejected (attempt ${attempt}/${max}): ${summary}; reconciling with origin/${branch}`,
            )
            const outcome = await rebaseOntoRemote(options.cwd, branch, options.onLog)
            if (outcome.status === "conflict") {
                throw new Error(
                    `Rebase conflict against origin/${branch}@${outcome.targetSha.slice(0, 8)}` +
                        ` (local HEAD ${outcome.headSha.slice(0, 8)}): ` +
                        `${outcome.paths.length > 0 ? outcome.paths.join(", ") : outcome.detail}; push skipped`,
                )
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

type RebaseOutcome =
    | { status: "rebased" }
    | { status: "failed"; detail: string }
    | {
          status: "conflict"
          targetSha: string
          headSha: string
          paths: string[]
          detail: string
      }

/**
 * Rebase the local branch onto the freshly fetched remote head. The target sha
 * and any conflicting paths are logged, so the next occurrence is diagnosable
 * from the run log alone. --autostash carries tracked edits a timed-out step
 * may have left behind; --rebase-merges keeps per-story --no-ff merges.
 */
async function rebaseOntoRemote(
    cwd: string,
    branch: string,
    onLog?: (line: string) => void,
): Promise<RebaseOutcome> {
    let targetSha = "unknown"
    let headSha = "unknown"
    try {
        await exec("git", ["fetch", "origin", branch], { cwd })
        targetSha = (await exec("git", ["rev-parse", "FETCH_HEAD"], { cwd })).stdout.trim()
        headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim()
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
        const detail = extractStderr(error).split("\n")[0]?.trim() ?? ""
        onLog?.(`[git] fetch origin/${branch} failed: ${detail}`)
        return { status: "failed", detail }
    }
    onLog?.(
        `[git] rebasing ${headSha.slice(0, 8)} onto origin/${branch}@${targetSha.slice(0, 8)}`,
    )
    try {
        await exec(
            "git",
            ["rebase", "--rebase-merges", "--autostash", "FETCH_HEAD"],
            { cwd },
        )
        onLog?.(`[git] rebased onto origin/${branch}@${targetSha.slice(0, 8)}`)
        return { status: "rebased" }
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
        const stderr = extractStderr(error)
        const detail = stderr.split("\n")[0]?.trim() ?? ""
        const paths = await unmergedPaths(cwd)
        await execSafe("git", ["rebase", "--abort"], { cwd })
        if (paths.length > 0 || /CONFLICT/i.test(stderr)) {
            onLog?.(
                `[git] rebase conflict against origin/${branch}@${targetSha.slice(0, 8)}: ` +
                    `${paths.length > 0 ? paths.join(", ") : detail}`,
            )
            return { status: "conflict", targetSha, headSha, paths, detail }
        }
        onLog?.(`[git] rebase failed without a conflict: ${detail}; retrying push as is`)
        return { status: "failed", detail }
    }
}

async function unmergedPaths(cwd: string): Promise<string[]> {
    try {
        const { stdout } = await exec(
            "git",
            ["diff", "--name-only", "--diff-filter=U"],
            { cwd },
        )
        return stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
        return []
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
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
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
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
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
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
        // Ordinary non-zero results remain best-effort at these call sites.
    }
}

function extractStderr(e: unknown): string {
    if (e && typeof e === "object" && "stderr" in e) {
        const s = (e as { stderr: unknown }).stderr
        if (typeof s === "string") return s.trim()
    }
    return e instanceof Error ? e.message : String(e)
}
