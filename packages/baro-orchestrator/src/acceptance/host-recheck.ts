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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { materializeDependencies } from "../integration/dependency-materializer.js"
import { runRepositoryCommand } from "../integration/repository-command.js"
import {
    createVerifyPlan,
    verifyBuild,
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

export interface HostRecheckOptions {
    hostRoot: string
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
    private readonly atBase = new Map<string, Promise<Map<string, Outcome>>>()

    constructor(private readonly opts: HostRecheckOptions) {}

    /** Rechecks run one at a time: each is a full gate run on the host. */
    section(request: HostRecheckRequest): Promise<string | null> {
        const next = this.queue.then(() => this.recheck(request))
        this.queue = next.catch(() => undefined)
        return next
    }

    private async recheck(request: HostRecheckRequest): Promise<string | null> {
        const specs = createVerifyPlan(request.cwd).commands
        const changed = await changedPaths(request.cwd, request.baseSha)
        const labels = [
            ...new Set(request.failedCommands.flatMap((command) =>
                matchGateSpecs(request.cwd, command, specs, changed).map((spec) => spec.label),
            )),
        ]
        if (labels.length === 0) return null
        let atHead: Map<string, Outcome>
        try {
            const snapshot = await snapshotCommit(request.cwd)
            atHead = await this.runAt(request.cwd, snapshot, labels)
        } catch (error) {
            return render(labels, null, null, `the host could not run them: ${errMsg(error)}`)
        }
        const stillFailing = labels.filter((label) => atHead.get(label)?.status === "failed")
        let atBase: Map<string, Outcome> | null = null
        if (stillFailing.length > 0 && request.baseSha) {
            try {
                atBase = await this.baseOutcomes(request.cwd, request.baseSha, stillFailing)
            } catch (error) {
                return render(labels, atHead, null, `the base commit could not be checked: ${errMsg(error)}`)
            }
        }
        return render(labels, atHead, atBase, null)
    }

    private async baseOutcomes(
        cwd: string,
        baseSha: string,
        labels: readonly string[],
    ): Promise<Map<string, Outcome>> {
        const out = new Map<string, Outcome>()
        const missing: string[] = []
        for (const label of labels) {
            const cached = this.atBase.get(`${baseSha}\0${label}`)
            const hit = cached ? (await cached).get(label) : undefined
            if (hit) out.set(label, hit)
            else missing.push(label)
        }
        if (missing.length > 0) {
            const pending = this.runAt(cwd, baseSha, missing)
            for (const label of missing) this.atBase.set(`${baseSha}\0${label}`, pending)
            try {
                for (const [label, outcome] of await pending) out.set(label, outcome)
            } catch (error) {
                for (const label of missing) this.atBase.delete(`${baseSha}\0${label}`)
                throw error
            }
        }
        return out
    }

    private async runAt(repoCwd: string, rev: string, labels: readonly string[]): Promise<Map<string, Outcome>> {
        const root = this.opts.scratchRoot ?? tmpdir()
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
        await materializeDependencies({ hostRoot: this.opts.hostRoot, integrationRoot: dir })
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
async function snapshotCommit(cwd: string): Promise<string> {
    const indexDir = mkdtempSync(join(tmpdir(), "baro-recheck-index-"))
    try {
        const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, "index") }
        await git(cwd, ["read-tree", "HEAD"], env)
        await git(cwd, ["add", "-A"], env)
        const tree = (await git(cwd, ["write-tree"], env)).trim()
        return (await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "baro host recheck"], {
            ...process.env,
            GIT_AUTHOR_NAME: "baro",
            GIT_AUTHOR_EMAIL: "baro@localhost",
            GIT_COMMITTER_NAME: "baro",
            GIT_COMMITTER_EMAIL: "baro@localhost",
        })).trim()
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
