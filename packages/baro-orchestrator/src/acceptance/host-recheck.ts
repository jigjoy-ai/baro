/**
 * A gate command that failed in a story's sandbox is run again by the host,
 * outside the sandbox, on an exact copy of the story's files and, where it
 * still fails, at the story's base commit. The Critic gets the results as
 * Baro-captured evidence, so a failure the story cannot cause (the sandbox,
 * a pre-existing break) is no longer a verdict the story has to disprove.
 *
 * Only commands the repository itself declares as gates are re-run, never an
 * agent's command line: the same trust the run's final verification has.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { materializeDependencies } from "../integration/dependency-materializer.js"
import { runRepositoryCommand } from "../integration/repository-command.js"
import { worktreesRoot } from "../integration/worktrees-root.js"
import {
    createVerifyPlan,
    verifyBuild,
    workspacePackageDirs,
    type VerifyCommandResult,
    type VerifyCommandSpec,
} from "../verification/verify.js"

export interface HostRecheckRequest {
    /** The story worktree. */
    cwd: string
    baseSha: string | null
    /** Fresh commands whose captured output reads as a failure. */
    failedCommands: readonly string[]
}

/** What a recheck may add to one Critic evaluation, queue included. */
export const HOST_RECHECK_BUDGET_MS = 90_000

export interface HostRecheckOptions {
    hostRoot: string
    /** The run's integration worktree. Never the host checkout: a link there lets a gate write into it (#284). */
    dependencyRoot?: string
    budgetMs?: number
    /** Test seam: builds a checkout of `rev` (a commit) at `dir`. */
    checkout?: (repoCwd: string, rev: string, dir: string) => Promise<void>
    /** Test seam: runs gate specs (by label) in a prepared checkout. */
    runGates?: (dir: string, labels: readonly string[]) => Promise<VerifyCommandResult[]>
    scratchRoot?: string
}

interface Outcome {
    status: VerifyCommandResult["status"]
    tail: string
}

const MAX_TAIL_CHARS = 2_500

export class HostRecheck {
    private queue: Promise<unknown> = Promise.resolve()
    /** By content: a base commit, or the tree of a story snapshot. A story re-reviewed on identical files reruns nothing. */
    private readonly outcomes = new Map<string, Promise<Map<string, Outcome>>>()

    constructor(private readonly opts: HostRecheckOptions) {}

    /**
     * Rechecks run one at a time: each is a full gate run on the host. The
     * Critic waits at most the budget, queue included, so a recheck never
     * outlasts the acceptance deadline; one still running fills the cache for
     * the next review of the same files.
     */
    async section(request: HostRecheckRequest): Promise<string | null> {
        const specs = createVerifyPlan(request.cwd).commands
        const changed = await changedPaths(request.cwd, request.baseSha)
        const labels = [
            ...new Set(request.failedCommands.flatMap((command) =>
                matchGateSpecs(request.cwd, command, specs, changed).map((spec) => spec.label),
            )),
        ]
        if (labels.length === 0) return null
        let snapshot: { commit: string; tree: string }
        try {
            snapshot = await snapshotCommit(request.cwd)
        } catch (error) {
            return render(labels, null, null, `the host could not snapshot the story's files: ${errMsg(error)}`)
        }
        const cached = labels.every((label) => this.outcomes.has(`tree:${snapshot.tree}\0${label}`))
        const run = cached
            ? this.recheck(request, labels, snapshot)
            : this.queue.then(() => this.recheck(request, labels, snapshot))
        if (!cached) this.queue = run.catch(() => undefined)
        const budget = this.opts.budgetMs ?? HOST_RECHECK_BUDGET_MS
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve(stillRunning(labels, budget)), budget)
            timer.unref?.()
        })
        try {
            return await Promise.race([run, late])
        } finally {
            clearTimeout(timer)
        }
    }

    private async recheck(
        request: HostRecheckRequest,
        labels: readonly string[],
        snapshot: { commit: string; tree: string },
    ): Promise<string> {
        let atHead: Map<string, Outcome>
        try {
            atHead = await this.cachedOutcomes(request.cwd, snapshot.commit, `tree:${snapshot.tree}`, labels)
        } catch (error) {
            return render(labels, null, null, `the host could not run them: ${errMsg(error)}`)
        }
        const stillFailing = labels.filter((label) => atHead.get(label)?.status === "failed")
        let atBase: Map<string, Outcome> | null = null
        if (stillFailing.length > 0 && request.baseSha) {
            try {
                atBase = await this.cachedOutcomes(request.cwd, request.baseSha, `base:${request.baseSha}`, stillFailing)
            } catch (error) {
                return render(labels, atHead, null, `the base commit could not be checked: ${errMsg(error)}`)
            }
        }
        return render(labels, atHead, atBase, null)
    }

    private async cachedOutcomes(
        cwd: string,
        rev: string,
        key: string,
        labels: readonly string[],
    ): Promise<Map<string, Outcome>> {
        const out = new Map<string, Outcome>()
        const missing: string[] = []
        for (const label of labels) {
            const cached = this.outcomes.get(`${key}\0${label}`)
            const hit = cached ? (await cached).get(label) : undefined
            if (hit) out.set(label, hit)
            else missing.push(label)
        }
        if (missing.length > 0) {
            const pending = this.runAt(cwd, rev, missing)
            for (const label of missing) this.outcomes.set(`${key}\0${label}`, pending)
            try {
                for (const [label, outcome] of await pending) out.set(label, outcome)
            } catch (error) {
                for (const label of missing) this.outcomes.delete(`${key}\0${label}`)
                throw error
            }
        }
        return out
    }

    private async runAt(repoCwd: string, rev: string, labels: readonly string[]): Promise<Map<string, Outcome>> {
        const root = this.opts.scratchRoot ?? join(worktreesRoot(), "recheck")
        mkdirSync(root, { recursive: true })
        const dir = join(mkdtempSync(join(root, "baro-recheck-")), "checkout")
        const checkout = this.opts.checkout ?? ((cwd: string, commit: string, at: string) =>
            this.defaultCheckout(cwd, commit, at))
        try {
            await checkout(repoCwd, rev, dir)
            const results = await (this.opts.runGates ?? runGatesByLabel)(dir, labels)
            const out = new Map<string, Outcome>()
            for (const result of results) {
                out.set(result.command, {
                    status: result.status,
                    tail: (result.tail ?? "").slice(-MAX_TAIL_CHARS),
                })
            }
            return out
        } finally {
            await removeCheckout(repoCwd, dir)
        }
    }

    private async defaultCheckout(repoCwd: string, rev: string, dir: string): Promise<void> {
        await git(repoCwd, ["worktree", "add", "--detach", dir, rev])
        // A full dependency copy per recheck is tens of thousands of new files for
        // the OS scanners; the run's own integration tree already holds them.
        if (this.opts.dependencyRoot && linkDependencyDirs(this.opts.dependencyRoot, dir)) return
        await materializeDependencies({ hostRoot: this.opts.hostRoot, integrationRoot: dir })
    }
}

/** Links each dependency dir the integration tree has into the checkout; false if it has none. */
function linkDependencyDirs(from: string, to: string): boolean {
    const dirs = ["", ...workspacePackageDirs(from, readWorkspaces(from)).map((dir) => relative(from, dir))]
        .filter((rel) => existsSync(join(from, rel, "node_modules")))
    for (const rel of dirs) {
        const target = join(to, rel, "node_modules")
        if (!existsSync(join(to, rel)) || existsSync(target)) continue
        symlinkSync(join(from, rel, "node_modules"), target, "junction")
    }
    return dirs.length > 0
}

function readWorkspaces(dir: string): unknown {
    try {
        return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { workspaces?: unknown }).workspaces
    } catch {
        return undefined
    }
}

async function runGatesByLabel(dir: string, labels: readonly string[]): Promise<VerifyCommandResult[]> {
    const wanted = new Set(labels)
    const commands = createVerifyPlan(dir).commands.filter((spec) => wanted.has(spec.label))
    const result = await verifyBuild(dir, {
        plan: { commands },
        refreshDependencies: false,
        emitActivity: () => {},
    })
    return result.commands.filter((command) => wanted.has(command.command))
}

/** The worktree's current files, untracked included, as a commit; the story's index is untouched. */
async function snapshotCommit(cwd: string): Promise<{ commit: string; tree: string }> {
    const indexDir = mkdtempSync(join(tmpdir(), "baro-recheck-index-"))
    try {
        const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, "index") }
        await git(cwd, ["read-tree", "HEAD"], env)
        await git(cwd, ["add", "-A"], env)
        const tree = (await git(cwd, ["write-tree"], env)).trim()
        const commit = (await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "baro host recheck"], {
            ...process.env,
            GIT_AUTHOR_NAME: "baro",
            GIT_AUTHOR_EMAIL: "baro@localhost",
            GIT_COMMITTER_NAME: "baro",
            GIT_COMMITTER_EMAIL: "baro@localhost",
        })).trim()
        return { commit, tree }
    } finally {
        rmSync(indexDir, { recursive: true, force: true })
    }
}

async function removeCheckout(repoCwd: string, dir: string): Promise<void> {
    try {
        await git(repoCwd, ["worktree", "remove", "--force", dir])
    } catch {
        // never registered (a seam checkout) or already gone
    }
    rmSync(resolve(dir, ".."), { recursive: true, force: true })
}

async function changedPaths(cwd: string, baseSha: string | null): Promise<string[]> {
    if (!baseSha) return []
    try {
        const tracked = await git(cwd, ["diff", "--name-only", baseSha])
        const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"])
        return `${tracked}\n${untracked}`.split("\n").map((line) => line.trim()).filter(Boolean)
    } catch {
        return []
    }
}

/**
 * Gate specs a shell command ran: a segment equal to the gate's own argv,
 * in the gate's directory. Without a `cd` the shell's directory is unknown,
 * so a name shared by several packages narrows to the ones the story changed.
 */
export function matchGateSpecs(
    root: string,
    command: string,
    specs: readonly VerifyCommandSpec[],
    changed: readonly string[],
): VerifyCommandSpec[] {
    const found: VerifyCommandSpec[] = []
    let dir: string | null = null
    for (const segment of segments(command)) {
        const words = segment.split(/\s+/).filter((word) => word && !/^\d?[<>]&?\S*$/.test(word))
        if (words[0] === "cd" && words.length === 2) {
            dir = resolve(dir ?? root, words[1]!)
            continue
        }
        // A narrowed run (`cargo test -p x`, `npm run test:fast -- a.test.ts`) maps to its
        // whole gate: the host runs the declared command, never the agent's arguments.
        const same = specs.filter((spec) =>
            !spec.preflightFailure &&
            !spec.incompleteReason &&
            words.length >= spec.args.length + 1 &&
            words[0] === spec.tool &&
            spec.args.every((arg, index) => words[index + 1] === arg),
        )
        if (dir !== null) {
            const at = dir
            found.push(...same.filter((spec) =>
                resolve(spec.cwd ?? root) === at ||
                (spec.cwd === undefined && WORKSPACE_TOOLS.has(spec.tool) && !escapes(root, at)),
            ))
            continue
        }
        if (same.length <= 1) {
            found.push(...same)
            continue
        }
        found.push(...same.filter((spec) => {
            const pkg = relative(root, spec.cwd ?? root)
            return changed.some((path) => pkg === "" || path === pkg || path.startsWith(`${pkg}${sep}`) || path.startsWith(`${pkg}/`))
        }))
    }
    return found.filter((spec, index) => found.indexOf(spec) === index && !escapes(root, spec.cwd))
}

/** Find their workspace from any directory inside it. */
const WORKSPACE_TOOLS = new Set(["cargo", "go"])

function escapes(root: string, cwd: string | undefined): boolean {
    if (!cwd) return false
    const rel = relative(root, cwd)
    return rel.startsWith("..") || isAbsolute(rel)
}

function segments(command: string): string[] {
    return command
        .split(/(?:&&|\|\||;|\||\r?\n)/u)
        .map((segment) => segment.trim().replace(/^\(+\s*/u, "").replace(/\)+$/u, "").replace(/^(?:[A-Za-z_]\w*=\S+\s+)+/u, ""))
        .filter(Boolean)
}

function stillRunning(labels: readonly string[], budgetMs: number): string {
    return [
        "## Host recheck of failing gate commands",
        `Baro is re-running ${labels.map((label) => `\`${label}\``).join(", ")} outside the story's sandbox, and it did not finish within ${Math.round(budgetMs / 1000)} s. Its result will be in the next review of the same files. Judge these commands from the other evidence now, and do not hold the missing recheck against the story.`,
    ].join("\n")
}

function render(
    labels: readonly string[],
    atHead: Map<string, Outcome> | null,
    atBase: Map<string, Outcome> | null,
    problem: string | null,
): string {
    const lines = [
        "## Host recheck of failing gate commands",
        "These repository gate commands failed in the story's sandbox. Baro ran them again itself, outside the sandbox, on an exact copy of the story's current files, and at the story's base commit where they still failed. This is Baro-captured evidence and it outranks the story's own sandboxed runs of the same commands.",
        "- Passed on the story's files: the sandboxed failure was the environment's. Treat the command as passing.",
        "- Failed on the story's files and at the base commit: compare the two outputs. Failures present at base are pre-existing; only failures absent at base count against the story.",
        "- Failed on the story's files only: a regression.",
        "",
    ]
    if (problem) lines.push(`Recheck incomplete: ${problem}. Judge these commands from the other evidence.`, "")
    for (const label of labels) {
        const head = atHead?.get(label)
        if (!head) {
            if (atHead) lines.push(`### \`${label}\``, "story's files: not run", "")
            continue
        }
        lines.push(`### \`${label}\``, `story's files: ${head.status}`)
        if (head.status === "failed") {
            lines.push("```", head.tail.trim() || "(no output)", "```")
            const base = atBase?.get(label)
            lines.push(`base commit: ${base ? base.status : "not run"}`)
            if (base?.status === "failed") lines.push("```", base.tail.trim() || "(no output)", "```")
        }
        lines.push("")
    }
    return lines.join("\n").trimEnd()
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await runRepositoryCommand("git", args, { cwd, ...(env ? { env } : {}) })
    return stdout
}

function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
