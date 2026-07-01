/**
 * Surgeon — adaptive DAG mutation participant (Phase 4).
 *
 * Observes terminal story failures (StoryResultItem with success=false
 * after all retries exhausted) and emits ReplanItem-s that the
 * Conductor applies at the next level boundary.
 *
 * Two evaluation strategies:
 *
 *   • `useLlm: false` (default) — deterministic. When a story fails
 *     terminally, Surgeon emits a ReplanItem that REMOVES the failing
 *     story so dependents can either run with one fewer prerequisite
 *     or themselves be removed by cascade. This is graceful
 *     degradation — pre-Phase-4 the entire level (and downstream)
 *     would just abort.
 *
 *   • `useLlm: true` — calls `claude --model <model> --print` with a
 *     compact view of the run state and asks for a structured
 *     replan (add/remove/rewire stories). The model is given the
 *     full failure reason and the surrounding PRD so it can propose
 *     a different approach (e.g. split the failed story into two
 *     smaller stories, or insert a missing prerequisite).
 *
 * Library-grade: doesn't import PRD types directly. The Surgeon
 * receives PRD context as a generic `() => PrdSnapshot` callback so
 * the Conductor stays the only PRD-aware piece of code.
 */

import { execFile } from "child_process"
import { promisify } from "util"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    Replan,
    type ReplanData,
    type ReplanStoryAdd,
    StoryResult,
    type StoryResultData,
} from "../semantic-events.js"

const execFileAsync = promisify(execFile)

/**
 * Lightweight read-only view of the PRD that Surgeon needs to reason.
 * The Conductor (or the orchestrate() wiring) provides this snapshot;
 * Surgeon doesn't import PrdFile/PrdStory itself.
 */
export interface PrdSnapshot {
    project: string
    description: string
    stories: readonly {
        id: string
        title: string
        description: string
        dependsOn: readonly string[]
        passes: boolean
        /** Current routing tier ("haiku" | "sonnet" | "opus" | backend:model). */
        model?: string
    }[]
}

/**
 * Renders a story's planner tier (its PRD `model`) as the backend:model that
 * actually ran, accounting for `--story-model` / `--story-llm` / tier-map
 * overrides. Returns null when the route can't be resolved. Wired from
 * orchestrate() only when an override is active, so a plain run keeps showing
 * just the tier (issue #48).
 */
export type RouteDescriber = (model: string | undefined) => string | null

export interface SurgeonOptions {
    /** Returns a fresh snapshot of the current PRD. */
    snapshot: () => PrdSnapshot
    /** Describes the model a story actually ran on (see RouteDescriber). */
    resolveRoute?: RouteDescriber
    /** Explicit `backend:model` the Surgeon may set to escalate a stuck, right-sized story. */
    escalationRoute?: string
    /** Use Claude CLI to evaluate replans. Default: false (deterministic). */
    useLlm?: boolean
    /** Model for LLM evaluations. Default: "opus". */
    model?: string
    /** Max replans this Surgeon will emit per run. Default: 10. */
    maxReplans?: number
    /** Path to the `claude` binary. Default: "claude". */
    claudeBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 90_000. */
    timeoutMs?: number
}

export const SURGEON_SYSTEM_PROMPT = `\
You are the Surgeon — an autonomous planner that adapts a software-project
DAG when stories fail. Given:
1. A snapshot of the current PRD (project, story list with dependencies +
   pass/fail state).
2. The id, title, description, and FAILURE REASON of the story that just
   exhausted its retry budget.

Decide ONE of, in this order of preference:
  (a) "split"     — replace the failing story with 2-3 smaller stories
                    that together cover its acceptance criteria. Use
                    this whenever the failure looks like the story was
                    too broad — too many files, too many concerns,
                    too much for one Claude session. Strongly preferred
                    over removal whenever the goal still needs the work.
  (b) "prereq"    — insert ONE OR MORE new prerequisite stories that
                    the failing story now depends on, then ALSO add a
                    replacement of the failing story (with updated
                    dependsOn) so the original work still gets done.
                    Removing without replacement is NOT prereq.
  (c) "rewire"    — keep the failing story BUT modifyDeps so it runs
                    in a different order, or change its dependsOn to
                    unblock dependents. Use when the failure was
                    timing-related, not scope-related.
  (d) "skip"      — last resort. Use ONLY when the story is genuinely
                    infeasible (e.g., asks for a library that doesn't
                    exist, references files that aren't there). When
                    you skip, modifyDeps for any dependents so the
                    rest of the run can still complete.
  (e) "abort"     — only when the entire run cannot continue.

Strong bias: the run is only successful when EVERY original goal item
gets done. Splitting into smaller stories is almost always better than
dropping. Don't drop just because one attempt failed — propose a
different approach.

Respond ONLY with a JSON object — no prose, no markdown fences — in
exactly this shape:

{"action":"split"|"prereq"|"rewire"|"skip"|"abort",
 "reason":"…",
 "added":[ { "id":"S?","priority":N,"title":"…","description":"…",
             "dependsOn":["…"], "acceptance":["…"] } ],
 "removed":["S?"],
 "modifiedDeps":[{"id":"S?","newDependsOn":["…"]}]}

Rules:
- Story ids you ADD must not collide with existing ids.
- Story ids you REMOVE must currently exist and not yet have passes=true.
- "modifiedDeps" rewires a story's dependsOn — use to repoint dependents
  of a removed story to a replacement.
- "abort" → empty added/removed/modifiedDeps arrays.
- MODEL: LEAVE "model" UNSET on the stories you add — they run on the
  default (cheaper) model, which is exactly what split children want.
  Do NOT use planner tier names ("haiku"/"sonnet"/"opus") — the story
  model is not chosen by tier here; it is either the default or an
  explicit escalation route (below).
- ESCALATION vs SPLIT — the failing story already burned its retries on
  the model shown ("Model that just failed"). Two ways to recover:
    * SPLIT (preferred): if it was TOO BROAD — too many files/concerns
      for one session — break it into smaller, focused stories and
      leave their "model" unset (they stay on the cheaper model). A
      smaller, sharper story is usually what a stuck run actually needs.
    * ESCALATE (sparingly): if the story was already RIGHT-SIZED but
      genuinely needs a more capable model, set that ONE story's "model"
      to the exact ESCALATION ROUTE printed in the failure context
      below. That runs it on the stronger model. Only escalate when the
      scope is already tight — never as a reflex.
- Output ONLY the JSON object, nothing else.`

export class Surgeon extends BaseObserver {
    private readonly opts: Required<
        Pick<
            SurgeonOptions,
            "useLlm" | "model" | "maxReplans" | "claudeBin" | "timeoutMs"
        >
    > &
        SurgeonOptions

    private replansEmitted = 0
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: SurgeonOptions) {
        super()
        this.opts = {
            useLlm: opts.useLlm ?? true,
            model: opts.model ?? "opus",
            maxReplans: opts.maxReplans ?? Infinity,
            claudeBin: opts.claudeBin ?? "claude",
            timeoutMs: opts.timeoutMs ?? 90_000,
            snapshot: opts.snapshot,
            resolveRoute: opts.resolveRoute,
            escalationRoute: opts.escalationRoute,
        }
    }

    /** Resolves once every in-flight LLM evaluation has completed. */
    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (!StoryResult.is(event)) return
        if (event.data.success) return
        if (this.replansEmitted >= this.opts.maxReplans) return

        const work = (async () => {
            const replan = this.opts.useLlm
                ? await this.evaluateWithLlm(event.data)
                : this.evaluateDeterministic(event.data)
            if (!replan) return
            this.replansEmitted += 1
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, Replan.create(replan))
            }
        })()

        this.pending.add(work)
        work.finally(() => this.pending.delete(work))
        await work
    }

    /**
     * Deterministic strategy: emit a "skip" — remove the failing story
     * so its dependents either run unblocked (if they had multiple
     * deps) or get cascade-removed by buildDag's cycle-detection
     * skipping (if their only dep is now gone, they become unreachable).
     */
    private evaluateDeterministic(failure: StoryResultData): ReplanData {
        return surgeonDeterministicReplan(failure)
    }

    /**
     * LLM strategy: ask Claude (via CLI subprocess) to propose a replan
     * grounded in the PRD snapshot + failure reason. Falls back to
     * deterministic on parsing or subprocess error.
     */
    private async evaluateWithLlm(
        failure: StoryResultData,
    ): Promise<ReplanData | null> {
        const snap = this.opts.snapshot()
        const prompt = buildSurgeonPrompt(snap, failure, this.opts.resolveRoute, this.opts.escalationRoute)
        try {
            const { stdout } = await execFileAsync(
                this.opts.claudeBin,
                [
                    "--print",
                    "--output-format",
                    "json",
                    "--model",
                    this.opts.model,
                    "--permission-mode",
                    "bypassPermissions",
                    "--system-prompt",
                    SURGEON_SYSTEM_PROMPT,
                    "-p",
                    prompt,
                ],
                {
                    timeout: this.opts.timeoutMs,
                    maxBuffer: 4 * 1024 * 1024,
                },
            )
            const wrapper = JSON.parse(stdout) as { result?: string }
            const verdictText =
                typeof wrapper.result === "string" ? wrapper.result.trim() : ""
            if (!verdictText) throw new Error("empty result")

            const verdictJson = extractJsonObject(verdictText)
            const parsed = JSON.parse(verdictJson) as {
                action: string
                reason?: string
                added?: ReplanStoryAdd[]
                removed?: string[]
                modifiedDeps?: { id: string; newDependsOn: string[] }[]
            }

            if (parsed.action === "abort") return null

            const modifiedDeps: Record<string, readonly string[]> = {}
            for (const m of parsed.modifiedDeps ?? []) {
                if (typeof m.id === "string" && Array.isArray(m.newDependsOn)) {
                    modifiedDeps[m.id] = [...m.newDependsOn]
                }
            }
            return {
                source: "surgeon",
                reason: `${parsed.action}: ${parsed.reason ?? ""}`,
                addedStories: parsed.added ?? [],
                removedStoryIds: parsed.removed ?? [],
                modifiedDeps,
            }
        } catch (err) {
            // Fall back to deterministic on any LLM-side failure so the
            // run still has a chance to recover.
            const fallback = this.evaluateDeterministic(failure)
            return {
                ...fallback,
                reason: `${fallback.reason} (llm fallback after error: ${(err as Error)?.message ?? String(err)})`,
            }
        }
    }
}

export function buildSurgeonPrompt(
    snap: PrdSnapshot,
    failure: StoryResultData,
    resolveRoute?: RouteDescriber,
    escalationRoute?: string,
): string {
    const storyLines = snap.stories
        .map(
            (s) =>
                `  - ${s.id} ${s.passes ? "[passed]" : "[pending]"} ${s.model ? `<tier:${s.model}> ` : ""}"${s.title}" deps=${JSON.stringify(s.dependsOn)}`,
        )
        .join("\n")
    const failureStory = snap.stories.find((s) => s.id === failure.storyId)
    // The PRD `model` is the planner's blast-radius TIER, which a
    // `--story-model`/`--story-llm`/tier-map override can replace at spawn
    // time. Surface the model that actually ran so the reason doesn't
    // misattribute the failure to a tier that never executed (issue #48).
    const ranOn = resolveRoute ? resolveRoute(failureStory?.model) : null
    return [
        `# Project: ${snap.project}`,
        `Description: ${snap.description}`,
        "",
        `# Current PRD`,
        storyLines,
        "",
        `# Failure`,
        `Story id: ${failure.storyId}`,
        `Title: ${failureStory?.title ?? "(unknown)"}`,
        `Description: ${failureStory?.description ?? "(unknown)"}`,
        `Tier that just failed: ${failureStory?.model ?? "(default)"}`,
        ...(ranOn
            ? [
                  `Model that actually ran: ${ranOn}  (an override replaced the ` +
                      `planner tier above; refer to THIS model in your reason, not the tier)`,
              ]
            : []),
        `Attempts: ${failure.attempts}`,
        `Error: ${failure.error ?? "(no reason captured)"}`,
        ...(escalationRoute
            ? [
                  "",
                  `# Escalation route`,
                  `To ESCALATE a right-sized story onto the stronger model, set that ` +
                      `story's "model" to EXACTLY: ${escalationRoute}`,
                  `Otherwise leave "model" unset — added stories run on the default ` +
                      `(cheaper) model. Prefer splitting a too-broad story over escalating.`,
              ]
            : []),
        "",
        `# Decide`,
        `Output the replan JSON per the rules in your system prompt.`,
    ].join("\n")
}

export function extractJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fenceMatch) return fenceMatch[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(`no JSON object found in surgeon response`)
    }
    let depth = 0
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (ch === "{") depth += 1
        else if (ch === "}") {
            depth -= 1
            if (depth === 0) return trimmed.slice(start, i + 1)
        }
    }
    throw new Error("unbalanced JSON object in surgeon response")
}

/**
 * Deterministic-skip ReplanItem for a terminal story failure. Removes
 * the failing story so dependents either run unblocked (multiple deps)
 * or get cascade-removed by buildDag's reachability check (sole dep).
 *
 * Exported so LLM-backed sibling Surgeons (e.g. `SurgeonOpenAI`) can
 * use the same fallback when their inference call errors out — the
 * shape is identical to what the Claude-backed Surgeon falls back to.
 */
export function surgeonDeterministicReplan(failure: StoryResultData): ReplanData {
    return {
        source: "surgeon",
        reason: `deterministic skip: ${failure.storyId} exhausted ${failure.attempts} attempts (${failure.error ?? "no reason"})`,
        addedStories: [],
        removedStoryIds: [failure.storyId],
        modifiedDeps: {},
    }
}
