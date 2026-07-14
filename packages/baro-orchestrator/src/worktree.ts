/**
 * Per-story git worktree isolation (issue #50): each story works on branch
 * `baro-wt/<runId>/<storyId>` in its own worktree and merges back on success,
 * so parallel `git add -A` can't sweep up siblings' in-flight edits.
 * State-mutating ops acquire the shared {@link GitGate} so they never race
 * the per-story push/pull in git.ts; agent commits inside a worktree touch
 * only its private index and need no serialization.
 */

import { execFile } from "child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { promisify } from "util"

import { GitGate } from "./git.js"

const exec = promisify(execFile)

// A fresh worktree has no installed dependency artifacts, so dep dirs are
// symlinked to one shared location: one story's `npm install` (pip/composer/…)
// is visible to every other, like the old shared workspace. Manifest-driven
// discovery covers monorepo subdirs (e.g. `frontend/node_modules`).
const DEP_DIR_BY_MANIFEST: Record<string, string> = {
    "package.json": "node_modules",
    "pnpm-workspace.yaml": "node_modules",
    "pyproject.toml": ".venv",
    "requirements.txt": ".venv",
    "setup.py": ".venv",
    Pipfile: ".venv",
    "composer.json": "vendor",
}
// Artifact dir names (used to keep them out of commits at ANY depth).
const DEP_DIR_NAMES = new Set(["node_modules", ".venv", "vendor"])
// Dirs we never descend into when discovering package roots.
const SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "vendor", "dist", "build", "target", ".next", "out", "coverage"])
// How deep to look for nested package manifests (covers the common monorepo layout).
const SCAN_DEPTH = 3

export interface WorktreeManagerOptions {
    /** Symlink dependency dirs (node_modules, …) into each worktree. Default true. */
    linkDepDirs?: boolean
    /** Diagnostic logger (defaults to stderr). */
    onLog?: (line: string) => void
}

/**
 * Per-story worktree lifecycle for one run (one instance per orchestrate()
 * call); the run id scopes branch + dir names so concurrent runs never
 * collide. Crashed prior runs leave inert worktree dirs / branch refs
 * behind — harmless, since each run uses a fresh id.
 */
export class WorktreeManager {
    private readonly paths = new Map<string, string>()
    /** Stories whose merge-back failed: their branch is kept for recovery. */
    private readonly preserved = new Set<string>()
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
     * Create a story's worktree off the current run-branch HEAD. Returns
     * its path, or null on any failure so the caller can fall back to the
     * shared repo cwd instead of failing the story.
     */
    async create(storyId: string): Promise<string | null> {
        const release = await this.gate.acquire()
        try {
            const branch = this.branchOf(storyId)
            const path = this.pathOf(storyId)
            // A leftover dir/branch from a crash would make `worktree add`
            // fail; best-effort clear first.
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
     * Merge a passed story's branch onto the run branch; false if the story
     * had no worktree (create() fell back to the shared tree). On merge
     * failure retries once with `-X theirs` (the merging story wins); throws
     * — leaving the run branch clean — only when even that fails, so the
     * caller preserves the branch rather than discarding the work.
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
                const conflicts = await this.conflictedPaths()
                await this.abortMerge(storyId)
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
                    await this.abortMerge(storyId)
                    // Keep the branch out of the cleanup sweep so the
                    // commits stay recoverable after the run.
                    this.preserved.add(storyId)
                    throw new Error(
                        `could not merge story ${storyId} even with -X theirs: ${errMsg(e)}`,
                    )
                }
            }
        } finally {
            release()
        }
    }

    /**
     * A lingering MERGE_HEAD (e.g. a held index.lock) would make the NEXT
     * story's merge fail and be misdiagnosed against the wrong story.
     */
    private async abortMerge(storyId: string): Promise<void> {
        try {
            await exec("git", ["merge", "--abort"], { cwd: this.repoRoot })
        } catch (e) {
            this.log(
                `WARNING: 'git merge --abort' failed after story ${storyId} ` +
                    `(${errMsg(e)}); run branch may have a lingering MERGE_HEAD`,
            )
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

    /**
     * Remove every worktree plus the temp dir. Branches are deleted too —
     * EXCEPT preserved ones (unresolvable merge-back), whose ref is kept so
     * the commits stay recoverable after the run.
     */
    async cleanupAll(): Promise<void> {
        const release = await this.gate.acquire()
        try {
            for (const [storyId, path] of this.paths) {
                await this.removeWorktreeQuiet(path)
                if (this.preserved.has(storyId)) {
                    this.log(
                        `kept branch ${this.branchOf(storyId)} for recovery ` +
                            `(merge-back failed); inspect with: git log ${this.branchOf(storyId)}`,
                    )
                } else {
                    await this.deleteBranchQuiet(this.branchOf(storyId))
                }
            }
            this.paths.clear()
            await execQuiet("git", ["worktree", "prune"], this.repoRoot)
            rmSyncQuiet(this.baseDir)
        } finally {
            release()
        }
    }

    /**
     * Prune worktree admin entries whose dirs are already gone and delete
     * branches under THIS run id (ids are unique per process, so this never
     * touches a concurrent run's worktrees).
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

    /**
     * Package roots (root + nested) mapped to their stack's dep dir; cached
     * per run. Manifest-driven so monorepo subpackages are found.
     */
    private depLocs?: Array<{ rel: string; dir: string }>
    private depLocations(): Array<{ rel: string; dir: string }> {
        if (this.depLocs) return this.depLocs
        const out: Array<{ rel: string; dir: string }> = []
        const seen = new Set<string>()
        const scan = (rel: string, depth: number): void => {
            let entries: import("fs").Dirent[]
            try {
                entries = readdirSync(join(this.repoRoot, rel) || this.repoRoot, { withFileTypes: true })
            } catch {
                return
            }
            const record = (dir: string): void => {
                const key = `${rel}|${dir}`
                if (!seen.has(key)) {
                    seen.add(key)
                    out.push({ rel, dir })
                }
            }
            for (const e of entries) {
                // A manifest marks a package root (share its dep dir even before install)…
                if (e.isFile() && DEP_DIR_BY_MANIFEST[e.name]) record(DEP_DIR_BY_MANIFEST[e.name])
                // …and an already-present dep dir is shared as-is (the local case).
                else if (e.isDirectory() && DEP_DIR_NAMES.has(e.name)) record(e.name)
            }
            if (depth <= 0) return
            for (const e of entries) {
                if (e.isDirectory() && !SCAN_SKIP.has(e.name) && !e.name.startsWith(".")) {
                    scan(rel ? join(rel, e.name) : e.name, depth - 1)
                }
            }
        }
        scan("", SCAN_DEPTH)
        this.depLocs = out
        return out
    }

    private symlinkDepDirs(worktreePath: string): void {
        for (const { rel, dir } of this.depLocations()) {
            // ONE shared, run-persistent target per dep dir. Pre-create it
            // empty so the first `npm install` writes through the symlink
            // and every other story sees the result.
            const shared = join(this.repoRoot, rel, dir)
            const dest = join(worktreePath, rel, dir)
            if (existsSync(dest)) continue
            try {
                if (!existsSync(shared)) mkdirSync(shared, { recursive: true })
                mkdirSync(join(worktreePath, rel), { recursive: true })
                // "junction" (not "dir"): a dir symlink needs admin/Developer
                // Mode on Windows; a junction doesn't. Ignored off Windows, so
                // this stays a normal symlink on macOS/Linux.
                symlinkSync(shared, dest, "junction")
            } catch (e) {
                this.log(`could not symlink ${join(rel, dir)} into worktree (${errMsg(e)})`)
            }
        }
    }

    /**
     * Commit work the agent edited but didn't commit, so it isn't lost on
     * cleanup (passing is signalled by the agent, not by a commit existing).
     * Never commits the symlinked dep dirs, and surfaces a warning rather than
     * silently dropping work if any git step fails.
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

        // No pathspec: an explicit `.` makes the exit code reflect the benign
        // "some paths are gitignored" advice rather than real failures;
        // .gitignore already keeps node_modules out in the common case.
        try {
            await exec("git", ["add", "-A"], { cwd: worktreePath })
        } catch (e) {
            this.log(
                `WARNING: failed to stage story ${storyId}'s leftover work ` +
                    `(${errMsg(e)}); it will not be included in the merge`,
            )
            return
        }
        // Belt for repos that DON'T gitignore the dep dirs: unstage them (at every
        // package root, nested included) so their absolute-path symlinks never commit.
        const resetSpecs = this.depLocations().map(({ rel, dir }) => join(rel, dir))
        if (resetSpecs.length) await execQuiet("git", ["reset", "-q", "--", ...resetSpecs], worktreePath)

        let staged: string[] = []
        let diffFailed = false
        try {
            const { stdout } = await exec("git", ["diff", "--cached", "--name-only"], {
                cwd: worktreePath,
            })
            staged = stdout.split("\n").map((l) => l.trim()).filter(Boolean)
        } catch (e) {
            // Don't treat an unreadable index as "nothing staged" — that would
            // silently skip the commit and drop the work. Warn and commit
            // whatever is staged instead (dep dirs were already reset above).
            diffFailed = true
            this.log(
                `WARNING: could not inspect staged changes for story ${storyId} ` +
                    `(${errMsg(e)}); committing whatever is staged`,
            )
        }
        // If the reset didn't drop a dep dir, refuse to commit a broken symlink. Match a
        // dep dir as any path segment, so nested ones (e.g. frontend/node_modules) count.
        const depStaged = staged.filter((p) => p.split("/").some((seg) => DEP_DIR_NAMES.has(seg)))
        if (depStaged.length > 0) {
            this.log(
                `WARNING: could not keep dep dirs [${depStaged.join(", ")}] out of ` +
                    `story ${storyId}'s auto-commit; skipping it to avoid committing symlinks`,
            )
            await execQuiet("git", ["reset", "-q"], worktreePath)
            return
        }
        // Only a dep dir was dirty → nothing real to commit (benign). When the
        // diff couldn't be read we don't know, so fall through and let the
        // commit (or its "nothing to commit" failure) decide.
        if (!diffFailed && staged.length === 0) return

        this.log(
            `WARNING: story ${storyId} passed with uncommitted changes; ` +
                `auto-committing ${diffFailed ? "" : `${staged.length} path(s) `}before merge`,
        )
        try {
            await exec(
                "git",
                ["commit", "-m", `baro: auto-commit uncommitted work for story ${storyId}`],
                { cwd: worktreePath },
            )
        } catch (e) {
            // Surface a real commit failure: the work would otherwise be
            // silently dropped (the branch merges without it).
            this.log(
                `WARNING: failed to auto-commit story ${storyId}'s leftover work ` +
                    `(${errMsg(e)}); it will not be included in the merge`,
            )
        }
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
