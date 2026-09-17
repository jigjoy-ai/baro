import { existsSync, readdirSync, realpathSync, rmSync, rmdirSync } from "fs"
import { tmpdir } from "os"
import { basename, dirname, join, resolve } from "path"

import { GitGate, pushBranchUpstream } from "./git.js"
import {
    RepositoryCommandError,
    isRepositoryCommandTimeout,
    runRepositoryCommand as exec,
} from "./repository-command.js"

export const INTEGRATION_WORKTREE_DIRNAME = "__run"

export function integrationWorktreePath(runId: string): string {
    return join(tmpdir(), "baro-worktrees", runId, INTEGRATION_WORKTREE_DIRNAME)
}

export interface IntegrationWorktreeOptions {
    repoRoot: string
    gitGate: GitGate
    runId: string
    goalBranch: string
    push: boolean
    onLog?: (line: string) => void
}

export interface IntegrationWorktreePrepared {
    integrationRoot: string
    baseSha: string
    reused: boolean
    hostBranchAtStart: string | null
    hostHeadAtStart: string
}

export type HostCheckoutSyncResult =
    | { kind: "fast_forwarded"; from: string; to: string }
    | {
          kind: "untouched"
          reason:
              | "not_on_base_branch"
              | "host_checkout_dirty"
              | "not_fast_forward"
              | "up_to_date"
              | "not_prepared"
              | "error"
          detail: string
      }

/** The run's goal branch checked out outside the user's checkout, so merges,
 * verification and finalization never switch or dirty the host tree. */
export class IntegrationWorktree {
    readonly integrationRoot: string
    private readonly repoRoot: string
    private readonly log: (line: string) => void
    private preparing: Promise<IntegrationWorktreePrepared> | null = null
    private prepared: IntegrationWorktreePrepared | null = null

    constructor(private readonly opts: IntegrationWorktreeOptions) {
        this.repoRoot = opts.repoRoot
        this.integrationRoot = integrationWorktreePath(opts.runId)
        this.log = opts.onLog ?? ((line) => process.stderr.write(`${line}\n`))
    }

    prepare(): Promise<IntegrationWorktreePrepared> {
        this.preparing ??= this.prepareOnce()
        return this.preparing
    }

    private async prepareOnce(): Promise<IntegrationWorktreePrepared> {
        const { repoRoot, integrationRoot } = this
        const { goalBranch } = this.opts
        const release = await this.opts.gitGate.acquire()
        try {
            await git(["worktree", "prune"], repoRoot)
            const hostBranchAtStart =
                (await git(["branch", "--show-current"], repoRoot)) || null
            const hostHeadAtStart = await git(["rev-parse", "HEAD"], repoRoot)

            const registered = await this.isRegistered()
            let reused = false
            if (registered && existsSync(integrationRoot)) {
                const branch = await git(["branch", "--show-current"], integrationRoot)
                    .catch((error: unknown) => {
                        if (isRepositoryCommandTimeout(error)) throw error
                        return null
                    })
                reused = branch === goalBranch
            }
            if (!reused) {
                if (registered || existsSync(integrationRoot)) {
                    await gitQuiet(["worktree", "remove", "--force", integrationRoot], repoRoot)
                    if (existsSync(integrationRoot)) {
                        rmSync(integrationRoot, { recursive: true, force: true })
                    }
                    await git(["worktree", "prune"], repoRoot)
                }
                const branchExists = await git(
                    ["show-ref", "--verify", "--quiet", `refs/heads/${goalBranch}`],
                    repoRoot,
                ).then(
                    () => true,
                    (error: unknown) => {
                        if (isRepositoryCommandTimeout(error)) throw error
                        return false
                    },
                )
                await git(
                    branchExists
                        ? ["worktree", "add", integrationRoot, goalBranch]
                        : ["worktree", "add", "-b", goalBranch, integrationRoot, hostHeadAtStart],
                    repoRoot,
                )
            }
            this.log(
                `[integration] ${reused ? "reusing" : "created"} integration worktree ` +
                    `${integrationRoot} on ${goalBranch}`,
            )

            if (this.opts.push) {
                await pushBranchUpstream(integrationRoot, goalBranch, this.log)
            } else {
                this.log(`[git] local-only; not pushing ${goalBranch}`)
            }

            const baseSha = await git(["rev-parse", "HEAD"], integrationRoot)
            this.prepared = {
                integrationRoot,
                baseSha,
                reused,
                hostBranchAtStart,
                hostHeadAtStart,
            }
            return this.prepared
        } finally {
            release()
        }
    }

    /** Never throws. The goal branch ref holds every merge, so forcing the
     * tree away cannot lose integrated work; the branch itself is kept. */
    async remove(opts: { keepIfRetained?: boolean } = {}): Promise<void> {
        const { repoRoot, integrationRoot } = this
        if (opts.keepIfRetained) {
            this.log(
                `[integration] kept integration worktree ${integrationRoot}: ` +
                    "story worktrees are retained for recovery",
            )
            return
        }
        let release: (() => void) | null = null
        try {
            release = await this.opts.gitGate.acquire()
            await gitQuiet(["worktree", "remove", "--force", integrationRoot], repoRoot)
            if (existsSync(integrationRoot)) {
                rmSync(integrationRoot, { recursive: true, force: true })
            }
            await gitQuiet(["worktree", "prune"], repoRoot)
            const runDir = dirname(integrationRoot)
            if (existsSync(runDir) && readdirSync(runDir).length === 0) {
                rmdirSync(runDir)
            }
        } catch (error) {
            this.log(
                `[integration] could not remove integration worktree ${integrationRoot}: ${errMsg(error)}`,
            )
        } finally {
            release?.()
        }
    }

    /** Best-effort fast-forward of the user's checkout; never throws and logs
     * exactly one line. A dirty tree is the non-retryable host_checkout_dirty fuse. */
    async syncHostCheckout(): Promise<HostCheckoutSyncResult> {
        const result = await this.syncHostCheckoutOnce()
        const branch = this.prepared?.hostBranchAtStart ?? "(none)"
        try {
            this.log(
                result.kind === "fast_forwarded"
                    ? `[integration] host checkout fast-forwarded ${branch} ${result.from}..${result.to}`
                    : `[integration] host checkout left untouched (${result.reason}): ${result.detail}`,
            )
        } catch { /* a failing logger must not fail the run */ }
        return result
    }

    private async syncHostCheckoutOnce(): Promise<HostCheckoutSyncResult> {
        const prepared = this.prepared
        if (!prepared) {
            return untouched("not_prepared", "the integration worktree was never prepared")
        }
        const { repoRoot } = this
        const { goalBranch } = this.opts
        let release: (() => void) | null = null
        try {
            release = await this.opts.gitGate.acquire()
            const current = await git(["branch", "--show-current"], repoRoot)
            if (!prepared.hostBranchAtStart || current !== prepared.hostBranchAtStart) {
                return untouched(
                    "not_on_base_branch",
                    `host is on ${current || "a detached HEAD"}, ` +
                        `run started on ${prepared.hostBranchAtStart ?? "a detached HEAD"}`,
                )
            }
            const { stdout: status } = await exec(
                "git",
                ["status", "--porcelain", "--untracked-files=no"],
                { cwd: repoRoot },
            )
            const paths = status.split("\n").filter(Boolean).map((line) => line.slice(3).trim())
            if (paths.length) {
                return untouched(
                    "host_checkout_dirty",
                    `uncommitted changes on [${paths.join(", ")}]; merge ${goalBranch} manually`,
                )
            }
            const head = await git(["rev-parse", "HEAD"], repoRoot)
            const goalSha = await git(["rev-parse", `refs/heads/${goalBranch}`], repoRoot)
            if (head === goalSha) {
                return untouched("up_to_date", `${current} already at ${goalBranch}`)
            }
            try {
                await git(["merge-base", "--is-ancestor", head, goalSha], repoRoot)
            } catch (error) {
                if (!(error instanceof RepositoryCommandError) || error.code !== 1) throw error
                return untouched(
                    "not_fast_forward",
                    `${current} has diverged from ${goalBranch}`,
                )
            }
            await git(["merge", "--ff-only", goalSha], repoRoot)
            return { kind: "fast_forwarded", from: head, to: goalSha }
        } catch (error) {
            return untouched("error", errMsg(error))
        } finally {
            release?.()
        }
    }

    private async isRegistered(): Promise<boolean> {
        const listing = await git(["worktree", "list", "--porcelain"], this.repoRoot)
        const target = canonicalPath(this.integrationRoot)
        return listing
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .some((line) => canonicalPath(line.slice("worktree ".length)) === target)
    }
}

async function git(args: readonly string[], cwd: string): Promise<string> {
    const { stdout } = await exec("git", args, { cwd })
    return stdout.trim()
}

async function gitQuiet(args: readonly string[], cwd: string): Promise<void> {
    try {
        await exec("git", args, { cwd })
    } catch (error) {
        if (isRepositoryCommandTimeout(error)) throw error
    }
}

/** tmpdir() can sit behind a symlink (/var → /private/var) that git resolves,
 * and a pruned-but-listed path may no longer exist. */
export function canonicalPath(path: string): string {
    const absolute = resolve(path)
    try {
        return realpathSync(absolute)
    } catch {
        const parent = dirname(absolute)
        return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute))
    }
}

function untouched(
    reason: Extract<HostCheckoutSyncResult, { kind: "untouched" }>["reason"],
    detail: string,
): HostCheckoutSyncResult {
    return { kind: "untouched", reason, detail }
}

function errMsg(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}
