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
} from "../runtime/mozaik.js"

import {
    AgentState,
    StoryIntervention,
    StorySpawned,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../semantic-events.js"
import type {
    StoryOutcomeAuthority,
    StoryResultAuthorityCorrelation,
} from "../runtime/story-outcome-authority.js"
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
    /** Enables fail-closed collective observation and correlated aborts. */
    collective?: {
        runId: string
        leaseAuthority: Participant
        outcomeAuthority: StoryOutcomeAuthority
    }
}

interface StoryProgress {
    lastProgressAt: number
    fileChanges: number
    sinceLastChange: number
    sigCounts: Map<string, number>
    intervened: boolean
}

export class Supervisor extends BaseObserver {
    private readonly opts: Required<Omit<SupervisorOptions, "collective">> &
        Pick<SupervisorOptions, "collective">
    private readonly stories = new Map<string, StoryProgress>()
    private readonly activeLeases = new Map<
        string,
        StoryResultAuthorityCorrelation
    >()
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
            collective: opts.collective,
        }
        if (
            opts.collective &&
            opts.collective.outcomeAuthority.runId !== opts.collective.runId
        ) {
            throw new Error("Supervisor collective authority runId mismatch")
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        const collective = this.opts.collective
        if (collective && WorkLeaseGranted.is(event)) {
            if (
                source !== collective.leaseAuthority ||
                event.data.runId !== collective.runId
            ) return
            const storyId = event.data.request.storyId
            const current = this.activeLeases.get(storyId)
            if (
                current &&
                (event.data.generation < current.generation ||
                    (event.data.generation === current.generation &&
                        event.data.leaseId !== current.leaseId))
            ) return
            if (
                current?.leaseId === event.data.leaseId &&
                current.generation === event.data.generation
            ) return
            this.activeLeases.set(storyId, {
                runId: collective.runId,
                storyId,
                leaseId: event.data.leaseId,
                generation: event.data.generation,
            })
            this.resetAttempt(storyId)
            return
        }
        if (collective && WorkLeaseReleased.is(event)) {
            if (
                source !== collective.leaseAuthority ||
                event.data.runId !== collective.runId
            ) return
            const current = this.activeLeases.get(event.data.storyId)
            if (current?.leaseId !== event.data.leaseId) return
            this.activeLeases.delete(event.data.storyId)
            this.stories.delete(event.data.storyId)
            return
        }
        if (StorySpawned.is(event)) {
            if (collective) return
            // A recovery can spawn the same logical story id again. The
            // successful spawn event is the authoritative boundary between
            // executions, so no intervention/progress state crosses it.
            this.resetAttempt(event.data.storyId)
            return
        }

        if (!AgentState.is(event)) return
        const { agentId, phase } = event.data
        if (collective) {
            if (!this.collectiveCorrelation(source, agentId)) return
        } else {
            const sourceId = (source as unknown as { agentId?: string }).agentId
            if (sourceId !== agentId) return
        }

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
        const correlation = this.opts.collective
            ? this.collectiveCorrelation(source, id)
            : null
        if (this.opts.collective && !correlation) return
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
                    ...(correlation
                        ? {
                              runId: correlation.runId,
                              leaseId: correlation.leaseId,
                              generation: correlation.generation,
                          }
                        : {}),
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

    private collectiveCorrelation(
        source: Participant,
        storyId: string,
    ): StoryResultAuthorityCorrelation | null {
        const collective = this.opts.collective
        if (!collective) return null
        const active = this.activeLeases.get(storyId)
        const authenticated =
            collective.outcomeAuthority.terminalCorrelationForSource(
                source,
                storyId,
            )
        if (
            !active ||
            !authenticated ||
            authenticated.runId !== active.runId ||
            authenticated.leaseId !== active.leaseId ||
            authenticated.generation !== active.generation
        ) return null
        return active
    }
}
