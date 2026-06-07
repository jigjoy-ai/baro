/**
 * Per-story git worktree isolation (issue #50). Each story runs in its own
 * `git worktree` on branch `baro-wt/<runId>/<storyId>` off the run-branch
 * HEAD, commits in isolation, and merges back onto the run branch on success.
 * Replaces the old shared-tree behaviour where parallel `git add -A` swept up
 * siblings' in-flight edits.
 *
 * All state-mutating ops acquire the shared {@link GitGate} so they never race
 * the per-story push/pull in git.ts. Agent commits inside a worktree touch
 * only that worktree's private index and need no serialization.
 */

import { execFile } from "child_process"
import { existsSync, rmSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { promisify } from "util"

import { GitGate } from "./git.js"

const exec = promisify(execFile)

// A fresh worktree only checks out git-tracked files, so it has no
// node_modules. Symlink these dependency dirs from the repo root (best-effort)
// so builds/tests resolve; they're read-mostly, so sharing is safe.
const LINKED_DEP_DIRS = ["node_modules", ".venv", "vendor"] as const

export interface WorktreeManagerOptions {
    /** Symlink dependency dirs (node_modules, …) into each worktree. Default true. */
    linkDepDirs?: boolean
    /** Diagnostic logger (defaults to stderr). */
    onLog?: (line: string) => void
}

/**
 * Manages the lifecycle of per-story git worktrees for a single run.
 * One instance per orchestrate() call; the run id scopes branch + dir names
 * so concurrent runs never collide. (Crashed prior runs leave their worktree
 * dirs behind; `git worktree prune` reclaims their admin entries once the
 * dirs are gone, but their branch refs are not swept — they're inert and
 * harmless since each run uses a fresh id.)
 */
export class WorktreeManager {
    private readonly paths = new Map<string, string>()
    private readonly baseDir: string
    private readonly linkDepDirs: boolean
    private readonly log: (line: string) => void

    constructor(
        private readonly repoRoot: string,
        private readonly gate: GitGate,
        private readonly runId: string,
        opts: WorktreeManagerOptions = {},
    ) {
        this.baseDir = join(tmpdir(), "baro-worktrees", runId)
        this.linkDepDirs = opts.linkDepDirs ?? true
        this.log =
            opts.onLog ?? ((line) => process.stderr.write(`[worktree] ${line}\n`))
    }

    private branchOf(storyId: string): string {
        return `baro-wt/${this.runId}/${sanitize(storyId)}`
    }

    private pathOf(storyId: string): string {
        return join(this.baseDir, sanitize(storyId))
    }

    /**
     * Create an isolated worktree for a story, branched off the current
     * run-branch HEAD. Returns the worktree path, or null on any failure so
     * the caller can fall back to the shared repo cwd (preserving the old
     * behavior rather than failing the story).
     */
    async create(storyId: string): Promise<string | null> {
        const release = await this.gate.acquire()
        try {
            const branch = this.branchOf(storyId)
            const path = this.pathOf(storyId)
            // Defensive: a leftover dir/branch from a crash would make
            // `worktree add` fail. Best-effort clear before adding.
            await this.removeWorktreeQuiet(path)
            await this.deleteBranchQuiet(branch)

            await exec(
                "git",
                ["worktree", "add", "-b", branch, path, "HEAD"],
                { cwd: this.repoRoot },
            )
            this.paths.set(storyId, path)
            if (this.linkDepDirs) this.symlinkDepDirs(path)
            this.log(`created ${branch} at ${path}`)
            return path
        } catch (e) {
            this.log(
                `could not create worktree for ${storyId} (${errMsg(e)}); ` +
                    `falling back to shared tree`,
            )
            return null
        } finally {
            release()
        }
    }

    /**
     * Merge a passed story's branch onto the run branch. Returns true if a
     * worktree merge happened, false if the story had no worktree (create()
     * fell back to the shared tree). On any merge failure, retries once with
     * `-X theirs` (the merging story wins). Throws — leaving the run branch
     * clean (`merge --abort`) — only when even that can't resolve it; the
     * caller must then preserve the branch rather than discard the work.
     */
    async mergeBack(storyId: string): Promise<boolean> {
        const path = this.paths.get(storyId)
        if (!path) return false
        const branch = this.branchOf(storyId)
        const release = await this.gate.acquire()
        try {
            await this.autoCommitLeftovers(storyId, path)
            const msg = `baro: merge story ${storyId}`
            try {
                await exec("git", ["merge", "--no-ff", "-m", msg, branch], {
                    cwd: this.repoRoot,
                })
                return true
            } catch {
                // Any first-merge failure (content, modify/delete, rename, …)
                // → abort and retry favouring the merging story.
                const conflicts = await this.conflictedPaths()
                await execQuiet("git", ["merge", "--abort"], this.repoRoot)
                this.log(
                    `WARNING: story ${storyId} conflicts with already-merged work` +
                        (conflicts.length ? ` on [${conflicts.join(", ")}]` : "") +
                        `; auto-resolving with -X theirs (this story wins)`,
                )
                try {
                    await exec(
                        "git",
                        ["merge", "--no-ff", "-X", "theirs", "-m", msg, branch],
                        { cwd: this.repoRoot },
                    )
                    return true
                } catch (e) {
                    await execQuiet("git", ["merge", "--abort"], this.repoRoot)
                    throw new Error(
                        `could not merge story ${storyId} even with -X theirs: ${errMsg(e)}`,
                    )
                }
            }
        } finally {
            release()
        }
    }

    /** Remove a story's worktree + branch (after merge-back, or on failure). */
    async cleanup(storyId: string): Promise<void> {
        const path = this.paths.get(storyId)
        const branch = this.branchOf(storyId)
        const release = await this.gate.acquire()
        try {
            if (path) {
                await this.removeWorktreeQuiet(path)
                this.paths.delete(storyId)
            }
            await this.deleteBranchQuiet(branch)
        } finally {
            release()
        }
    }

    /** Remove every worktree + branch this manager created, plus its temp dir. */
    async cleanupAll(): Promise<void> {
        const release = await this.gate.acquire()
        try {
            for (const [storyId, path] of this.paths) {
                await this.removeWorktreeQuiet(path)
                await this.deleteBranchQuiet(this.branchOf(storyId))
            }
            this.paths.clear()
            await execQuiet("git", ["worktree", "prune"], this.repoRoot)
            rmSyncQuiet(this.baseDir)
        } finally {
            release()
        }
    }

    /**
     * Reclaim worktree admin entries whose dirs are already gone
     * (`git worktree prune`) and delete any branches under THIS run id
     * (defensive re-entrancy guard — ids are unique per process, so this
     * does not touch a concurrent run's worktrees).
     */
    async cleanupStaleOnStart(): Promise<void> {
        const release = await this.gate.acquire()
        try {
            await execQuiet("git", ["worktree", "prune"], this.repoRoot)
            const prefix = `baro-wt/${this.runId}/`
            let branches: string[] = []
            try {
                const { stdout } = await exec(
                    "git",
                    ["branch", "--list", `${prefix}*`, "--format=%(refname:short)"],
                    { cwd: this.repoRoot },
                )
                branches = stdout.split("\n").map((l) => l.trim()).filter(Boolean)
            } catch {
                /* no matching branches */
            }
            for (const branch of branches) {
                await this.deleteBranchQuiet(branch)
            }
        } finally {
            release()
        }
    }

    // ── internals ────────────────────────────────────────────────────

    private symlinkDepDirs(worktreePath: string): void {
        for (const dir of LINKED_DEP_DIRS) {
            const src = join(this.repoRoot, dir)
            const dest = join(worktreePath, dir)
            if (!existsSync(src) || existsSync(dest)) continue
            try {
                symlinkSync(src, dest, "dir")
            } catch (e) {
                this.log(`could not symlink ${dir} into worktree (${errMsg(e)})`)
            }
        }
    }

    /**
     * Commit work the agent edited but didn't commit, so it isn't lost on
     * cleanup (passing is signalled by the agent, not by a commit existing).
     * `git add -A` respects .gitignore, so symlinked node_modules etc. are safe.
     */
    private async autoCommitLeftovers(
        storyId: string,
        worktreePath: string,
    ): Promise<void> {
        let dirty = false
        try {
            const { stdout } = await exec("git", ["status", "--porcelain"], {
                cwd: worktreePath,
            })
            dirty = stdout.trim().length > 0
        } catch {
            return
        }
        if (!dirty) return
        this.log(
            `WARNING: story ${storyId} passed with uncommitted changes; ` +
                `auto-committing them before merge`,
        )
        await execQuiet("git", ["add", "-A"], worktreePath)
        // Never commit the symlinked dep dirs, even if the repo doesn't
        // .gitignore them — they'd land as broken absolute-path symlinks.
        await execQuiet("git", ["reset", "-q", "--", ...LINKED_DEP_DIRS], worktreePath)
        await execQuiet(
            "git",
            ["commit", "-m", `baro: auto-commit uncommitted work for story ${storyId}`],
            worktreePath,
        )
    }

    private async conflictedPaths(): Promise<string[]> {
        try {
            const { stdout } = await exec(
                "git",
                ["diff", "--name-only", "--diff-filter=U"],
                { cwd: this.repoRoot },
            )
            return stdout.split("\n").map((l) => l.trim()).filter(Boolean)
        } catch {
            return []
        }
    }

    private async removeWorktreeQuiet(path: string): Promise<void> {
        await execQuiet("git", ["worktree", "remove", "--force", path], this.repoRoot)
        // If git refused (e.g. a still-running subprocess), force-remove the
        // dir and prune the now-dangling administrative entry.
        if (existsSync(path)) {
            rmSyncQuiet(path)
            await execQuiet("git", ["worktree", "prune"], this.repoRoot)
        }
    }

    private async deleteBranchQuiet(branch: string): Promise<void> {
        await execQuiet("git", ["branch", "-D", branch], this.repoRoot)
    }
}

// ── module helpers ───────────────────────────────────────────────────

function sanitize(storyId: string): string {
    // Story ids are short slugs (S1, S2, …) but guard against anything that
    // would break a ref name or a path segment.
    return storyId.replace(/[^A-Za-z0-9._-]/g, "_")
}

async function execQuiet(
    cmd: string,
    args: readonly string[],
    cwd: string,
): Promise<void> {
    try {
        await exec(cmd, args, { cwd })
    } catch {
        /* best-effort */
    }
}

function rmSyncQuiet(path: string): void {
    try {
        rmSync(path, { recursive: true, force: true })
    } catch {
        /* best-effort */
    }
}

function errMsg(e: unknown): string {
    return (e as Error)?.message ?? String(e)
}
