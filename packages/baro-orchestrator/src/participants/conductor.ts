/**
 * Conductor — Mozaik-native event-driven orchestrator.
 *
 * No `run()` method. No `await Promise.all`. No imperative `while` loop.
 * Conductor is a pure state machine: it observes bus events via
 * `onContextItem` and emits orchestration events back. The Mozaik
 * runtime drives the loop; Conductor just transitions state.
 *
 * State machine:
 *
 *   ┌──────────┐    RunStartRequest    ┌───────────┐
 *   │   idle   │ ────────────────────► │ launching │
 *   └──────────┘                       └─────┬─────┘
 *                                            │ emit RunStartedItem
 *                                            │ emit LevelComputeRequestItem
 *                                            ▼
 *                                      ┌───────────┐
 *                       LevelComputeReq│ computing │
 *                                ┌──────┤   level   │
 *                                │      └─────┬─────┘
 *                                │            │ buildDag → next level
 *                                │            │ emit LevelStartedItem
 *                                │            │ emit StorySpawnRequestItem* (for each story)
 *                                │            ▼
 *                                │      ┌───────────┐
 *                                │      │  running  │ ←── StoryResultItem
 *                                │      │   level   │     (one per story in level)
 *                                │      └─────┬─────┘
 *                                │            │ all stories in level done
 *                                │            │ emit LevelCompletedItem
 *                                │            │ apply pending replans
 *                                │            │ emit LevelComputeRequestItem
 *                                └────────────┘
 *
 *   When buildDag returns 0 levels → emit RunCompletedItem.
 *   When a level has all-failed-no-replan → emit RunCompletedItem(success=false).
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import { buildDag } from "../dag.js"
import {
    PrdFile,
    PrdStory,
    buildDefaultStoryPrompt,
    loadPrd,
    markStoryPassed,
    savePrdAtomic,
} from "../prd.js"
import {
    ConductorState,
    LevelCompleted,
    LevelComputeRequest,
    LevelStarted,
    RecoveryStarted,
    Replan,
    ReplanApplied,
    RunCompleted,
    RunStartRequest,
    RunStarted,
    StoryResult,
    StorySpawnRequest,
    type RunVerificationEvidence,
    type StoryResultData,
} from "../semantic-events.js"
import { validateLegacyReplan } from "../runtime/legacy-replan.js"

export { applyReplan } from "../prd.js"

export interface ConductorOptions {
    prdPath: string
    cwd: string
    parallel?: number
    timeoutSecs?: number
    overrideModel?: string
    defaultModel?: string
    promptTemplatePath?: string
    onStoryPassed?: (storyId: string) => Promise<void> | void
    /**
     * Called when a story fails terminally (after its retries). Used to
     * discard the story's isolated worktree + branch (#50) without merging.
     * Awaited so cleanup completes before the level boundary advances.
     */
    onStoryFailed?: (storyId: string) => Promise<void> | void
    onRunStart?: (prd: PrdFile) => Promise<void> | void
    onBeforeStoryLaunch?: (
        storyId: string,
        story: PrdStory,
    ) => Promise<string | null | undefined> | string | null | undefined
    onRunComplete?: (summary: ConductorRunSummary) => Promise<void> | void
    /**
     * Persistence seam for tests and embedders. Defaults to atomic path
     * replacement; a thrown error terminates the run before in-memory state
     * or authoritative events can advance beyond the durable PRD.
     */
    persistPrd?: (path: string, prd: PrdFile) => void
    /**
     * Seconds to wait between successive story spawns inside the same
     * DAG level. Lets early agents make a couple of exploratory Read /
     * Grep calls before their siblings start, so Librarian can cache
     * those findings and prime the later agents' prompts via
     * mid-flight broadcast or on-launch context.
     *
     * 0 = original behaviour (spawn everything in the level at once).
     * Default: 10 seconds.
     */
    intraLevelDelaySecs?: number
    /**
     * Healing actions (applied replans + recovery-level starts) allowed
     * without any story passing before the run aborts gracefully. 0
     * disables. Default 3, or env BARO_REPLAN_PROGRESS_BUDGET.
     */
    replanProgressBudget?: number
    /**
     * Soft wall-clock ceiling in seconds, checked only at level
     * boundaries (never mid-story). Default 0 = off, or env
     * BARO_RUN_SOFT_DEADLINE_SECS — kept off locally; the hosted
     * control plane sets the env var for cloud runs.
     */
    softDeadlineSecs?: number
}

export interface ConductorRunSummary {
    /** True only when every original story passed and nothing was dropped. */
    success: boolean
    /**
     * Reason a run terminated early (e.g. `onRunStart` hook failure, all
     * stories in a level failed without a replan). Null on a clean
     * end-of-DAG completion.
     */
    abortReason: string | null
    completedStories: string[]
    failedStories: string[]
    /**
     * Stories the Surgeon dropped without a replacement. The PRD no
     * longer contains them, but the run did not complete the original
     * goal — these count against the success verdict.
     */
    droppedStories: string[]
    totalDurationSecs: number
    totalAttempts: number
    /** Present when an objective run-level verification gate was requested. */
    verificationStatus?: "passed" | "failed" | "skipped"
    /** Full correlated evidence behind verificationStatus. */
    verification?: RunVerificationEvidence
}

// ConductorStateItem (was a BusEvent subclass defined here) moves to
// semantic-events.ts as `ConductorState` (defineSemanticEvent factory). The
// wire `type` string stays "conductor_state" so audit-log consumers still
// recognise the same event name.

type ConductorPhase = "idle" | "launching" | "computing" | "running" | "done"

interface RunningLevelState {
    ordinal: number
    totalLevelsHint: number
    storyIds: string[]
    pending: Set<string>
    passed: string[]
    failed: string[]
    perStoryAttempts: Map<string, number>
}

export class Conductor extends BaseObserver {
    private readonly opts: Required<
        Pick<ConductorOptions, "parallel" | "timeoutSecs" | "defaultModel">
    > &
        ConductorOptions

    private envRef: AgenticEnvironment | null = null
    private phase: ConductorPhase = "idle"
    private prd: PrdFile | null = null
    private startedAt = 0

    /** All stories that have ever passed in this run. */
    private readonly globalCompleted: string[] = []
    /** All stories that have failed terminally (after retries) in this run. */
    private readonly globalFailed: string[] = []
    /**
     * Stories removed from the PRD by a Surgeon replan without a
     * replacement. These do NOT come back to globalFailed (the failing
     * story is gone from the PRD and won't be retried) but they DO
     * count against the run's success verdict — terminateRun(success)
     * is true only when this list is empty.
     */
    private readonly globalDropped: string[] = []
    /**
     * Extra end-of-run recovery attempts, separate from each StoryAgent's own
     * retry loop. A story may exhaust its normal attempts, block the DAG, and
     * still be recoverable after sibling stories have landed more context/code.
     */
    private readonly recoveryAttempts: Map<string, number> = new Map()
    private readonly maxRecoveryAttemptsPerStory = 1
    /** Recovery levels started in this run (1-based `attempt` for RecoveryStarted). */
    private recoveryLevelsStarted = 0
    private totalAttempts = 0
    private appliedReplans = 0
    /**
     * Healing actions (replan applications + recovery-level starts) since
     * the last successful story. The Surgeon may propose forever; this is
     * the Conductor's brake — when it reaches the budget the run ends
     * gracefully so the Finalizer can ship completed work (checkpoint PR).
     */
    private replansSinceProgress = 0
    private readonly replanProgressBudget: number
    private readonly softDeadlineSecs: number

    private currentLevel: RunningLevelState | null = null

    /** Replan payloads emitted during a level. Applied at level boundary. */
    private readonly pendingReplans: unknown[] = []

    /** Stories that are queued to spawn but not yet launched (parallel cap). */
    private readonly spawnQueue: PrdStory[] = []
    /** Stories currently in flight in the active level. */
    private readonly inFlight: Set<string> = new Set()
    /**
     * Timer handle when we're deliberately spacing out intra-level
     * spawns. Re-entering `fillSpawnSlots` while this is set is a
     * no-op; the timer callback resumes pumping.
     */
    private pendingNextSpawn: ReturnType<typeof setTimeout> | null = null

    /** Resolved when the run terminates, exposed for callers that need it. */
    public readonly done: Promise<ConductorRunSummary>
    private resolveDone!: (summary: ConductorRunSummary) => void

    /**
     * Serializes event handling. Mozaik delivers events without awaiting the
     * handler, so two StoryResults settling together could interleave — one
     * spawning the next DAG level while another's `await onStoryPassed`
     * (worktree merge-back, #50) is still in flight, leaving the dependent
     * level without the merged work. Chaining handlers keeps them sequential.
     */
    private handleChain: Promise<void> = Promise.resolve()

    constructor(opts: ConductorOptions) {
        super()
        this.opts = {
            parallel: 0,
            timeoutSecs: 600,
            defaultModel: "sonnet",
            intraLevelDelaySecs: 10,
            ...opts,
        }
        // Guard against an explicit `undefined` defeating the default.
        if (this.opts.intraLevelDelaySecs == null) {
            this.opts.intraLevelDelaySecs = 10
        }
        this.replanProgressBudget =
            opts.replanProgressBudget ??
            envNonNegativeInt("BARO_REPLAN_PROGRESS_BUDGET", 3)
        this.softDeadlineSecs =
            opts.softDeadlineSecs ?? envNonNegativeInt("BARO_RUN_SOFT_DEADLINE_SECS", 0)
        this.done = new Promise<ConductorRunSummary>((resolve) => {
            this.resolveDone = resolve
        })
    }

    setEnvironment(env: AgenticEnvironment): void {
        this.envRef = env
    }

    /**
     * Single entry point. All state transitions happen here.
     *
     * Note: the Conductor self-ticks via LevelComputeRequest, so it
     * MUST receive its own emissions. Mozaik routes self vs external
     * to onInternalEvent vs onExternalEvent — we forward both into the
     * same handler so the state machine sees every event regardless of
     * source. Per-event-type guards distinguish "from outside"
     * (RunStartRequest from Operator, Replan from Surgeon, StoryResult
     * from StoryAgent) from "from self" (LevelComputeRequest).
     */
    override async onInternalEvent(event: SemanticEvent<unknown>): Promise<void> {
        await this.handle(event)
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        await this.handle(event)
    }

    private handle(event: SemanticEvent<unknown>): Promise<void> {
        // Run strictly after any in-flight handler. `.catch` on the stored
        // chain keeps one handler's failure from poisoning the queue while
        // still surfacing the rejection to this call's awaiter.
        const run = this.handleChain.then(() => this.handleEvent(event))
        this.handleChain = run.catch(() => {})
        return run
    }

    private async handleEvent(event: SemanticEvent<unknown>): Promise<void> {
        if (RunStartRequest.is(event)) {
            await this.handleRunStart()
            return
        }

        if (LevelComputeRequest.is(event)) {
            await this.handleLevelCompute()
            return
        }

        if (StoryResult.is(event)) {
            await this.handleStoryResult(event.data)
            return
        }

        if (Replan.is(event)) {
            this.pendingReplans.push(event.data)
            return
        }
    }

    private async handleRunStart(): Promise<void> {
        if (this.phase !== "idle") return
        this.phase = "launching"
        this.startedAt = Date.now()

        this.prd = loadPrd(this.opts.prdPath)
        this.emit(
            ConductorState.create({
                phase: "loading",
                detail: `${this.prd.userStories.length} stories`,
            }),
        )

        if (this.opts.onRunStart) {
            try {
                await this.opts.onRunStart(this.prd)
            } catch (e) {
                this.terminateRun(
                    false,
                    `onRunStart hook failed: ${(e as Error)?.message ?? String(e)}`,
                )
                return
            }
        }

        this.emit(
            RunStarted.create({
                project: this.prd.project,
                storyCount: this.prd.userStories.length,
                storyIds: this.prd.userStories.map((story) => story.id),
                completedStoryIds: this.prd.userStories
                    .filter((story) => story.passes)
                    .map((story) => story.id),
                coordinationMode: "legacy",
                ...(this.prd.executionMode ? { mode: this.prd.executionMode.mode } : {}),
            }),
        )
        this.phase = "computing"
        this.emit(LevelComputeRequest.create({ reason: "initial" }))
    }

    private async handleLevelCompute(): Promise<void> {
        if (this.phase !== "computing") return
        if (!this.prd) return

        const blockedStoryIds = this.computeBlockedStoryIds()
        const failedIds = new Set(this.globalFailed)
        const runnableStories = this.prd.userStories.filter(
            (s) =>
                !s.passes &&
                !failedIds.has(s.id) &&
                !blockedStoryIds.has(s.id),
        )
        const runnableIds = new Set(runnableStories.map((story) => story.id))
        const levels = buildDag(
            this.prd.userStories.filter(
                (story) => story.passes || runnableIds.has(story.id),
            ),
            { onlyIncomplete: true },
        )

        if (levels.length === 0) {
            // Run is "successful" only when every story currently in
            // the PRD has passed. A story that was dropped by a Surgeon
            // replan is no longer in the PRD; that's tracked separately
            // in globalDropped and counts against the run's success.
            const allPassed =
                this.prd.userStories.every((s) => s.passes) &&
                this.globalDropped.length === 0
            if (!allPassed && this.globalFailed.length > 0) {
                const halt = this.healingHaltReason()
                if (halt) {
                    this.terminateRun(false, halt)
                    return
                }
                const recovered = await this.tryStartRecoveryLevel(
                    this.globalFailed,
                    blockedStoryIds.size > 0
                        ? `blocked dependencies: ${[...blockedStoryIds].join(", ")}`
                        : "terminal failed stories",
                )
                if (recovered) return
            }
            const abortReason = allPassed
                ? null
                : this.globalFailed.length > 0
                  ? blockedStoryIds.size > 0
                      ? `blocked by failed dependencies: failed ${this.globalFailed.join(", ")}; blocked ${[...blockedStoryIds].join(", ")}`
                      : `stories failed: ${this.globalFailed.join(", ")}`
                  : null
            this.terminateRun(allPassed, abortReason)
            return
        }

        // Soft wall-clock ceiling: only ever checked here (a level
        // boundary, before new work spawns) so a mid-story run is
        // never cut. A run about to complete cleanly still completes —
        // the levels.length === 0 path above wins.
        const softDeadline = this.softDeadlineReason()
        if (softDeadline) {
            this.terminateRun(false, softDeadline)
            return
        }

        const level = levels[0]
        const ordinal = (this.currentLevel?.ordinal ?? 0) + 1
        const totalLevelsHint = ordinal + levels.length - 1

        const stories = level.storyIds
            .map((id) => this.prd!.userStories.find((s) => s.id === id))
            .filter((s): s is PrdStory => s !== undefined)
            .filter((s) => !s.passes)

        if (stories.length === 0) {
            // Level is empty (all already-passing); skip to next.
            this.emit(LevelComputeRequest.create({ reason: "empty level" }))
            return
        }

        this.currentLevel = {
            ordinal,
            totalLevelsHint,
            storyIds: stories.map((s) => s.id),
            pending: new Set(stories.map((s) => s.id)),
            passed: [],
            failed: [],
            perStoryAttempts: new Map(),
        }

        this.emit(
            LevelStarted.create({
                ordinal,
                totalLevelsHint,
                storyIds: this.currentLevel.storyIds,
            }),
        )
        this.emit(
            ConductorState.create({
                phase: "running_level",
                currentLevel: ordinal,
                totalLevels: totalLevelsHint,
                storyIds: this.currentLevel.storyIds,
            }),
        )

        this.phase = "running"
        this.spawnQueue.push(...stories)
        await this.fillSpawnSlots()
    }

    private async handleStoryResult(item: StoryResultData): Promise<void> {
        if (this.phase !== "running") return
        if (!this.currentLevel) return
        if (!this.currentLevel.pending.has(item.storyId)) return

        this.currentLevel.pending.delete(item.storyId)
        this.inFlight.delete(item.storyId)
        this.currentLevel.perStoryAttempts.set(item.storyId, item.attempts)
        this.totalAttempts += item.attempts

        if (item.success) {
            if (this.prd) {
                const persistedCandidate = markStoryPassed(
                    this.prd,
                    item.storyId,
                    item.durationSecs,
                )
                try {
                    this.persistPrd(persistedCandidate)
                } catch (error) {
                    this.terminateRun(
                        false,
                        `failed to persist story '${item.storyId}': ${errorMessage(error)}`,
                    )
                    return
                }
                this.prd = persistedCandidate
            }
            this.currentLevel.passed.push(item.storyId)
            this.globalCompleted.push(item.storyId)
            this.removeGlobalFailed(item.storyId)
            // Real progress: the healing budget starts over.
            this.replansSinceProgress = 0
            if (this.opts.onStoryPassed) {
                try {
                    await this.opts.onStoryPassed(item.storyId)
                } catch (e) {
                    this.emit(
                        ConductorState.create({
                            phase: "running_level",
                            detail: `onStoryPassed hook for ${item.storyId} failed: ${(e as Error)?.message ?? String(e)}`,
                            currentLevel: this.currentLevel.ordinal,
                            totalLevels: this.currentLevel.totalLevelsHint,
                        }),
                    )
                }
            }
        } else {
            this.currentLevel.failed.push(item.storyId)
            this.addGlobalFailed(item.storyId)
            if (this.opts.onStoryFailed) {
                try {
                    await this.opts.onStoryFailed(item.storyId)
                } catch (e) {
                    this.emit(
                        ConductorState.create({
                            phase: "running_level",
                            detail: `onStoryFailed hook for ${item.storyId} failed: ${(e as Error)?.message ?? String(e)}`,
                            currentLevel: this.currentLevel.ordinal,
                            totalLevels: this.currentLevel.totalLevelsHint,
                        }),
                    )
                }
            }
        }

        // Try to fill freed parallel slots with queued stories.
        await this.fillSpawnSlots()

        // If all stories in this level are settled, transition to level boundary.
        if (this.currentLevel.pending.size === 0) {
            await this.completeLevel()
        }
    }

    private async fillSpawnSlots(): Promise<void> {
        if (!this.currentLevel) return
        // If a stagger timer is in flight, just return — the timer's
        // callback re-invokes fillSpawnSlots once the gap elapses.
        if (this.pendingNextSpawn) return

        const cap =
            this.opts.parallel > 0 ? this.opts.parallel : Number.MAX_SAFE_INTEGER
        const delaySecs = this.opts.intraLevelDelaySecs ?? 0

        while (this.spawnQueue.length > 0 && this.inFlight.size < cap) {
            const story = this.spawnQueue.shift()!
            await this.requestStorySpawn(story)

            // Stagger the next spawn so Librarian has a window to
            // capture (and broadcast) the just-launched agent's first
            // exploratory tool calls before the next agent in this
            // level starts. Set delaySecs to 0 to keep the original
            // simultaneous-spawn behaviour.
            if (
                this.spawnQueue.length > 0 &&
                this.inFlight.size < cap &&
                delaySecs > 0
            ) {
                this.pendingNextSpawn = setTimeout(() => {
                    this.pendingNextSpawn = null
                    // Skip if the run terminated while we were waiting.
                    if (this.phase === "done") return
                    this.fillSpawnSlots().catch((err: unknown) => {
                        process.stderr.write(
                            `[conductor] fillSpawnSlots resume failed: ${
                                (err as Error)?.stack ?? String(err)
                            }\n`,
                        )
                    })
                }, delaySecs * 1000)
                return
            }
        }
    }

    private async requestStorySpawn(story: PrdStory): Promise<void> {
        const model =
            this.opts.overrideModel ?? story.model ?? this.opts.defaultModel
        let prompt = this.resolvePrompt(story)

        if (this.opts.onBeforeStoryLaunch) {
            try {
                const extra = await this.opts.onBeforeStoryLaunch(story.id, story)
                if (typeof extra === "string" && extra.trim().length > 0) {
                    prompt = `${extra.trim()}\n\n${prompt}`
                }
            } catch (e) {
                this.emit(
                    ConductorState.create({
                        phase: "running_level",
                        detail: `onBeforeStoryLaunch hook for ${story.id} failed: ${(e as Error)?.message ?? String(e)}`,
                    }),
                )
            }
        }

        this.inFlight.add(story.id)
        this.emit(
            StorySpawnRequest.create({
                storyId: story.id,
                prompt,
                model,
                retries: story.retries,
                timeoutSecs: this.opts.timeoutSecs,
            }),
        )
    }

    private async completeLevel(): Promise<void> {
        if (!this.currentLevel) return
        const lvl = this.currentLevel

        this.emit(
            LevelCompleted.create({
                ordinal: lvl.ordinal,
                passed: lvl.passed,
                failed: lvl.failed,
            }),
        )
        this.emit(
            ConductorState.create({
                phase: "level_complete",
                detail: `passed ${lvl.passed.length}/${lvl.passed.length + lvl.failed.length}`,
                currentLevel: lvl.ordinal,
                totalLevels: lvl.totalLevelsHint,
                storyIds: lvl.storyIds,
            }),
        )

        // Apply ReplanItem-s buffered during this level.
        let replannedThisLevel = false
        if (this.pendingReplans.length > 0 && this.prd) {
            // A safe level boundary is one logical recovery cycle. Check the
            // cycle budget before draining anything, then finish every sibling
            // proposal against the latest persisted graph. A per-item check
            // can spend the budget after the first mutation and lose the
            // unvisited tail because the queue has already been drained.
            const hasActionableReplan = this.pendingReplans.some(
                (proposal) => validateLegacyReplan(this.prd!, proposal).ok,
            )
            if (hasActionableReplan) {
                const halt = this.healingHaltReason()
                if (halt) {
                    this.terminateRun(false, halt)
                    return
                }
            }

            const drained = this.pendingReplans.splice(0)
            let appliedReplans = 0
            for (const proposal of drained) {
                const validated = validateLegacyReplan(this.prd, proposal)
                if (!validated.ok) {
                    // A pure "skip/drop this failed story" replan is a
                    // destructive product decision: it can silently leave
                    // dependent acceptance criteria undone. Do not apply it
                    // automatically. The Conductor now does an automatic
                    // recovery pass for the failed prerequisite; if that still
                    // fails, the run ends as a blocked checkpoint rather than
                    // opening a partial PR.
                    this.emit(
                        ConductorState.create({
                            phase: "running_level",
                            detail:
                                validated.code === "destructive_removal"
                                    ? `skip proposal deferred (source=${validated.source}): ${validated.reason}`
                                    : `replan ignored (${validated.code}, source=${validated.source}): ${validated.reason}`,
                            currentLevel: lvl.ordinal,
                        }),
                    )
                    continue
                }
                const effectiveReplan = validated.applied
                // The applied event is authoritative for progress, DAG, and
                // Critic targeting. Publish it only after the mutated plan is
                // durable so consumers can never observe an unpersisted plan.
                try {
                    this.persistPrd(validated.prd)
                } catch (error) {
                    this.terminateRun(
                        false,
                        `failed to persist replan from '${effectiveReplan.source}': ${errorMessage(error)}`,
                    )
                    return
                }
                this.prd = validated.prd
                this.emit(ReplanApplied.create(effectiveReplan))
                this.appliedReplans += 1
                appliedReplans += 1
                replannedThisLevel = true
                // Track stories that were removed without a replacement.
                // If the replan only removes (no addedStories), it's a
                // drop — the work is gone and the run should NOT report
                // success. If the replan also adds stories, it's a true
                // replan; the failing story has been supplanted.
                if (effectiveReplan.removedStoryIds.length > 0) {
                    const removeSet = new Set(effectiveReplan.removedStoryIds)
                    // Failing stories that the replan replaces should
                    // come off globalFailed iff there's actually
                    // replacement work to track instead.
                    if (effectiveReplan.addedStories.length > 0) {
                        for (let i = this.globalFailed.length - 1; i >= 0; i--) {
                            if (removeSet.has(this.globalFailed[i])) {
                                this.globalFailed.splice(i, 1)
                            }
                        }
                    } else {
                        // Pure drop — record so terminateRun knows the
                        // run did not actually complete the goal.
                        for (const id of effectiveReplan.removedStoryIds) {
                            if (!this.globalDropped.includes(id)) {
                                this.globalDropped.push(id)
                            }
                        }
                    }
                }
                this.emit(
                    ConductorState.create({
                        phase: "running_level",
                        detail: `replan applied (source=${effectiveReplan.source}, +${effectiveReplan.addedStories.length}/-${effectiveReplan.removedStoryIds.length}): ${effectiveReplan.reason}`,
                        currentLevel: lvl.ordinal,
                    }),
                )
            }
            if (appliedReplans > 0) {
                // Count the safe boundary, not each sibling symptom. Do not
                // halt after this increment: replacement work must get a
                // chance to pass and reset the no-progress counter.
                this.noteHealingAction(lvl.ordinal)
            }
        }

        // If every story in the level failed terminally AND no replan
        // mutated the plan in response, abort the run.
        const anySuccess = lvl.passed.length > 0
        const totalThisLevel = lvl.passed.length + lvl.failed.length
        if (!anySuccess && totalThisLevel > 0 && !replannedThisLevel) {
            const halt = this.healingHaltReason()
            if (halt) {
                this.terminateRun(false, halt)
                return
            }
            const recovered = await this.tryStartRecoveryLevel(
                lvl.failed,
                "all stories in level failed",
            )
            if (recovered) return
            this.terminateRun(
                false,
                "all stories in level failed; aborting remaining levels",
            )
            return
        }

        // Loop: ask for next level via the bus.
        this.phase = "computing"
        this.emit(LevelComputeRequest.create({ reason: "level boundary" }))
    }

    private terminateRun(success: boolean, abortReason: string | null): void {
        if (this.phase === "done") return
        this.phase = "done"
        const totalDurationSecs = Math.round((Date.now() - this.startedAt) / 1000)

        const droppedSegment = this.globalDropped.length > 0
            ? `, ${this.globalDropped.length} dropped`
            : ""
        this.emit(
            ConductorState.create({
                phase: success ? "done" : "failed",
                detail:
                    abortReason ??
                    `${this.globalCompleted.length} passed, ${this.globalFailed.length} failed${droppedSegment} in ${totalDurationSecs}s`,
            }),
        )

        const summary: ConductorRunSummary = {
            success,
            abortReason,
            completedStories: [...this.globalCompleted],
            failedStories: [...this.globalFailed],
            droppedStories: [...this.globalDropped],
            totalDurationSecs,
            totalAttempts: this.totalAttempts,
        }

        this.emit(
            RunCompleted.create({
                success,
                completedStories: summary.completedStories,
                failedStories: summary.failedStories,
                totalDurationSecs,
                totalAttempts: this.totalAttempts,
                abortReason,
            }),
        )

        // onRunComplete hook is fired and-then-forget; the resolve happens
        // synchronously so callers awaiting `done` aren't blocked by hook
        // side-effects.
        if (this.opts.onRunComplete) {
            void Promise.resolve(this.opts.onRunComplete(summary)).catch(() => {})
        }
        this.resolveDone(summary)
    }

    private persistPrd(prd: PrdFile): void {
        const persist = this.opts.persistPrd ?? savePrdAtomic
        persist(this.opts.prdPath, prd)
    }

    /**
     * Stories whose dependency chain includes a terminally failed story cannot
     * become runnable in this run. Keep them out of the remaining DAG so
     * `buildDag` cannot silently promote them after the failed dependency is
     * filtered out. Do NOT mark them passed/dropped here: this is a checkpoint,
     * and the user may choose to rerun the failed prerequisite on resume.
     */
    private computeBlockedStoryIds(): Set<string> {
        if (!this.prd || this.globalFailed.length === 0) {
            return new Set()
        }

        const failed = new Set(this.globalFailed)
        const blocked = new Set<string>()
        let changed = true

        while (changed) {
            changed = false
            for (const story of this.prd.userStories) {
                if (story.passes || failed.has(story.id) || blocked.has(story.id)) {
                    continue
                }

                if ((story.dependsOn ?? []).some((id) => failed.has(id) || blocked.has(id))) {
                    blocked.add(story.id)
                    changed = true
                }
            }
        }

        return blocked
    }

    /**
     * Non-null when healing must stop: the progress budget is spent or
     * the soft deadline has passed. Callers terminate the run with the
     * returned reason instead of applying a replan / starting recovery.
     */
    private healingHaltReason(): string | null {
        if (
            this.replanProgressBudget > 0 &&
            this.replansSinceProgress >= this.replanProgressBudget
        ) {
            const n = this.replansSinceProgress
            return `no progress after ${n} replan${n === 1 ? "" : "s"} — stopping so completed work can ship`
        }
        return this.softDeadlineReason()
    }

    private softDeadlineReason(): string | null {
        if (this.softDeadlineSecs <= 0) return null
        const elapsedSecs = (Date.now() - this.startedAt) / 1000
        if (elapsedSecs < this.softDeadlineSecs) return null
        return `soft deadline reached (${this.softDeadlineSecs}s) — stopping so completed work can ship`
    }

    private noteHealingAction(currentLevel?: number): void {
        this.replansSinceProgress += 1
        if (this.replanProgressBudget > 0) {
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail: `replan ${this.replansSinceProgress}/${this.replanProgressBudget} without progress`,
                    ...(currentLevel != null ? { currentLevel } : {}),
                }),
            )
        }
    }

    private addGlobalFailed(storyId: string): void {
        if (!this.globalFailed.includes(storyId)) {
            this.globalFailed.push(storyId)
        }
    }

    private removeGlobalFailed(storyId: string): void {
        for (let i = this.globalFailed.length - 1; i >= 0; i--) {
            if (this.globalFailed[i] === storyId) {
                this.globalFailed.splice(i, 1)
            }
        }
    }

    private async tryStartRecoveryLevel(
        candidateIds: readonly string[],
        reason: string,
    ): Promise<boolean> {
        if (!this.prd) return false

        const seen = new Set<string>()
        const stories: PrdStory[] = []
        for (const id of candidateIds) {
            if (seen.has(id)) continue
            seen.add(id)
            const attempts = this.recoveryAttempts.get(id) ?? 0
            if (attempts >= this.maxRecoveryAttemptsPerStory) continue
            const story = this.prd.userStories.find((s) => s.id === id)
            if (!story || story.passes) continue
            stories.push(story)
        }

        if (stories.length === 0) return false

        this.noteHealingAction(this.currentLevel?.ordinal)

        for (const story of stories) {
            this.recoveryAttempts.set(
                story.id,
                (this.recoveryAttempts.get(story.id) ?? 0) + 1,
            )
            this.removeGlobalFailed(story.id)
        }

        const ordinal = (this.currentLevel?.ordinal ?? 0) + 1
        const totalLevelsHint = ordinal
        this.currentLevel = {
            ordinal,
            totalLevelsHint,
            storyIds: stories.map((s) => s.id),
            pending: new Set(stories.map((s) => s.id)),
            passed: [],
            failed: [],
            perStoryAttempts: new Map(),
        }

        this.recoveryLevelsStarted += 1
        this.emit(
            RecoveryStarted.create({
                attempt: this.recoveryLevelsStarted,
                storyIds: this.currentLevel.storyIds,
            }),
        )
        this.emit(
            LevelStarted.create({
                ordinal,
                totalLevelsHint,
                storyIds: this.currentLevel.storyIds,
            }),
        )
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail: `auto-recovery retry for ${this.currentLevel.storyIds.join(", ")} (${reason})`,
                currentLevel: ordinal,
                totalLevels: totalLevelsHint,
                storyIds: this.currentLevel.storyIds,
            }),
        )

        this.phase = "running"
        this.spawnQueue.push(...stories)
        await this.fillSpawnSlots()
        return true
    }

    private resolvePrompt(story: PrdStory): string {
        const candidatePath =
            this.opts.promptTemplatePath ?? join(this.opts.cwd, "prompt.md")
        let prompt: string
        if (existsSync(candidatePath)) {
            const tpl = readFileSyncSafe(candidatePath)
            prompt = tpl ? applyTemplate(tpl, story) : buildDefaultStoryPrompt(story)
        } else {
            prompt = buildDefaultStoryPrompt(story)
        }

        // Prepend Architect's DecisionDocument so the agent sees the
        // authoritative design spec before its task description. This
        // is the single biggest lever against per-story decision drift
        // (column names, file paths, API shapes, dependency choices,
        // …): every agent receives the same upstream-pinned answers
        // instead of each one improvising independently.
        const doc = this.prd?.decisionDocument
        if (doc && doc.trim().length > 0) {
            const header = [
                "## Design spec (authoritative — already decided)",
                "",
                "The Architect made these decisions before any story started.",
                "Treat them as fixed: use these exact file paths, names,",
                "schemas, API shapes, and dependency choices. Do NOT",
                "improvise alternatives — your siblings are working from",
                "the same spec and divergence breaks the build.",
                "",
                doc.trim(),
                "",
                "---",
                "",
            ].join("\n")
            prompt = header + prompt
        }

        return prompt
    }

    private emit(event: SemanticEvent<unknown>): void {
        this.envRef?.deliverSemanticEvent(this, event)
    }
}

function envNonNegativeInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (raw == null || raw.trim() === "") return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function readFileSyncSafe(path: string): string | null {
    try {
        return readFileSync(path, "utf8")
    } catch {
        return null
    }
}

function applyTemplate(tpl: string, story: PrdStory): string {
    const acceptance = story.acceptance.length
        ? story.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")
        : "(none specified)"
    return tpl
        .replace(/STORY_ID/g, story.id)
        .replace(/STORY_TITLE/g, story.title)
        .replace(/STORY_DESCRIPTION/g, story.description)
        .replace(/ACCEPTANCE_CRITERIA/g, acceptance)
}
