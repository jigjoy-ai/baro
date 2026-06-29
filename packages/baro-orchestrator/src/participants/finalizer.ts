/**
 * Finalizer — the "Ship" half of `Plan. Parallelize. Review. Ship.`
 *
 * Listens for the canonical end-of-run signals on the bus and, when the
 * run has produced real commits on a branch with a remote, opens a pull
 * request whose body is auto-generated from everything the bus saw:
 * stories table with per-story durations and commit SHAs, DAG plan,
 * diff stats, run summary.
 *
 * Bus-only. Knows nothing about the TUI, doesn't touch prd.json
 * directly (Conductor already loaded the canonical PRD into memory and
 * we read a fresh copy at PR-creation time so any Surgeon replans are
 * reflected), doesn't import Conductor internals. Reacts to:
 *
 *   - RunStartedItem        → capture start time + base SHA + branch
 *   - LevelStartedItem      → record DAG level membership
 *   - StoryResultItem       → collect per-story outcome + duration
 *   - RunCompletedItem      → kick off PR creation and emit PrCreatedItem
 *
 * Failure modes (all degrade to "no PR, log the reason on the bus"):
 *   - no `gh` binary on PATH
 *   - no `origin` remote (covered by orchestrate.ts gating before join)
 *   - all stories failed (success === false in RunCompletedItem)
 *   - working tree has zero commits ahead of base SHA
 *   - `gh pr create` returns non-zero
 */

import { execFile } from "child_process"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { promisify } from "util"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import { buildDag } from "../dag.js"
import { getHeadSha } from "../git.js"
import { BARO_COAUTHOR_TRAILER, loadPrd, type PrdFile, type PrdStory } from "../prd.js"
import {
    FinalizeStarted,
    LevelStarted,
    PrCreated,
    RunCompleted,
    RunStarted,
    StoryResult,
    type RunCompletedData,
} from "../semantic-events.js"

const execFileAsync = promisify(execFile)

export interface FinalizerOptions {
    cwd: string
    prdPath: string
    /** Optional explicit base SHA. If omitted, captured from RunStartedItem flow. */
    baseSha?: string | null
    /**
     * If false, Finalizer collects events but skips the `gh pr create`
     * call. Useful for tests. Default: true.
     */
    createPr?: boolean
    /** Optional logger; receives single-line strings without a trailing newline. */
    onLog?: (line: string) => void
}

interface StoryRecord {
    id: string
    title: string
    success: boolean | null
    durationSecs: number | null
    attempts: number
    levelOrdinal: number | null
}

export class Finalizer extends BaseObserver {
    private readonly opts: Required<Omit<FinalizerOptions, "baseSha" | "onLog">> &
        Pick<FinalizerOptions, "onLog">
    private envRef: AgenticEnvironment | null = null

    private startedAtMs: number | null = null
    private baseSha: string | null
    private branchName: string | null = null
    /**
     * DAG levels keyed by their ordinal as emitted in
     * LevelStartedItem. We use a Map rather than an array because
     * Conductor's ordinals are 1-based and would otherwise leave a
     * `levels[0] = undefined` hole that crashes any `for...of`
     * iteration (it walks holes too).
     */
    private readonly levels = new Map<number, string[]>()
    private readonly stories = new Map<string, StoryRecord>()
    /**
     * Resolves once finalize() has completed (or been short-circuited).
     * Lets orchestrate.ts gate its TUI `done` event so the PR URL lands
     * in the completion screen instead of after it.
     */
    private finalizePromise: Promise<void> | null = null

    constructor(opts: FinalizerOptions) {
        super()
        this.opts = {
            cwd: opts.cwd,
            prdPath: opts.prdPath,
            createPr: opts.createPr ?? true,
            onLog: opts.onLog,
        }
        this.baseSha = opts.baseSha ?? null
    }

    setEnvironment(env: AgenticEnvironment): void {
        this.envRef = env
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (RunStarted.is(event)) {
            this.startedAtMs = Date.now()
            // Capture base SHA at run start so we can later list commits
            // produced by the run regardless of how many branches Conductor
            // ends up on.
            if (this.baseSha == null) {
                this.baseSha = await getHeadSha(this.opts.cwd)
            }
            const prd = this.safeLoadPrd()
            this.branchName = prd?.branchName ?? null
            return
        }

        if (LevelStarted.is(event)) {
            const { ordinal, storyIds } = event.data
            this.levels.set(ordinal, [...storyIds])
            for (const id of storyIds) {
                if (!this.stories.has(id)) {
                    this.stories.set(id, {
                        id,
                        title: "",
                        success: null,
                        durationSecs: null,
                        attempts: 0,
                        levelOrdinal: ordinal,
                    })
                } else {
                    const rec = this.stories.get(id)!
                    rec.levelOrdinal = ordinal
                }
            }
            return
        }

        if (StoryResult.is(event)) {
            const d = event.data
            const existing = this.stories.get(d.storyId) ?? {
                id: d.storyId,
                title: "",
                success: null,
                durationSecs: null,
                attempts: 0,
                levelOrdinal: null,
            }
            existing.success = d.success
            existing.durationSecs = d.durationSecs
            existing.attempts = d.attempts
            this.stories.set(d.storyId, existing)
            return
        }

        if (RunCompleted.is(event)) {
            // Wrap finalize() so a bug inside this participant never
            // takes down the orchestrator. The whole run has already
            // succeeded by the time we get here — losing the PR is a
            // recoverable annoyance, killing the process and orphaning
            // Claude children is not.
            this.finalizePromise = this.safeFinalize(event.data)
            await this.finalizePromise
            return
        }
    }

    private async safeFinalize(run: RunCompletedData): Promise<void> {
        try {
            await this.finalize(run)
        } catch (e) {
            const msg = (e as Error)?.stack ?? String(e)
            this.log(`[finalizer] internal error, skipping PR: ${msg.split("\n")[0]}`)
            process.stderr.write(`[finalizer] crash: ${msg}\n`)
            this.emit(
                PrCreated.create({
                    url: null,
                    branch: this.branchName ?? "",
                    baseBranch: "",
                }),
            )
        }
    }

    /**
     * Resolves once Finalizer has finished handling RunCompletedItem
     * (PR opened, skipped, or failed). Resolves immediately if no run
     * has completed yet. Safe to call multiple times.
     */
    complete(): Promise<void> {
        return this.finalizePromise ?? Promise.resolve()
    }

    private async finalize(run: RunCompletedData): Promise<void> {
        if (!this.opts.createPr) return

        if (!run.success) {
            this.log(
                `[finalizer] run did not complete successfully (${run.abortReason ?? "no reason"}); skipping PR`,
            )
            this.emit(
                PrCreated.create({
                    url: null,
                    branch: this.branchName ?? "",
                    baseBranch: "",
                }),
            )
            return
        }

        if (!(await this.hasGhBinary())) {
            this.log("[finalizer] `gh` not found on PATH; skipping PR creation")
            this.emit(
                PrCreated.create({
                    url: null,
                    branch: this.branchName ?? "",
                    baseBranch: "",
                }),
            )
            return
        }

        const branch = this.branchName ?? (await this.detectBranch())
        if (!branch) {
            this.log("[finalizer] could not determine branch; skipping PR")
            this.emit(PrCreated.create({ url: null, branch: "", baseBranch: "" }))
            return
        }

        const baseBranch = await this.detectDefaultBaseBranch()
        if (!baseBranch) {
            this.log("[finalizer] could not determine base branch; skipping PR")
            this.emit(PrCreated.create({ url: null, branch, baseBranch: "" }))
            return
        }
        if (branch === baseBranch) {
            this.log(
                `[finalizer] branch '${branch}' matches base; skipping PR (run committed straight to main?)`,
            )
            this.emit(PrCreated.create({ url: null, branch, baseBranch }))
            return
        }

        // Tell observers we're now in the "composing + sending PR" phase
        // so a UI can show a spinner / progress block instead of jumping
        // straight to the completion screen.
        this.emit(FinalizeStarted.create({ branch }))

        // Hydrate story titles from the canonical PRD that Conductor was
        // working from at the moment the run ended. This is important
        // when Surgeon replans midway through — we want the user to see
        // the *final* titles, not the original ones.
        const prd = this.safeLoadPrd()
        if (prd) {
            for (const s of prd.userStories) {
                const rec = this.stories.get(s.id)
                if (rec && !rec.title) rec.title = s.title
            }
        }

        // Persist the Architect's ADRs as committed files under adr/ so the
        // decisions live in the repo (and land in this PR), not just prd.json.
        await this.writeAndCommitAdrs(prd)

        // Build a SHA → first-line-of-message map for everything between
        // the base SHA and HEAD. We can't reliably attribute commits to
        // stories one-to-one because some stories produce multiple
        // commits and some commits don't carry the story ID, but we
        // *can* show the user the canonical "first commit per story" by
        // best-effort matching on title keywords.
        const commits = await this.collectCommitsSinceBase()

        const orderedStories = this.orderStories()
        const { passed, failed } = this.partition(orderedStories)
        const filesStats = await this.collectFileStats()
        const totalSecs = run.totalDurationSecs

        const title = this.buildPrTitle(prd, passed.length, orderedStories.length)
        const body = this.buildPrBody({
            prd,
            run,
            orderedStories,
            passed,
            failed,
            commits,
            filesStats,
            totalSecs,
            sequentialSecs: this.sequentialSeconds(),
        })

        // The per-story merge-back push (gitPushWithRetry) is async and can still
        // be in flight when RunCompleted fires this finalizer — which races
        // `gh pr create` into "No commits between <base> and <branch>". Push the
        // head (awaited) here so the remote branch has the run's commits first.
        await this.pushBranch(branch)

        this.log(`[finalizer] opening PR on ${baseBranch} ← ${branch}`)
        const url = await this.openPr({ title, body, baseBranch, branch })

        if (url) {
            this.log(`[finalizer] PR opened: ${url}`)
        }
        this.emit(PrCreated.create({ url, branch, baseBranch }))
    }

    // ─── Bus & env helpers ──────────────────────────────────────────

    private emit(event: SemanticEvent<unknown>): void {
        this.envRef?.deliverSemanticEvent(this, event)
    }

    private log(line: string): void {
        this.opts.onLog?.(line)
    }

    // ─── PRD ────────────────────────────────────────────────────────

    private safeLoadPrd(): PrdFile | null {
        try {
            return loadPrd(this.opts.prdPath)
        } catch {
            return null
        }
    }

    // ─── ADRs ───────────────────────────────────────────────────────

    /**
     * Split the Architect's decision document into individual ADRs and write
     * each as adr/NNNN-slug.md, then commit them so they ship in the PR. The
     * trivial "no cross-cutting decisions needed" placeholder is skipped, and
     * an unchanged adr/ (re-run) produces no empty commit. Best-effort: any
     * failure is logged and never aborts finalization.
     */
    private async writeAndCommitAdrs(prd: PrdFile | null): Promise<void> {
        const doc = prd?.decisionDocument
        if (!doc || !doc.trim()) return
        const adrs = parseAdrs(doc)
        if (adrs.length === 0) return
        try {
            const dir = join(this.opts.cwd, "adr")
            mkdirSync(dir, { recursive: true })
            for (const a of adrs) {
                const num = a.num.padStart(4, "0")
                writeFileSync(join(dir, `${num}-${slugify(a.title)}.md`), `# ADR-${num}: ${a.title}\n\n${a.body}\n`)
            }
            await execFileAsync("git", ["add", "adr"], { cwd: this.opts.cwd })
            try {
                await execFileAsync(
                    "git",
                    ["commit", "-m", `docs: architecture decision records (${adrs.length})\n\n${BARO_COAUTHOR_TRAILER}`],
                    { cwd: this.opts.cwd },
                )
                this.log(`[finalizer] wrote ${adrs.length} ADR(s) to adr/`)
            } catch {
                // Nothing staged (identical adr/ already committed) — fine.
            }
        } catch (e) {
            this.log(`[finalizer] could not write ADRs: ${(e as Error).message}`)
        }
    }

    // ─── Story ordering & partitioning ──────────────────────────────

    /**
     * Stories returned in DAG order so the table reads top-down the same
     * way the run executed: lowest-ordinal level first. Within a level
     * we sort by id (stable) to keep the table deterministic.
     */
    private orderStories(): StoryRecord[] {
        const seen = new Set<string>()
        const ordered: StoryRecord[] = []
        const ordinals = [...this.levels.keys()].sort((a, b) => a - b)
        for (const ord of ordinals) {
            const ids = this.levels.get(ord)
            if (!ids) continue
            const sorted = [...ids].sort()
            for (const id of sorted) {
                const rec = this.stories.get(id)
                if (rec && !seen.has(id)) {
                    ordered.push(rec)
                    seen.add(id)
                }
            }
        }
        // Catch any stories Surgeon added that never made it into a
        // LevelStartedItem we observed.
        for (const [id, rec] of this.stories.entries()) {
            if (!seen.has(id)) ordered.push(rec)
        }
        return ordered
    }

    private partition(stories: StoryRecord[]): {
        passed: StoryRecord[]
        failed: StoryRecord[]
    } {
        const passed: StoryRecord[] = []
        const failed: StoryRecord[] = []
        for (const s of stories) {
            if (s.success === true) passed.push(s)
            else if (s.success === false) failed.push(s)
        }
        return { passed, failed }
    }

    private sequentialSeconds(): number {
        let sum = 0
        for (const s of this.stories.values()) {
            if (s.durationSecs && s.success !== false) sum += s.durationSecs
        }
        return sum
    }

    // ─── Git / commits / files ──────────────────────────────────────

    private async collectCommitsSinceBase(): Promise<
        { sha: string; subject: string }[]
    > {
        if (!this.baseSha) return []
        try {
            const { stdout } = await execFileAsync(
                "git",
                ["log", `${this.baseSha}..HEAD`, "--pretty=format:%H%x09%s"],
                { cwd: this.opts.cwd },
            )
            return stdout
                .split("\n")
                .filter((l) => l.includes("\t"))
                .map((l) => {
                    const [sha, ...rest] = l.split("\t")
                    return { sha, subject: rest.join("\t").trim() }
                })
        } catch {
            return []
        }
    }

    private async collectFileStats(): Promise<{
        created: number
        modified: number
    }> {
        if (!this.baseSha) return { created: 0, modified: 0 }
        try {
            const { stdout } = await execFileAsync(
                "git",
                ["diff", "--name-status", this.baseSha, "HEAD"],
                { cwd: this.opts.cwd },
            )
            let created = 0
            let modified = 0
            for (const line of stdout.split("\n")) {
                const ch = line.charAt(0)
                if (ch === "A") created++
                else if (ch === "M" || ch === "R") modified++
            }
            return { created, modified }
        } catch {
            return { created: 0, modified: 0 }
        }
    }

    private async detectBranch(): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(
                "git",
                ["branch", "--show-current"],
                { cwd: this.opts.cwd },
            )
            return stdout.trim() || null
        } catch {
            return null
        }
    }

    private async detectDefaultBaseBranch(): Promise<string | null> {
        // Prefer the remote's default branch from `gh repo view`. Fall
        // back to a `git remote show origin` parse, then to "main".
        try {
            const { stdout } = await execFileAsync(
                "gh",
                ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
                { cwd: this.opts.cwd },
            )
            const name = stdout.trim()
            if (name) return name
        } catch {
            // fall through
        }
        try {
            const { stdout } = await execFileAsync(
                "git",
                ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
                { cwd: this.opts.cwd },
            )
            const ref = stdout.trim()
            if (ref.startsWith("origin/")) return ref.slice("origin/".length)
        } catch {
            // fall through
        }
        return "main"
    }

    // ─── PR body composition ────────────────────────────────────────

    private buildPrTitle(
        prd: PrdFile | null,
        passed: number,
        total: number,
    ): string {
        const project = prd?.project ?? "baro run"
        if (passed === total) {
            return `${project} (${total} ${total === 1 ? "story" : "stories"})`
        }
        return `${project} (${passed}/${total} stories)`
    }

    private buildPrBody(args: {
        prd: PrdFile | null
        run: RunCompletedData
        orderedStories: StoryRecord[]
        passed: StoryRecord[]
        failed: StoryRecord[]
        commits: { sha: string; subject: string }[]
        filesStats: { created: number; modified: number }
        totalSecs: number
        sequentialSecs: number
    }): string {
        const { prd, run, orderedStories, passed, failed, commits, filesStats } =
            args
        const lines: string[] = []

        lines.push(
            `> Opened by [baro](https://baro.rs) — Mozaik-orchestrated parallel coding agents.`,
        )
        lines.push("")

        if (prd?.description) {
            lines.push("## Goal")
            lines.push("")
            lines.push(prd.description.trim())
            lines.push("")
        }

        // DAG plan
        if (this.levels.size > 0) {
            lines.push("## Plan")
            lines.push("")
            lines.push("```")
            const ordinals = [...this.levels.keys()].sort((a, b) => a - b)
            for (const ord of ordinals) {
                const ids = this.levels.get(ord) ?? []
                lines.push(`Level ${ord} ─── ${ids.join(", ")}`)
            }
            lines.push("```")
            lines.push("")
        }

        // Stories table
        lines.push("## Stories")
        lines.push("")
        lines.push("| # | Story | Status | Duration | Commit |")
        lines.push("|---|-------|--------|----------|--------|")
        for (const s of orderedStories) {
            const title = (s.title || s.id).replace(/\|/g, "\\|")
            const status =
                s.success === true ? "✓" : s.success === false ? "✗" : "—"
            const dur =
                s.durationSecs != null ? formatDuration(s.durationSecs) : "—"
            const commit = matchCommit(s, commits)
            lines.push(
                `| ${s.id} | ${title} | ${status} | ${dur} | ${commit ? "`" + commit.slice(0, 7) + "`" : "—"} |`,
            )
        }
        lines.push("")

        // Diff stats
        lines.push("## Diff stats")
        lines.push("")
        lines.push(`- **Files created**: ${filesStats.created}`)
        lines.push(`- **Files modified**: ${filesStats.modified}`)
        lines.push(`- **Total commits**: ${commits.length}`)
        lines.push("")

        // Run summary
        lines.push("## Run summary")
        lines.push("")
        const wall = formatDuration(args.totalSecs)
        const seq = formatDuration(args.sequentialSecs)
        const speedup =
            args.totalSecs > 0
                ? (args.sequentialSecs / args.totalSecs).toFixed(2) + "×"
                : "—"
        lines.push(`- **Wall time**: ${wall}`)
        lines.push(`- **Sequential time**: ${seq}`)
        lines.push(`- **Parallel speedup**: ${speedup}`)
        lines.push(`- **Stories passed**: ${passed.length}/${orderedStories.length}`)
        lines.push(`- **Stories failed**: ${failed.length}`)
        lines.push(`- **Total story attempts**: ${run.totalAttempts}`)
        if (run.abortReason) {
            lines.push(`- **Abort reason**: ${run.abortReason}`)
        }
        lines.push("")

        lines.push("---")
        lines.push("")
        lines.push("🤖 Plan. Parallelize. Review. Ship. — opened by baro")
        // Co-author trailer on the PR body itself so a GitHub
        // "Squash and merge" picks it up — the squashed commit's body
        // is the PR body, so the trailer flows through to the merge
        // commit and attributes the run to @baro-rs on top of the
        // per-story commits agents already trailed.
        lines.push("")
        lines.push(BARO_COAUTHOR_TRAILER)

        return lines.join("\n")
    }

    private async hasGhBinary(): Promise<boolean> {
        try {
            await execFileAsync("gh", ["--version"], { cwd: this.opts.cwd })
            return true
        } catch {
            return false
        }
    }

    // Ensure the remote head branch is up to date with the local integration
    // branch (which has the merged story commits by RunCompleted time) before we
    // open the PR. Best-effort: if it's already pushed or has no remote, openPr
    // surfaces the real outcome.
    private async pushBranch(branch: string): Promise<void> {
        try {
            await execFileAsync("git", ["push", "origin", branch], { cwd: this.opts.cwd })
        } catch (e) {
            const detail = ((e as { stderr?: string }).stderr ?? (e as Error).message).split("\n")[0]?.trim()
            this.log(`[finalizer] pre-PR push: ${detail}`)
        }
    }

    private async openPr(args: {
        title: string
        body: string
        baseBranch: string
        branch: string
    }): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(
                "gh",
                [
                    "pr",
                    "create",
                    "--base",
                    args.baseBranch,
                    "--head",
                    args.branch,
                    "--title",
                    args.title,
                    "--body",
                    args.body,
                ],
                { cwd: this.opts.cwd },
            )
            const url = stdout.trim().split("\n").pop() ?? ""
            return url || null
        } catch (e) {
            // If a PR already exists for this branch, gh prints to
            // stderr and exits non-zero. Surface the existing URL
            // instead of pretending the call failed.
            const stderr = (e as { stderr?: string })?.stderr ?? ""
            const existing = stderr.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0]
            if (existing) {
                this.log(`[finalizer] PR already exists: ${existing}`)
                return existing
            }
            this.log(
                `[finalizer] gh pr create failed: ${stderr.split("\n")[0]?.trim() || (e as Error).message}`,
            )
            return null
        }
    }
}

// ─── module-private helpers ─────────────────────────────────────────

// Split the decision document on "## ADR-NNN: title" headers into records.
// The leading "## Existing context" preamble (no ADR- prefix) is ignored.
function parseAdrs(doc: string): { num: string; title: string; body: string }[] {
    const adrs: { num: string; title: string; body: string[] }[] = []
    let cur: { num: string; title: string; body: string[] } | null = null
    for (const ln of doc.replace(/\r/g, "").split("\n")) {
        const m = ln.match(/^##\s+ADR-(\d+):\s*(.*)$/)
        if (m) {
            if (cur) adrs.push(cur)
            cur = { num: m[1], title: m[2].trim(), body: [] }
        } else if (cur) {
            cur.body.push(ln)
        }
    }
    if (cur) adrs.push(cur)
    return adrs
        .filter((a) => !/no cross-cutting decisions/i.test(a.title))
        .map((a) => ({ num: a.num, title: a.title, body: a.body.join("\n").trim() }))
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "decision"
}

function formatDuration(secs: number): string {
    if (secs < 60) return `${Math.round(secs)}s`
    const m = Math.floor(secs / 60)
    const s = Math.round(secs % 60)
    return `${m}:${s.toString().padStart(2, "0")}`
}

/**
 * Best-effort match of a commit to a story. We look for the story's id
 * (e.g. "S3") at word-boundaries in the commit subject, then fall back
 * to title-keyword overlap. Returns the first matching commit SHA, or
 * null if nothing plausibly belongs to this story.
 */
function matchCommit(
    story: StoryRecord,
    commits: { sha: string; subject: string }[],
): string | null {
    if (commits.length === 0) return null

    const idPattern = new RegExp(`\\b${story.id}\\b`, "i")
    for (const c of commits) {
        if (idPattern.test(c.subject)) return c.sha
    }

    if (!story.title) return null
    const keywords = story.title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4)
    if (keywords.length === 0) return null

    let bestSha: string | null = null
    let bestScore = 0
    for (const c of commits) {
        const subj = c.subject.toLowerCase()
        const hits = keywords.reduce((n, k) => (subj.includes(k) ? n + 1 : n), 0)
        if (hits > bestScore) {
            bestScore = hits
            bestSha = c.sha
        }
    }
    return bestScore >= 2 ? bestSha : null
}
