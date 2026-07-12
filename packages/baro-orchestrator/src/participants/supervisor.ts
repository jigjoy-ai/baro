/**
 * Supervisor — live non-convergence detector (mid-run adaptation).
 *
 * Watches each story's tool-call stream and, on a clear stall (long
 * read-only stretch, the same call on repeat, or wall-clock without recent
 * file changes), emits a StoryIntervention(abort) on the bus. StoryFactory aborts
 * the story so it settles as a failed StoryResult EARLY — the Surgeon then
 * splits/escalates it instead of the run burning its budget on non-terminal
 * retries. Detection here, remediation there; both over the bus.
 */

import {
    BaseObserver,
    FunctionCallItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    AgentState,
    StoryIntervention,
    StorySpawned,
} from "../semantic-events.js"
import {
    isFileMutationTool,
    normalizeToolName,
} from "../tool-classification.js"

export interface SupervisorOptions {
    /** Consecutive tool calls with NO file change before we call it a non-converging loop. Default 80. */
    noProgressToolCalls?: number
    /** Same tool+args signature seen this many times → looping. Default 12. */
    repeatThreshold?: number
    /**
     * Repeats only count as a loop if the story is ALSO making no progress —
     * i.e. sinceLastChange is at least this high. A story re-editing the same
     * file (making changes) resets sinceLastChange and is never a "loop".
     * Defaults to half of noProgressToolCalls.
     */
    repeatsNeedNoProgress?: number
    /** Wall-clock (ms) without a recognized file change before intervening. Default 12 min. */
    softCapMs?: number
    /** Safety cap on total interventions per run. Default 25. */
    maxInterventions?: number
    /** Clock injection for tests. Default Date.now. */
    now?: () => number
}

interface StoryProgress {
    lastProgressAt: number
    fileChanges: number
    sinceLastChange: number
    sigCounts: Map<string, number>
    intervened: boolean
}

export class Supervisor extends BaseObserver {
    private readonly opts: Required<SupervisorOptions>
    private readonly stories = new Map<string, StoryProgress>()
    private interventions = 0

    constructor(opts: SupervisorOptions = {}) {
        super()
        const noProgressToolCalls = opts.noProgressToolCalls ?? 80
        this.opts = {
            noProgressToolCalls,
            repeatThreshold: opts.repeatThreshold ?? 12,
            repeatsNeedNoProgress: opts.repeatsNeedNoProgress ?? Math.floor(noProgressToolCalls / 2),
            softCapMs: opts.softCapMs ?? 12 * 60_000,
            maxInterventions: opts.maxInterventions ?? 25,
            now: opts.now ?? (() => Date.now()),
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (StorySpawned.is(event)) {
            // A recovery can spawn the same logical story id again. The
            // successful spawn event is the authoritative boundary between
            // executions, so no intervention/progress state crosses it.
            this.resetAttempt(event.data.storyId)
            return
        }

        if (!AgentState.is(event)) return
        const { agentId, phase } = event.data
        const sourceId = (source as unknown as { agentId?: string }).agentId
        if (sourceId !== agentId) return

        // Story agents emit `waiting` only when they have scheduled another
        // execution attempt. Reset at that semantic retry boundary so a
        // Supervisor abort on attempt 1 cannot disable supervision of 2.
        if (phase === "waiting") {
            this.resetAttempt(agentId)
        }
    }

    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        const id = (source as unknown as { agentId?: string }).agentId
        if (typeof id !== "string") return
        const st = this.ensure(id)
        if (st.intervened) return

        if (isFileMutationTool(item.name)) {
            st.fileChanges += 1
            st.sinceLastChange = 0
            st.lastProgressAt = this.opts.now()
            // Repeats before an actual file mutation are not evidence that
            // the post-progress sequence is looping.
            st.sigCounts.clear()
        } else {
            st.sinceLastChange += 1
        }

        const sig = `${normalizeToolName(item.name)}:${String(item.args ?? "").slice(0, 160)}`
        const repeats = (st.sigCounts.get(sig) ?? 0) + 1
        st.sigCounts.set(sig, repeats)

        if (this.interventions >= this.opts.maxInterventions) return
        const reason = this.stallReason(st, repeats)
        if (!reason) return
        st.intervened = true
        this.interventions += 1
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(
                this,
                StoryIntervention.create({
                    storyId: id,
                    source: "supervisor",
                    action: "abort",
                    reason,
                }),
            )
        }
    }

    private stallReason(st: StoryProgress, repeats: number): string | null {
        if (st.sinceLastChange >= this.opts.noProgressToolCalls) {
            return `${st.sinceLastChange} tool calls with no file change — exploring, not converging`
        }
        // A repeated call is only a loop if the story is also making no
        // progress — legitimately re-editing the same file keeps sinceLastChange
        // low, so we don't abort work that's actually changing the codebase.
        if (repeats >= this.opts.repeatThreshold && st.sinceLastChange >= this.opts.repeatsNeedNoProgress) {
            return `same tool call repeated ${repeats}× with no file change — stuck in a loop`
        }
        const sinceProgress = this.opts.now() - st.lastProgressAt
        if (sinceProgress >= this.opts.softCapMs) {
            const minutes = Math.round(sinceProgress / 60_000)
            return st.fileChanges === 0
                ? `${minutes} min elapsed with zero recognized file changes`
                : `${minutes} min since last recognized file change`
        }
        return null
    }

    private ensure(id: string): StoryProgress {
        let st = this.stories.get(id)
        if (!st) {
            const now = this.opts.now()
            st = {
                lastProgressAt: now,
                fileChanges: 0,
                sinceLastChange: 0,
                sigCounts: new Map(),
                intervened: false,
            }
            this.stories.set(id, st)
        }
        return st
    }

    private resetAttempt(id: string): void {
        this.stories.delete(id)
        this.ensure(id)
    }
}
