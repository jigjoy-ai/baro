/**
 * Supervisor — live non-convergence detector (mid-run adaptation).
 *
 * Watches each story's tool-call stream and, on a clear stall (long
 * read-only stretch, the same call on repeat, or wall-clock with zero file
 * changes), emits a StoryIntervention(abort) on the bus. StoryFactory aborts
 * the story so it settles as a failed StoryResult EARLY — the Surgeon then
 * splits/escalates it instead of the run burning its budget on non-terminal
 * retries. Detection here, remediation there; both over the bus.
 */

import { BaseObserver, FunctionCallItem, Participant } from "@mozaik-ai/core"

import { StoryIntervention } from "../semantic-events.js"

/** Tool names that mean the agent is CHANGING the codebase (progress), not just exploring. */
const WRITE_TOOLS = new Set([
    "write_file",
    "edit_file",
    "edit",
    "create_file",
    "apply_patch",
    "str_replace",
    "str_replace_editor",
    "str_replace_based_edit_tool",
    "multi_edit",
    "write",
    "patch",
])

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
    /** Wall-clock (ms) with zero file changes before intervening regardless. Default 12 min. */
    softCapMs?: number
    /** Safety cap on total interventions per run. Default 25. */
    maxInterventions?: number
    /** Clock injection for tests. Default Date.now. */
    now?: () => number
}

interface StoryProgress {
    startedAt: number
    toolCalls: number
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

    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        const id = (source as unknown as { agentId?: string }).agentId
        if (typeof id !== "string") return
        const st = this.ensure(id)
        if (st.intervened) return

        st.toolCalls += 1
        if (WRITE_TOOLS.has(item.name)) {
            st.fileChanges += 1
            st.sinceLastChange = 0
        } else {
            st.sinceLastChange += 1
        }

        const sig = `${item.name}:${String(item.args ?? "").slice(0, 160)}`
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
        const elapsed = this.opts.now() - st.startedAt
        if (elapsed >= this.opts.softCapMs && st.fileChanges === 0) {
            return `${Math.round(elapsed / 60_000)} min elapsed with zero file changes`
        }
        return null
    }

    private ensure(id: string): StoryProgress {
        let st = this.stories.get(id)
        if (!st) {
            st = {
                startedAt: this.opts.now(),
                toolCalls: 0,
                fileChanges: 0,
                sinceLastChange: 0,
                sigCounts: new Map(),
                intervened: false,
            }
            this.stories.set(id, st)
        }
        return st
    }
}
