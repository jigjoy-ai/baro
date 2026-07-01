/**
 * Supervisor — live non-convergence detector (mid-run adaptation).
 *
 * Watches each story's tool-call stream on the Mozaik bus and, when a story is
 * clearly spinning — a long stretch of reads/greps with no edits, the same call
 * on repeat, or wall-clock elapsed with zero file changes — aborts it EARLY via
 * the injected `onStall` callback. That makes the story fail fast instead of
 * burning the whole run budget on non-terminal retries (the failure mode that
 * lost run-42-mr27k0vl: S11 looped ~30 min / 1M+ tokens and the run timed out
 * before it could be split).
 *
 * The Supervisor does NOT decide the fix. It just gets the stuck story to a
 * terminal `StoryResult(success=false)` early — the existing Surgeon reacts to
 * that and splits the too-broad story into smaller ones (or escalates its
 * model tier). Detection here, remediation there; both over the bus.
 *
 * Read-only on the bus (a BaseObserver); the only side effect is `onStall`, so
 * it's trivially unit-testable and can never corrupt run state.
 */

import { BaseObserver, FunctionCallItem, Participant } from "@mozaik-ai/core"

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
    /**
     * Abort a stalled story. Wired to StoryFactory.abort() so the story settles
     * with StoryResult(success=false) → the Surgeon then splits/escalates it.
     */
    onStall: (storyId: string, reason: string) => void
    /** Consecutive tool calls with NO file change before we call it a non-converging loop. Default 50. */
    noProgressToolCalls?: number
    /** Same tool+args signature seen this many times → looping. Default 6. */
    repeatThreshold?: number
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

    constructor(opts: SupervisorOptions) {
        super()
        this.opts = {
            onStall: opts.onStall,
            noProgressToolCalls: opts.noProgressToolCalls ?? 50,
            repeatThreshold: opts.repeatThreshold ?? 6,
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
        this.opts.onStall(id, `supervisor: ${reason}`)
    }

    private stallReason(st: StoryProgress, repeats: number): string | null {
        if (st.sinceLastChange >= this.opts.noProgressToolCalls) {
            return `${st.sinceLastChange} tool calls with no file change — exploring, not converging`
        }
        if (repeats >= this.opts.repeatThreshold) {
            return `same tool call repeated ${repeats}× — stuck in a loop`
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
