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

import {
    AgenticEnvironment,
    ContextItem,
    Participant,
} from "@mozaik-ai/core"

import { buildDag } from "../dag.js"
import {
    PrdFile,
    PrdStory,
    buildDefaultStoryPrompt,
    loadPrd,
    markStoryPassed,
    savePrd,
} from "../prd.js"
import {
    LevelCompletedItem,
    LevelComputeRequestItem,
    LevelStartedItem,
    ReplanItem,
    RunCompletedItem,
    RunStartRequestItem,
    RunStartedItem,
    StorySpawnRequestItem,
} from "../types.js"
import { StoryResultItem } from "./story-agent.js"

export interface ConductorOptions {
    prdPath: string
    cwd: string
    parallel?: number
    timeoutSecs?: number
    overrideModel?: string
    defaultModel?: string
    promptTemplatePath?: string
    onStoryPassed?: (storyId: string) => Promise<void> | void
    onRunStart?: (prd: PrdFile) => Promise<void> | void
    onBeforeStoryLaunch?: (
        storyId: string,
        story: PrdStory,
    ) => Promise<string | null | undefined> | string | null | undefined
    onRunComplete?: (summary: ConductorRunSummary) => Promise<void> | void
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
}

export class ConductorStateItem extends ContextItem {
    readonly type = "conductor_state"

    constructor(
        public readonly phase:
            | "loading"
            | "running_level"
            | "level_complete"
            | "done"
            | "failed",
        public readonly detail?: string,
        public readonly currentLevel?: number,
        public readonly totalLevels?: number,
        public readonly storyIds?: readonly string[],
    ) {
        super()
    }

    toJSON(): unknown {
        return {
            type: this.type,
            phase: this.phase,
            detail: this.detail,
            currentLevel: this.currentLevel,
            totalLevels: this.totalLevels,
            storyIds: this.storyIds,
        }
    }
}

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

export class Conductor extends Participant {
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
    private totalAttempts = 0
    private appliedReplans = 0

    private currentLevel: RunningLevelState | null = null

    /** ReplanItem-s emitted during a level. Applied at level boundary. */
    private readonly pendingReplans: ReplanItem[] = []

    /** Stories that are queued to spawn but not yet launched (parallel cap). */
    private readonly spawnQueue: PrdStory[] = []
    /** Stories currently in flight in the active level. */
    private readonly inFlight: Set<string> = new Set()

    /** Resolved when the run terminates, exposed for callers that need it. */
    public readonly done: Promise<ConductorRunSummary>
    private resolveDone!: (summary: ConductorRunSummary) => void

    constructor(opts: ConductorOptions) {
        super()
        this.opts = {
            parallel: 0,
            timeoutSecs: 600,
            defaultModel: "sonnet",
            ...opts,
        }
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
     * Note: the Mozaik bus delivers items to every subscriber, INCLUDING
     * the source. We rely on this — the Conductor self-ticks via
     * LevelComputeRequestItem, so blocking self-delivery would break the
     * state machine. Per-item type guards distinguish "from outside"
     * (RunStartRequestItem from Operator, ReplanItem from Surgeon,
     * StoryResultItem from StoryAgent) from "from self" (LevelCompute).
     */
    async onContextItem(_source: Participant, item: ContextItem): Promise<void> {
        if (item instanceof RunStartRequestItem) {
            await this.handleRunStart()
            return
        }

        if (item instanceof LevelComputeRequestItem) {
            await this.handleLevelCompute()
            return
        }

        if (item instanceof StoryResultItem) {
            await this.handleStoryResult(item)
            return
        }

        if (item instanceof ReplanItem) {
            this.pendingReplans.push(item)
            return
        }
    }

    private async handleRunStart(): Promise<void> {
        if (this.phase !== "idle") return
        this.phase = "launching"
        this.startedAt = Date.now()

        this.prd = loadPrd(this.opts.prdPath)
        this.emit(
            new ConductorStateItem(
                "loading",
                `${this.prd.userStories.length} stories`,
            ),
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
            new RunStartedItem(this.prd.project, this.prd.userStories.length),
        )
        this.phase = "computing"
        this.emit(new LevelComputeRequestItem("initial"))
    }

    private async handleLevelCompute(): Promise<void> {
        if (this.phase !== "computing") return
        if (!this.prd) return

        const levels = buildDag(this.prd.userStories, { onlyIncomplete: true })

        if (levels.length === 0) {
            // Run is "successful" only when every story currently in
            // the PRD has passed. A story that was dropped by a Surgeon
            // replan is no longer in the PRD; that's tracked separately
            // in globalDropped and counts against the run's success.
            const allPassed =
                this.prd.userStories.every((s) => s.passes) &&
                this.globalDropped.length === 0
            this.terminateRun(allPassed, null)
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
            this.emit(new LevelComputeRequestItem("empty level"))
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
            new LevelStartedItem(ordinal, totalLevelsHint, this.currentLevel.storyIds),
        )
        this.emit(
            new ConductorStateItem(
                "running_level",
                undefined,
                ordinal,
                totalLevelsHint,
                this.currentLevel.storyIds,
            ),
        )

        this.phase = "running"
        this.spawnQueue.push(...stories)
        await this.fillSpawnSlots()
    }

    private async handleStoryResult(item: StoryResultItem): Promise<void> {
        if (this.phase !== "running") return
        if (!this.currentLevel) return
        if (!this.currentLevel.pending.has(item.storyId)) return

        this.currentLevel.pending.delete(item.storyId)
        this.inFlight.delete(item.storyId)
        this.currentLevel.perStoryAttempts.set(item.storyId, item.attempts)
        this.totalAttempts += item.attempts

        if (item.success) {
            this.currentLevel.passed.push(item.storyId)
            this.globalCompleted.push(item.storyId)
            if (this.prd) {
                this.prd = markStoryPassed(this.prd, item.storyId, item.durationSecs)
                savePrd(this.opts.prdPath, this.prd)
            }
            if (this.opts.onStoryPassed) {
                try {
                    await this.opts.onStoryPassed(item.storyId)
                } catch (e) {
                    this.emit(
                        new ConductorStateItem(
                            "running_level",
                            `onStoryPassed hook for ${item.storyId} failed: ${(e as Error)?.message ?? String(e)}`,
                            this.currentLevel.ordinal,
                            this.currentLevel.totalLevelsHint,
                        ),
                    )
                }
            }
        } else {
            this.currentLevel.failed.push(item.storyId)
            this.globalFailed.push(item.storyId)
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
        const cap =
            this.opts.parallel > 0 ? this.opts.parallel : Number.MAX_SAFE_INTEGER
        while (this.spawnQueue.length > 0 && this.inFlight.size < cap) {
            const story = this.spawnQueue.shift()!
            await this.requestStorySpawn(story)
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
                    new ConductorStateItem(
                        "running_level",
                        `onBeforeStoryLaunch hook for ${story.id} failed: ${(e as Error)?.message ?? String(e)}`,
                    ),
                )
            }
        }

        this.inFlight.add(story.id)
        this.emit(
            new StorySpawnRequestItem(
                story.id,
                prompt,
                model,
                story.retries,
                this.opts.timeoutSecs,
            ),
        )
    }

    private async completeLevel(): Promise<void> {
        if (!this.currentLevel) return
        const lvl = this.currentLevel

        this.emit(
            new LevelCompletedItem(lvl.ordinal, lvl.passed, lvl.failed),
        )
        this.emit(
            new ConductorStateItem(
                "level_complete",
                `passed ${lvl.passed.length}/${lvl.passed.length + lvl.failed.length}`,
                lvl.ordinal,
                lvl.totalLevelsHint,
                lvl.storyIds,
            ),
        )

        // Apply ReplanItem-s buffered during this level.
        let replannedThisLevel = false
        if (this.pendingReplans.length > 0 && this.prd) {
            const drained = this.pendingReplans.splice(0)
            for (const replan of drained) {
                this.prd = applyReplan(this.prd, replan)
                this.appliedReplans += 1
                replannedThisLevel = true
                // Track stories that were removed without a replacement.
                // If the replan only removes (no addedStories), it's a
                // drop — the work is gone and the run should NOT report
                // success. If the replan also adds stories, it's a true
                // replan; the failing story has been supplanted.
                if (replan.removedStoryIds.length > 0) {
                    const removeSet = new Set(replan.removedStoryIds)
                    // Failing stories that the replan replaces should
                    // come off globalFailed iff there's actually
                    // replacement work to track instead.
                    if (replan.addedStories.length > 0) {
                        for (let i = this.globalFailed.length - 1; i >= 0; i--) {
                            if (removeSet.has(this.globalFailed[i])) {
                                this.globalFailed.splice(i, 1)
                            }
                        }
                    } else {
                        // Pure drop — record so terminateRun knows the
                        // run did not actually complete the goal.
                        for (const id of replan.removedStoryIds) {
                            if (!this.globalDropped.includes(id)) {
                                this.globalDropped.push(id)
                            }
                        }
                    }
                }
                this.emit(
                    new ConductorStateItem(
                        "running_level",
                        `replan applied (source=${replan.source}, +${replan.addedStories.length}/-${replan.removedStoryIds.length}): ${replan.reason}`,
                        lvl.ordinal,
                    ),
                )
            }
            savePrd(this.opts.prdPath, this.prd)
        }

        // If every story in the level failed terminally AND no replan
        // mutated the plan in response, abort the run.
        const anySuccess = lvl.passed.length > 0
        const totalThisLevel = lvl.passed.length + lvl.failed.length
        if (!anySuccess && totalThisLevel > 0 && !replannedThisLevel) {
            this.terminateRun(
                false,
                "all stories in level failed; aborting remaining levels",
            )
            return
        }

        // Loop: ask for next level via the bus.
        this.phase = "computing"
        this.emit(new LevelComputeRequestItem("level boundary"))
    }

    private terminateRun(success: boolean, abortReason: string | null): void {
        if (this.phase === "done") return
        this.phase = "done"
        const totalDurationSecs = Math.round((Date.now() - this.startedAt) / 1000)

        const droppedSegment = this.globalDropped.length > 0
            ? `, ${this.globalDropped.length} dropped`
            : ""
        this.emit(
            new ConductorStateItem(
                success ? "done" : "failed",
                abortReason ??
                    `${this.globalCompleted.length} passed, ${this.globalFailed.length} failed${droppedSegment} in ${totalDurationSecs}s`,
            ),
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
            new RunCompletedItem(
                success,
                summary.completedStories,
                summary.failedStories,
                totalDurationSecs,
                this.totalAttempts,
                abortReason,
            ),
        )

        // onRunComplete hook is fired and-then-forget; the resolve happens
        // synchronously so callers awaiting `done` aren't blocked by hook
        // side-effects.
        if (this.opts.onRunComplete) {
            void Promise.resolve(this.opts.onRunComplete(summary)).catch(() => {})
        }
        this.resolveDone(summary)
    }

    private resolvePrompt(story: PrdStory): string {
        const candidatePath =
            this.opts.promptTemplatePath ?? join(this.opts.cwd, "prompt.md")
        if (existsSync(candidatePath)) {
            const tpl = readFileSyncSafe(candidatePath)
            if (tpl) {
                return applyTemplate(tpl, story)
            }
        }
        return buildDefaultStoryPrompt(story)
    }

    private emit(item: ContextItem): void {
        this.envRef?.deliverContextItem(this, item)
    }
}

/**
 * Pure: apply a ReplanItem to a PrdFile and return a new PrdFile.
 * Removes pending stories, rewires deps, adds new stories.
 * Stories that have already passed are never removed.
 */
export function applyReplan(prd: PrdFile, replan: ReplanItem): PrdFile {
    let stories = prd.userStories.slice()

    if (replan.removedStoryIds.length > 0) {
        const removeSet = new Set(replan.removedStoryIds)
        stories = stories.filter((s) => !removeSet.has(s.id) || s.passes)
    }

    if (replan.modifiedDeps.size > 0) {
        stories = stories.map((s) => {
            const newDeps = replan.modifiedDeps.get(s.id)
            if (!newDeps) return s
            return { ...s, dependsOn: [...newDeps] }
        })
    }

    if (replan.addedStories.length > 0) {
        const existing = new Set(stories.map((s) => s.id))
        for (const a of replan.addedStories) {
            if (existing.has(a.id)) continue
            stories.push({
                id: a.id,
                priority: a.priority,
                title: a.title,
                description: a.description,
                dependsOn: [...a.dependsOn],
                retries: a.retries ?? 2,
                acceptance: a.acceptance ? [...a.acceptance] : [],
                tests: a.tests ? [...a.tests] : [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: a.model,
            })
        }
    }

    return { ...prd, userStories: stories }
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
