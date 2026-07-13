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
import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"
import {
    FinalizeStarted,
    LevelStarted,
    PrCreated,
    RunCompleted,
    RunStarted,
    RunVerificationCompleted,
    StoryMergeFailed,
    StoryMerged,
    StoryResult,
    type RunCompletedData,
    type RunVerificationEvidence,
} from "../semantic-events.js"
import { verifyBuild, type VerifyResult } from "../verify.js"

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
    /** Run identity used to reject cross-run collective events. */
    runId?: string
    /** Collective exact-source registry for dynamic StoryResult producers. */
    outcomeAuthority?: StoryOutcomeAuthority
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
    private readonly opts: Required<Omit<
        FinalizerOptions,
        "baseSha" | "onLog" | "runId" | "outcomeAuthority"
    >> &
        Pick<FinalizerOptions, "onLog">
    private envRef: AgenticEnvironment | null = null
    private readonly runId: string | null
    private readonly outcomeAuthority: StoryOutcomeAuthority | null
    private coordinationAuthority: Participant | null = null
    private repositoryAuthority: Participant | null = null
    private verifierAuthority: Participant | null = null

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
     * Stories whose merge-back failed (storyId → preserved branch). Their
     * commits never reached the integration branch, so finalize() tries to
     * recover them into the PR instead of silently shipping nothing.
     */
    private readonly mergeFailed = new Map<string, string>()
    /**
     * Resolves once finalize() has completed (or been short-circuited).
     * Lets orchestrate.ts gate its TUI `done` event so the PR URL lands
     * in the completion screen instead of after it.
     */
    private finalizePromise: Promise<void> | null = null
    /** Reuse the collective pre-completion gate instead of running it twice. */
    private objectiveVerification: { runId: string; result: VerifyResult } | null = null

    constructor(opts: FinalizerOptions) {
        super()
        this.opts = {
            cwd: opts.cwd,
            prdPath: opts.prdPath,
            createPr: opts.createPr ?? true,
            onLog: opts.onLog,
        }
        this.baseSha = opts.baseSha ?? null
        this.runId = opts.runId?.trim() || null
        this.outcomeAuthority = opts.outcomeAuthority ?? null
        if (
            this.outcomeAuthority &&
            this.runId !== this.outcomeAuthority.runId
        ) {
            throw new Error("Finalizer outcomeAuthority runId mismatch")
        }
    }

    setEnvironment(env: AgenticEnvironment): void {
        this.envRef = env
    }

    setCoordinationAuthority(authority: Participant): void {
        this.coordinationAuthority = bindAuthority(
            this.coordinationAuthority,
            authority,
            "coordination",
        )
    }

    setRepositoryAuthority(authority: Participant): void {
        this.repositoryAuthority = bindAuthority(
            this.repositoryAuthority,
            authority,
            "repository",
        )
    }

    setVerifierAuthority(authority: Participant): void {
        this.verifierAuthority = bindAuthority(
            this.verifierAuthority,
            authority,
            "verifier",
        )
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (RunStarted.is(event)) {
            if (!this.matchesAuthority(source, this.coordinationAuthority)) return
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
            if (!this.matchesAuthority(source, this.coordinationAuthority)) return
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

        if (StoryMergeFailed.is(event)) {
            if (
                !this.matchesAuthority(source, this.repositoryAuthority) ||
                !this.matchesRun(event.data.runId)
            ) return
            const d = event.data
            if (d.branch) this.mergeFailed.set(d.storyId, d.branch)
            return
        }

        if (StoryMerged.is(event)) {
            if (
                !this.matchesAuthority(source, this.repositoryAuthority) ||
                !this.matchesRun(event.data.runId)
            ) return
            // A bounded collective recovery can integrate a story after an
            // earlier merge failure. Do not leave a successful run mislabeled
            // as a checkpoint or advertise a stale recovery branch.
            this.mergeFailed.delete(event.data.storyId)
            return
        }

        if (StoryResult.is(event)) {
            if (
                this.outcomeAuthority &&
                !this.outcomeAuthority.matchesResult(source, event.data)
            ) return
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

        if (RunVerificationCompleted.is(event)) {
            if (
                (this.verifierAuthority === null && this.runId !== null) ||
                !this.matchesAuthority(source, this.verifierAuthority) ||
                !this.matchesRun(event.data.runId, true)
            ) return
            this.objectiveVerification = {
                runId: event.data.runId,
                result: verificationResult(event.data),
            }
            return
        }

        if (RunCompleted.is(event)) {
            if (
                !this.matchesAuthority(source, this.coordinationAuthority) ||
                !this.matchesRun(event.data.runId)
            ) return
            if (this.finalizePromise) return
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

    private matchesAuthority(
        source: Participant,
        authority: Participant | null,
    ): boolean {
        // Standalone Finalizer users without a run identity historically had
        // no explicit authority registry. Orchestrate always supplies runId
        // and binds its capabilities before RunStartRequest is published.
        return authority === null ? this.runId === null : source === authority
    }

    private matchesRun(eventRunId: string | undefined, required = false): boolean {
        if (this.runId === null) return true
        if (eventRunId === undefined) {
            // Collective events are fully correlated; legacy lifecycle/merge
            // events intentionally omit runId and remain source-bound.
            return !required && this.outcomeAuthority === null
        }
        return eventRunId === this.runId
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

        const preAdrStats = await this.collectFileStats()
        let hasRunChanges =
            (await this.collectCommitsSinceBase()).length > 0 ||
            preAdrStats.created + preAdrStats.modified > 0

        // ── Recover stranded merge-back work ──────────────────────────
        // A story can pass yet fail to merge onto the integration branch
        // (unresolvable conflict), leaving its commits on a preserved branch
        // that would otherwise never ship — a clean-looking run that delivers
        // nothing. Pull that work into the PR: fast-forward the (empty)
        // integration branch onto the story branch when history allows, else
        // open the PR straight from the story branch. Any story we can't fold
        // in is still pushed, so the work is recoverable rather than lost.
        let prBranch = branch
        const salvaged: string[] = []
        if (this.mergeFailed.size > 0) {
            if (!hasRunChanges) {
                for (const [sid, b] of this.mergeFailed) {
                    if (!(await this.branchHasCommits(b))) continue
                    if (await this.fastForwardTo(b)) {
                        this.log(`[finalizer] recovered story ${sid}: fast-forwarded ${branch} onto its un-merged branch`)
                        hasRunChanges = true
                    } else {
                        await this.pushBranch(b)
                        prBranch = b
                        this.log(`[finalizer] recovered story ${sid}: opening PR from its un-merged branch ${b}`)
                    }
                    salvaged.push(sid)
                    break
                }
            }
            for (const [sid, b] of this.mergeFailed) {
                if (!salvaged.includes(sid)) await this.pushBranch(b)
            }
        }
        const deliverable = hasRunChanges || prBranch !== branch

        if (!run.success && !deliverable) {
            this.log(
                `[finalizer] run failed with no branch changes (${run.abortReason ?? "no reason"}); skipping PR`,
            )
            this.emit(PrCreated.create({ url: null, branch, baseBranch }))
            return
        }
        // A run whose stories all passed but whose work was entirely stranded by
        // merge conflicts must not read as a clean, PR-less "done": point the
        // user at the recovery branches instead.
        if (run.success && !deliverable && this.mergeFailed.size > 0) {
            const stranded = [...this.mergeFailed.values()].join(", ")
            this.log(`[finalizer] all stories passed but none could merge onto ${branch}; work pushed to ${stranded} for manual recovery — no PR`)
            this.emit(PrCreated.create({ url: null, branch, baseBranch }))
            return
        }
        if (!run.success) {
            this.log(
                `[finalizer] run failed after producing changes; opening checkpoint PR (${run.abortReason ?? "no reason"})`,
            )
        }

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

        // Objective gate: build + run tests on the fully-merged branch. A run
        // the Critic judged "green" can still merge with tests actually failing;
        // a failed verify demotes the PR to a checkpoint so it isn't reported as
        // clean. "Couldn't verify" (verify.ran === false) is NOT a failure.
        this.log("[finalizer] verifying build…")
        const correlatedVerification =
            // The evidence embedded by the Board in RunCompleted is the
            // canonical verdict. A late same-run verifier event (for example
            // after a timeout) must never overwrite it.
            run.verification
                ? verificationResult(run.verification)
                : run.runId && this.objectiveVerification?.runId === run.runId
                  ? this.objectiveVerification.result
                  : null
        const verify = correlatedVerification ?? await verifyBuild(this.opts.cwd)
        if (!verify.ran) {
            this.log("[finalizer] nothing to verify (no build/test)")
        } else if (verify.ok) {
            this.log("[finalizer] ✓ build-verified")
        } else {
            this.log(`[finalizer] ⚠ verification failed: ${verify.failures[0]?.cmd ?? "build/test"}`)
        }

        // A merge-back failure means the branch is an incomplete/partial
        // integration — never present that as a fully verified completion.
        const checkpoint = !run.success || (verify.ran && !verify.ok) || this.mergeFailed.size > 0
        const title = this.buildPrTitle(prd, passed.length, orderedStories.length, checkpoint)
        const body = this.buildPrBody({
            prd,
            run,
            checkpoint,
            verify,
            orderedStories,
            passed,
            failed,
            commits,
            filesStats,
            totalSecs,
            sequentialSecs: this.sequentialSeconds(),
            mergeFailed: this.mergeFailed,
        })

        // The per-story merge-back push (gitPushWithRetry) is async and can still
        // be in flight when RunCompleted fires this finalizer — which races
        // `gh pr create` into "No commits between <base> and <branch>". Push the
        // head (awaited) here so the remote branch has the run's commits first.
        await this.pushBranch(prBranch)

        this.log(`[finalizer] opening ${checkpoint ? "checkpoint " : ""}PR on ${baseBranch} ← ${prBranch}`)
        const url = await this.openPr({ title, body, baseBranch, branch: prBranch })

        if (url) {
            this.log(`[finalizer] PR opened: ${url}`)
        }
        this.emit(PrCreated.create({ url, branch: prBranch, baseBranch }))
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

    // True when `ref` carries commits the base doesn't — i.e. there's real work
    // to recover from a preserved (un-merged) story branch.
    private async branchHasCommits(ref: string): Promise<boolean> {
        if (!this.baseSha) return false
        try {
            const { stdout } = await execFileAsync(
                "git",
                ["rev-list", "--count", `${this.baseSha}..${ref}`],
                { cwd: this.opts.cwd },
            )
            return parseInt(stdout.trim(), 10) > 0
        } catch {
            return false
        }
    }

    // Fast-forward the checked-out integration branch onto `ref`. Succeeds only
    // when HEAD is an ancestor of ref (the empty-integration recovery case), so
    // it never rewrites or discards existing merged work; false otherwise.
    private async fastForwardTo(ref: string): Promise<boolean> {
        try {
            await execFileAsync("git", ["merge", "--ff-only", ref], {
                cwd: this.opts.cwd,
            })
            return true
        } catch {
            return false
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
        checkpoint = false,
    ): string {
        const project = prd?.project ?? "baro run"
        const prefix = checkpoint ? "Checkpoint: " : ""
        if (passed === total) {
            return `${prefix}${project} (${total} ${total === 1 ? "story" : "stories"})`
        }
        return `${prefix}${project} (${passed}/${total} stories)`
    }

    private buildPrBody(args: {
        prd: PrdFile | null
        run: RunCompletedData
        checkpoint: boolean
        verify: VerifyResult
        orderedStories: StoryRecord[]
        passed: StoryRecord[]
        failed: StoryRecord[]
        commits: { sha: string; subject: string }[]
        filesStats: { created: number; modified: number }
        totalSecs: number
        sequentialSecs: number
        mergeFailed?: Map<string, string>
    }): string {
        const { prd, run, orderedStories, passed, failed, commits, filesStats } =
            args
        const lines: string[] = []

        lines.push(
            `> Opened by [baro](https://baro.rs) — Mozaik-orchestrated parallel coding agents.`,
        )
        lines.push("")
        if (args.checkpoint) {
            lines.push("> **Checkpoint PR:** baro produced branch changes, but the run failed during verification/retry/replan. Review this as a candidate fix, not a fully verified completion.")
            lines.push("")
        }

        // Merge-back conflicts: name the stories whose work couldn't be folded
        // cleanly into this branch, with the recovery branch that holds it.
        if (args.mergeFailed && args.mergeFailed.size > 0) {
            lines.push("## ⚠ Merge conflicts during integration")
            lines.push("")
            lines.push(
                "Some stories passed but couldn't be auto-merged onto the branch. Their commits are preserved on the branches below — review carefully, changes may be partial:",
            )
            lines.push("")
            for (const [storyId, b] of args.mergeFailed) {
                lines.push(`- \`${storyId}\` → recovered on \`${b}\``)
            }
            lines.push("")
        }

        // Objective build/test gate results — only shown when something that
        // actually ran returned non-zero (this is what forced the checkpoint).
        if (args.verify.ran && !args.verify.ok) {
            lines.push("## ⚠ Build/test verification failed")
            lines.push("")
            lines.push("The fully-merged branch did not pass an objective build/test check:")
            lines.push("")
            for (const f of args.verify.failures) {
                lines.push(`**\`${f.cmd}\`**`)
                lines.push("")
                lines.push("```")
                lines.push(f.tail.trim() || "(no output captured)")
                lines.push("```")
                lines.push("")
            }
        }

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

function bindAuthority(
    current: Participant | null,
    authority: Participant,
    label: string,
): Participant {
    if (current && current !== authority) {
        throw new Error(`Finalizer ${label} authority is already bound`)
    }
    return authority
}

function verificationResult(evidence: RunVerificationEvidence): VerifyResult {
    return {
        ran: evidence.status !== "skipped",
        ok: evidence.status !== "failed",
        failures: evidence.commands
            .filter((command) => command.status === "failed")
            .map((command) => ({
                cmd: command.command,
                tail: command.tail ?? "",
            })),
        commands: evidence.commands.map((command) => ({ ...command })),
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
