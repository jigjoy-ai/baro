/**
 * Per-story git worktree isolation (issue #50): each story works on branch
 * `baro-wt/<runId>/<storyId>` in its own worktree and merges back on success,
 * so parallel `git add -A` can't sweep up siblings' in-flight edits.
 * State-mutating ops acquire the shared {@link GitGate} so they never race
 * the per-story push/pull in git.ts; agent commits inside a worktree touch
 * only its private index and need no serialization.
 */

import { execFile } from "child_process"
import { createHash } from "crypto"
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
} from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
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
    /** Return null on create failure so callers may use the shared tree. Default true. */
    allowSharedFallback?: boolean
    /** Resolve merge conflicts by retrying with `-X theirs`. Default true. */
    resolveConflictsWithTheirs?: boolean
}

/**
 * Per-story worktree lifecycle for one run (one instance per orchestrate()
 * call); the run id scopes branch + dir names so concurrent runs never
 * collide. Crashed prior runs leave inert worktree dirs / branch refs
 * behind — harmless, since each run uses a fresh id.
 */
export class WorktreeManager {
    private readonly paths = new Map<string, string>()
    /** Exact run-branch commit each logical story worktree was created from. */
    private readonly baseShas = new Map<string, string>()
    /** Stories whose merge-back failed: their branch is kept for recovery. */
    private readonly preserved = new Set<string>()
    private recoverySequence = 0
    private readonly baseDir: string
    private readonly linkDepDirs: boolean
    private readonly allowSharedFallback: boolean
    private readonly resolveConflictsWithTheirs: boolean
    private readonly log: (line: string) => void
    private depExcludesReady = false

    constructor(
        private readonly repoRoot: string,
        private readonly gate: GitGate,
        private readonly runId: string,
        opts: WorktreeManagerOptions = {},
    ) {
        this.baseDir = join(tmpdir(), "baro-worktrees", runId)
        this.linkDepDirs = opts.linkDepDirs ?? true
        this.allowSharedFallback = opts.allowSharedFallback ?? true
        this.resolveConflictsWithTheirs = opts.resolveConflictsWithTheirs ?? true
        this.log =
            opts.onLog ?? ((line) => process.stderr.write(`[worktree] ${line}\n`))
    }

    private branchOf(storyId: string): string {
        return `baro-wt/${this.runId}/${sanitize(storyId)}`
    }

    /** The git branch a story's work lives on — needed to recover it when
     *  merge-back fails and the branch is preserved instead of merged. */
    branchName(storyId: string): string {
        return this.branchOf(storyId)
    }

    /**
     * Read-only lookup for policy observers that must inspect a story before
     * acceptance/integration. Returns null once the manager has released it.
     */
    activePath(storyId: string): string | null {
        return this.paths.get(storyId) ?? null
    }

    /** Exact immutable commit from which the active story worktree was made. */
    creationSha(storyId: string): string | null {
        return this.baseShas.get(storyId) ?? null
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
        const branch = this.branchOf(storyId)
        const path = this.pathOf(storyId)
        try {
            // Registration is transactional: observers must not be able to
            // resolve a story target until every setup step has completed.
            // Clear any prior logical state before removing stale git state.
            this.paths.delete(storyId)
            this.baseShas.delete(storyId)
            this.preserved.delete(storyId)
            // A leftover dir/branch from a crash would make `worktree add`
            // fail; best-effort clear first.
            await this.removeWorktreeQuiet(path)
            await this.deleteBranchQuiet(branch)

            const { stdout: baseSha } = await exec("git", ["rev-parse", "HEAD"], {
                cwd: this.repoRoot,
            })

            await exec(
                "git",
                ["worktree", "add", "-b", branch, path, "HEAD"],
                { cwd: this.repoRoot },
            )
            if (this.linkDepDirs) {
                await this.ensureDepDirsExcluded()
                this.symlinkDepDirs(path)
            }
            this.paths.set(storyId, path)
            this.baseShas.set(storyId, baseSha.trim())
            this.log(`created ${branch} at ${path}`)
            return path
        } catch (e) {
            let rollbackError: unknown = null
            try {
                await this.rollbackPartialCreate(storyId, path, branch)
            } catch (cleanupError) {
                rollbackError = cleanupError
            }
            const suffix = this.allowSharedFallback
                ? "; falling back to shared tree"
                : "; collective mode requires isolation"
            const rollbackSuffix = rollbackError
                ? `; partial setup cleanup failed (${errMsg(rollbackError)})`
                : ""
            this.log(
                `could not create worktree for ${storyId} (${errMsg(e)})` +
                    `${rollbackSuffix}${suffix}`,
            )
            // A residual worktree/branch is not a safe shared-tree fallback:
            // fail closed rather than leave ambiguous story state behind.
            if (rollbackError) {
                throw new Error(
                    `worktree setup failed for ${storyId}: ${errMsg(e)}; ` +
                        `rollback failed: ${errMsg(rollbackError)}`,
                )
            }
            if (!this.allowSharedFallback) throw e
            return null
        } finally {
            release()
        }
    }

    /**
     * Turn a merge-failed worktree into an immutable recovery ref, then free
     * the logical story id so a bounded retry can start from the latest run
     * branch. The original commit remains inspectable even if retry execution
     * fails; generic story cleanup never deletes these backup refs.
     */
    async prepareConflictRetry(storyId: string): Promise<string> {
        const release = await this.gate.acquire()
        try {
            const path = this.paths.get(storyId)
            const branch = this.branchOf(storyId)
            if (!path || !existsSync(path) || !this.preserved.has(storyId)) {
                throw new Error(`story ${storyId} has no preserved worktree to recover`)
            }

            const { stdout: status } = await exec("git", ["status", "--porcelain"], {
                cwd: path,
            })
            if (meaningfulStatusLines(status).length > 0) {
                throw new Error(
                    `story ${storyId} recovery worktree is dirty; refusing to discard ` +
                        "uncommitted work",
                )
            }

            // mergeBack already ran the leftover safety-net before detecting
            // the conflict, so this ref is a complete immutable attempt.
            const backup = await this.createRecoveryBranch(storyId, branch)

            // The backup now owns durability. Release the reusable story ref;
            // create(storyId) can safely start a fresh worktree at current HEAD.
            await this.removeWorktreeQuiet(path)
            if (existsSync(path)) {
                throw new Error(`could not release preserved worktree for story ${storyId}`)
            }
            this.paths.delete(storyId)
            this.baseShas.delete(storyId)
            await this.deleteBranchQuiet(branch)
            const { stdout: remaining } = await exec(
                "git",
                ["branch", "--list", branch, "--format=%(refname:short)"],
                { cwd: this.repoRoot },
            )
            if (remaining.trim()) {
                throw new Error(`could not release preserved branch for story ${storyId}`)
            }
            this.preserved.delete(storyId)
            this.log(
                `preserved rejected attempt for story ${storyId} at ${backup}; ` +
                    "fresh recovery will start from the latest run branch",
            )
            return backup
        } finally {
            release()
        }
    }

    /**
     * Release an execution-failed story without losing meaningful work. When
     * preservation is requested, uncommitted user changes are first committed
     * on the isolated story branch; an already-committed partial attempt is
     * detected against the worktree's recorded creation SHA. Either form is
     * copied to a unique recovery ref before the reusable worktree and logical
     * branch are removed, so a next attempt can start at run-branch HEAD.
     *
     * An unchanged attempt needs no recovery ref and is cleaned up normally.
     * If the directory disappeared, the logical branch is compared with its
     * recorded creation SHA before cleanup. Any inspection/snapshot failure is
     * fail-closed: the remaining worktree or branch stays in place and this
     * method rejects.
     */
    async cleanupFailed(
        storyId: string,
        preserveForRecovery: boolean,
    ): Promise<string | null> {
        const release = await this.gate.acquire()
        try {
            const path = this.paths.get(storyId)
            const branch = this.branchOf(storyId)
            if (!path || !existsSync(path)) {
                if (preserveForRecovery) {
                    let branchHead: string | null
                    try {
                        branchHead = await this.logicalBranchHead(branch)
                    } catch (error) {
                        this.preserved.add(storyId)
                        throw new Error(
                            `could not inspect missing worktree branch for story ${storyId}; ` +
                                `retained ${branch}: ${errMsg(error)}`,
                        )
                    }
                    const baseSha = this.baseShas.get(storyId)
                    if (branchHead && (!baseSha || branchHead !== baseSha)) {
                        this.preserved.add(storyId)
                        const backup = await this.createRecoveryBranch(storyId, branch)
                        await this.releaseLogicalStory(
                            storyId,
                            path ?? this.pathOf(storyId),
                            branch,
                        )
                        this.log(
                            `preserved failed execution for story ${storyId} at ${backup} ` +
                                "after its worktree path disappeared",
                        )
                        return backup
                    }
                }
                await this.releaseLogicalStory(
                    storyId,
                    path ?? this.pathOf(storyId),
                    branch,
                )
                return null
            }

            if (!preserveForRecovery) {
                await this.removeWorktreeQuiet(path)
                this.paths.delete(storyId)
                this.baseShas.delete(storyId)
                await this.deleteBranchQuiet(branch)
                this.preserved.delete(storyId)
                return null
            }

            let status: string
            try {
                ;({ stdout: status } = await exec(
                    "git",
                    ["status", "--porcelain"],
                    { cwd: path },
                ))
            } catch (error) {
                this.preserved.add(storyId)
                throw new Error(
                    `could not inspect failed story ${storyId}; retained dirty worktree ` +
                        `at ${path}: ${errMsg(error)}`,
                )
            }
            const meaningfulDirty = meaningfulStatusLines(status).length > 0
            let headSha: string
            try {
                ;({ stdout: headSha } = await exec("git", ["rev-parse", "HEAD"], {
                    cwd: path,
                }))
            } catch (error) {
                this.preserved.add(storyId)
                throw new Error(
                    `could not inspect failed story ${storyId} HEAD; retained worktree ` +
                        `at ${path}: ${errMsg(error)}`,
                )
            }
            const baseSha = this.baseShas.get(storyId)
            // Missing provenance is unsafe to call clean: preserve the branch
            // rather than guessing that its commits came from the run branch.
            const hasStoryCommits = !baseSha || headSha.trim() !== baseSha
            if (!meaningfulDirty && !hasStoryCommits) {
                await this.releaseLogicalStory(storyId, path, branch)
                return null
            }

            // Mark it before touching the index. cleanupAll() must retain the
            // worktree if staging, committing, or ref creation fails midway.
            this.preserved.add(storyId)
            if (meaningfulDirty) await this.commitFailedWork(storyId, path)
            const backup = await this.createRecoveryBranch(storyId, branch)

            // The immutable backup now owns durability. It is safe to release
            // the reusable logical id and let a recovery start from fresh HEAD.
            await this.releaseLogicalStory(storyId, path, branch)
            this.log(
                `preserved failed execution for story ${storyId} at ${backup}; ` +
                    "fresh recovery will start from the latest run branch",
            )
            return backup
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
                if (!this.resolveConflictsWithTheirs) {
                    this.preserved.add(storyId)
                    throw new Error(
                        `story ${storyId} conflicts with already-merged work` +
                            (conflicts.length ? ` on [${conflicts.join(", ")}]` : ""),
                    )
                }
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
            this.baseShas.delete(storyId)
            await this.deleteBranchQuiet(branch)
            this.preserved.delete(storyId)
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
        let keptDirtyRecovery = false
        try {
            for (const [storyId, path] of this.paths) {
                if (this.preserved.has(storyId) && existsSync(path)) {
                    let status = ""
                    try {
                        ;({ stdout: status } = await exec(
                            "git",
                            ["status", "--porcelain"],
                            { cwd: path },
                        ))
                    } catch {
                        // If cleanliness cannot be proven, preserve the path.
                        status = "?? <status-unavailable>"
                    }
                    if (meaningfulStatusLines(status).length > 0) {
                        keptDirtyRecovery = true
                        this.log(
                            `kept dirty recovery worktree for story ${storyId} at ${path}; ` +
                                `branch ${this.branchOf(storyId)} remains inspectable`,
                        )
                        continue
                    }
                }
                await this.removeWorktreeQuiet(path)
                this.paths.delete(storyId)
                this.baseShas.delete(storyId)
                if (this.preserved.has(storyId)) {
                    this.log(
                        `kept branch ${this.branchOf(storyId)} for recovery ` +
                            `(merge-back failed); inspect with: git log ${this.branchOf(storyId)}`,
                    )
                } else {
                    await this.deleteBranchQuiet(this.branchOf(storyId))
                }
            }
            if (!keptDirtyRecovery) {
                this.paths.clear()
                this.baseShas.clear()
            }
            await execQuiet("git", ["worktree", "prune"], this.repoRoot)
            if (!keptDirtyRecovery) rmSyncQuiet(this.baseDir)
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

    /**
     * A pattern such as `node_modules/` does not ignore a symlink named
     * `node_modules`, so an agent's explicit `git add -A` could commit our
     * shared dependency link and turn the run root into a self-referential
     * symlink after merge-back. Add exact manager-owned paths to the common
     * repo-local exclude file (linked worktrees share it). Tracked paths are
     * unaffected by info/exclude.
     */
    private async ensureDepDirsExcluded(): Promise<void> {
        if (this.depExcludesReady) return
        const { stdout } = await exec(
            "git",
            ["rev-parse", "--git-path", "info/exclude"],
            { cwd: this.repoRoot },
        )
        const rawPath = stdout.trim()
        const excludePath = rawPath.startsWith("/")
            ? rawPath
            : resolve(this.repoRoot, rawPath)
        let existing = ""
        try {
            existing = readFileSync(excludePath, "utf8")
        } catch {
            /* git normally creates it; appendFileSync will create if needed */
        }
        const present = new Set(existing.split("\n").map((line) => line.trim()))
        const patterns = this.depLocations().map(({ rel, dir }) =>
            `/${rel ? `${rel}/` : ""}${dir}`,
        )
        const missing = patterns.filter((pattern) => !present.has(pattern))
        if (missing.length > 0) {
            appendFileSync(
                excludePath,
                `\n# baro: shared dependency symlinks\n${missing.join("\n")}\n`,
            )
        }
        this.depExcludesReady = true
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
                symlinkSync(shared, dest, "dir")
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

    /** Strict counterpart to the passing-story safety net. Failure here must
     * retain the worktree instead of allowing cleanup to drop user changes. */
    private async commitFailedWork(
        storyId: string,
        worktreePath: string,
    ): Promise<void> {
        try {
            await exec("git", ["add", "-A"], { cwd: worktreePath })

            const resetSpecs = this.depLocations().map(({ rel, dir }) => join(rel, dir))
            if (resetSpecs.length > 0) {
                await execQuiet(
                    "git",
                    ["reset", "-q", "--", ...resetSpecs],
                    worktreePath,
                )
            }

            const { stdout } = await exec(
                "git",
                ["diff", "--cached", "--name-only", "-z"],
                { cwd: worktreePath },
            )
            const staged = stdout.split("\0").filter(Boolean)
            const depStaged = staged.filter((path) =>
                path.split("/").some((segment) => DEP_DIR_NAMES.has(segment)),
            )
            if (depStaged.length > 0) {
                await execQuiet("git", ["reset", "-q"], worktreePath)
                throw new Error(
                    `dependency artifacts remained staged: ${depStaged.join(", ")}`,
                )
            }
            if (staged.length === 0) {
                throw new Error("meaningful dirty paths could not be staged")
            }

            await exec(
                "git",
                [
                    "commit",
                    "-m",
                    `baro: preserve failed work for story ${storyId}`,
                ],
                { cwd: worktreePath },
            )
            const { stdout: remaining } = await exec(
                "git",
                ["status", "--porcelain"],
                { cwd: worktreePath },
            )
            if (meaningfulStatusLines(remaining).length > 0) {
                throw new Error("meaningful changes remain after the preservation commit")
            }
        } catch (error) {
            throw new Error(
                `could not preserve failed story ${storyId}; retained worktree at ` +
                    `${worktreePath}: ${errMsg(error)}`,
            )
        }
    }

    private async createRecoveryBranch(
        storyId: string,
        sourceBranch: string,
    ): Promise<string> {
        for (;;) {
            const backup =
                `baro-recovery/${this.runId}/${sanitize(storyId)}/` +
                `${++this.recoverySequence}`
            try {
                await exec("git", ["branch", backup, sourceBranch], {
                    cwd: this.repoRoot,
                })
                return backup
            } catch (error) {
                const { stdout: existing } = await exec(
                    "git",
                    ["branch", "--list", backup, "--format=%(refname:short)"],
                    { cwd: this.repoRoot },
                )
                if (existing.trim()) continue
                throw error
            }
        }
    }

    private async logicalBranchHead(branch: string): Promise<string | null> {
        const { stdout: listed } = await exec(
            "git",
            ["branch", "--list", branch, "--format=%(refname:short)"],
            { cwd: this.repoRoot },
        )
        if (!listed.trim()) return null
        const { stdout: head } = await exec(
            "git",
            ["rev-parse", `refs/heads/${branch}`],
            { cwd: this.repoRoot },
        )
        return head.trim()
    }

    private async releaseLogicalStory(
        storyId: string,
        path: string,
        branch: string,
    ): Promise<void> {
        await this.removeWorktreeQuiet(path)
        if (existsSync(path)) {
            throw new Error(`could not release worktree for story ${storyId}`)
        }
        this.paths.delete(storyId)
        this.baseShas.delete(storyId)
        await this.deleteBranchQuiet(branch)
        const { stdout: remaining } = await exec(
            "git",
            ["branch", "--list", branch, "--format=%(refname:short)"],
            { cwd: this.repoRoot },
        )
        if (remaining.trim()) {
            throw new Error(`could not release logical branch for story ${storyId}`)
        }
        this.preserved.delete(storyId)
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
        }
        // Also prune when the directory disappeared outside this process;
        // otherwise Git still considers its logical branch checked out.
        await execQuiet("git", ["worktree", "prune"], this.repoRoot)
    }

    private async deleteBranchQuiet(branch: string): Promise<void> {
        await execQuiet("git", ["branch", "-D", branch], this.repoRoot)
    }

    /**
     * Roll back every externally visible part of a failed create(). Maps are
     * cleared first so policy observers fail closed even while git cleanup is
     * still running. Residual state is treated as an error, never as a valid
     * shared-tree fallback.
     */
    private async rollbackPartialCreate(
        storyId: string,
        path: string,
        branch: string,
    ): Promise<void> {
        this.paths.delete(storyId)
        this.baseShas.delete(storyId)
        this.preserved.delete(storyId)
        await this.removeWorktreeQuiet(path)
        await this.deleteBranchQuiet(branch)

        const { stdout: remainingBranch } = await exec(
            "git",
            ["branch", "--list", branch, "--format=%(refname:short)"],
            { cwd: this.repoRoot },
        )
        if (existsSync(path) || remainingBranch.trim()) {
            throw new Error(
                `residual setup state remains` +
                    (existsSync(path) ? ` at ${path}` : "") +
                    (remainingBranch.trim() ? ` on branch ${branch}` : ""),
            )
        }
    }
}

function sanitize(storyId: string): string {
    // Story ids are short slugs (S1, S2, …) but guard against anything that
    // would break a ref name or a path segment. Unsafe spellings receive an
    // identity hash so distinct ids can never collapse onto one worktree.
    const safe = storyId.replace(/[^A-Za-z0-9._-]/g, "_") || "story"
    if (safe === storyId) return safe
    const identity = createHash("sha256").update(storyId).digest("hex").slice(0, 12)
    return `${safe.slice(0, 80)}-${identity}`
}

function meaningfulStatusLines(status: string): string[] {
    return status
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .filter((line) => {
            // Porcelain v1 prefixes every entry with XY + space. Ignore only
            // manager-owned dependency symlinks; user files remain blocking.
            const rawPath = line.length > 3 ? line.slice(3) : line
            const path = rawPath.replace(/^"|"$/g, "")
            return !path.split("/").some((segment) => DEP_DIR_NAMES.has(segment))
        })
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
