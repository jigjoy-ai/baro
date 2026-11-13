import {
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

import { diskUsage, formatBytes } from "../runtime/disk-usage.js"
import { INTEGRATION_WORKTREE_DIRNAME } from "./integration-worktree.js"
import { runRepositoryCommand as exec } from "./repository-command.js"
import { meaningfulStatusLines } from "./worktree.js"

const OWNER_MARKER = /^\.baro-run-(\d+)\.pid$/
// A run dir without an owner marker predates markers (or its run finished
// with worktrees retained); only one left untouched this long counts as dead.
export const LEGACY_IDLE_MS = 24 * 60 * 60_000
const GIT_TIMEOUT_MS = 60_000

export function worktreesRoot(): string {
    return join(tmpdir(), "baro-worktrees")
}

/** Marks runDir as owned by a live process; the release is idempotent and
 * removes the dir only if nothing else is left in it. One marker per pid, so
 * a second process sharing the run id cannot drop the first one's claim. */
export function claimRunDir(runDir: string, pid: number = process.pid): () => void {
    mkdirSync(runDir, { recursive: true })
    const marker = join(runDir, `.baro-run-${pid}.pid`)
    writeFileSync(marker, `${pid}\n`)
    let released = false
    return () => {
        if (released) return
        released = true
        try {
            unlinkSync(marker)
        } catch { /* already gone */ }
        try {
            if (readdirSync(runDir).length === 0) rmdirSync(runDir)
        } catch { /* best-effort */ }
    }
}

export function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

export interface ReclaimOptions {
    currentRunId: string
    root?: string
    now?: number
    legacyIdleMs?: number
    isAlive?: (pid: number) => boolean
    log: (line: string) => void
}

export interface ReclaimSummary {
    /** Paths removed: whole run dirs, or single worktrees of a partly kept run. */
    reclaimed: string[]
    /** Worktrees of dead runs left in place because they hold work. */
    kept: string[]
    bytes: number
}

/**
 * Remove run dirs under the worktrees root whose run is no longer alive. A
 * story worktree with uncommitted changes, or whose HEAD no ordinary branch
 * contains, is someone's unmerged work and stays, as does its story dir.
 */
export async function reclaimStaleRunDirs(opts: ReclaimOptions): Promise<ReclaimSummary> {
    const root = opts.root ?? worktreesRoot()
    const summary: ReclaimSummary = { reclaimed: [], kept: [], bytes: 0 }
    for (const name of listDir(root).sort()) {
        const runDir = join(root, name)
        if (name === opts.currentRunId || !isDirectory(runDir)) continue
        if (runIsAlive(runDir, name, opts)) continue
        await reclaimRunDir(runDir, name, opts, summary)
    }
    if (summary.reclaimed.length > 0) {
        opts.log(
            `reclaimed ${summary.reclaimed.length} leftover worktree dir(s) of dead runs ` +
                `(${formatBytes(summary.bytes)}) under ${root}`,
        )
    }
    return summary
}

function runIsAlive(runDir: string, runId: string, opts: ReclaimOptions): boolean {
    const alive = opts.isAlive ?? isProcessAlive
    const owners = ownerPids(runDir)
    if (owners.length > 0) return owners.some(alive)
    const pid = pidInRunId(runId)
    if (pid !== null && alive(pid)) return true
    const now = opts.now ?? Date.now()
    return newestMtime(runDir) > now - (opts.legacyIdleMs ?? LEGACY_IDLE_MS)
}

function ownerPids(runDir: string): number[] {
    return listDir(runDir).flatMap((name) => {
        const match = OWNER_MARKER.exec(name)
        return match ? [Number(match[1])] : []
    })
}

/** `run-<pid>` (the TUI) and `run-<ms>-<pid>` (orchestrate's fallback). */
export function pidInRunId(runId: string): number | null {
    const match = /^run-(?:\d{10,}-)?(\d{1,9})$/.exec(runId)
    return match ? Number(match[1]) : null
}

/** Run dir, story dirs and worktree roots: each changes as stories come and go. */
function newestMtime(runDir: string): number {
    let newest = mtimeOf(runDir)
    for (const child of listDir(runDir)) {
        const childPath = join(runDir, child)
        newest = Math.max(newest, mtimeOf(childPath))
        if (!isDirectory(childPath)) continue
        for (const grandchild of listDir(childPath)) {
            newest = Math.max(newest, mtimeOf(join(childPath, grandchild)))
        }
    }
    return newest
}

async function reclaimRunDir(
    runDir: string,
    runId: string,
    opts: ReclaimOptions,
    summary: ReclaimSummary,
): Promise<void> {
    const commonDirs = new Set<string>()
    const removed: string[] = []
    let keptAny = false
    let bytes = 0
    for (const child of listDir(runDir)) {
        if (OWNER_MARKER.test(child)) continue
        const childPath = join(runDir, child)
        let keptInChild = false
        for (const tree of worktreesIn(childPath)) {
            const verdict = await inspectWorktree(tree, child === INTEGRATION_WORKTREE_DIRNAME)
            if (verdict.keep !== null) {
                keptInChild = true
                summary.kept.push(tree)
                opts.log(`kept ${tree} of dead run ${runId}: ${verdict.keep}`)
                continue
            }
            if (verdict.commonDir) commonDirs.add(verdict.commonDir)
            bytes += diskUsage(tree)
            rmSync(tree, { recursive: true, force: true })
            removed.push(tree)
        }
        if (keptInChild) {
            keptAny = true
        } else {
            bytes += diskUsage(childPath)
            rmSync(childPath, { recursive: true, force: true })
        }
    }
    for (const commonDir of commonDirs) {
        try {
            await exec("git", ["worktree", "prune"], { cwd: commonDir, timeoutMs: GIT_TIMEOUT_MS })
        } catch { /* the next prune by any run catches up */ }
    }
    if (!keptAny) {
        rmSync(runDir, { recursive: true, force: true })
        removed.splice(0, removed.length, runDir)
    }
    for (const path of removed) opts.log(`removed ${path}`)
    summary.reclaimed.push(...removed)
    summary.bytes += bytes
}

/** `<story>/<repo>` today; `<story>` itself in older layouts. */
function worktreesIn(dir: string): string[] {
    if (!isDirectory(dir)) return []
    if (exists(join(dir, ".git"))) return [dir]
    return listDir(dir)
        .map((name) => join(dir, name))
        .filter((path) => isDirectory(path) && exists(join(path, ".git")))
}

interface WorktreeVerdict {
    keep: string | null
    commonDir: string | null
}

async function inspectWorktree(tree: string, integration: boolean): Promise<WorktreeVerdict> {
    const dotGit = join(tree, ".git")
    try {
        if (!lstatSync(dotGit).isFile()) {
            return { keep: "a full repository, not a linked worktree", commonDir: null }
        }
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))
        // The admin dir (or the whole repo) is gone: git no longer knows this
        // tree, and no branch can be read through it.
        if (!pointer || !exists(resolve(tree, pointer[1].trim()))) {
            return { keep: null, commonDir: null }
        }
        const git = async (...args: string[]) =>
            (await exec("git", args, { cwd: tree, timeoutMs: GIT_TIMEOUT_MS })).stdout.trim()
        // The integration tree only stages merges onto the goal branch, which
        // holds all of them; IntegrationWorktree.remove() forces it away too.
        if (!integration && meaningfulStatusLines(await git("status", "--porcelain")).length > 0) {
            return { keep: "uncommitted changes", commonDir: null }
        }
        const head = await git("rev-parse", "--verify", "HEAD")
        const holders = (await git("for-each-ref", "--contains", head, "--format=%(refname)", "refs/heads/"))
            .split("\n")
            .filter((ref) => ref && !/^refs\/heads\/baro-(wt|recovery)\//.test(ref))
        if (holders.length === 0) {
            const branch = await git("branch", "--show-current").catch(() => "")
            return {
                keep: `commits not merged into any branch${branch ? ` (on ${branch})` : ""}`,
                commonDir: null,
            }
        }
        return { keep: null, commonDir: resolve(tree, await git("rev-parse", "--git-common-dir")) }
    } catch (error) {
        return { keep: `could not inspect: ${(error as Error)?.message ?? String(error)}`, commonDir: null }
    }
}

function listDir(path: string): string[] {
    try {
        return readdirSync(path)
    } catch {
        return []
    }
}

function isDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory()
    } catch {
        return false
    }
}

function exists(path: string): boolean {
    try {
        lstatSync(path)
        return true
    } catch {
        return false
    }
}

function mtimeOf(path: string): number {
    try {
        return lstatSync(path).mtimeMs
    } catch {
        return 0
    }
}
