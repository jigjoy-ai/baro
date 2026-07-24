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

import { BaseObserver, Participant, SemanticEvent } from "../runtime/mozaik.js"

import {
    Critique,
    type CritiqueData,
    ModelInvocationMeasured,
    RecoveryDecision,
    RecoveryEvaluationStarted,
    Replan,
    type ReplanData,
    type ReplanStoryAdd,
    type StoryResultData,
} from "../semantic-events.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type MetricSource,
    type ModelCostMetrics,
    type ModelInvocationMeasuredData,
    type ModelInvocationStatus,
    type ModelTokenMetrics,
    type UnknownMetricReason,
} from "../telemetry/model-telemetry.js"
import { ActiveLeaseRegistry } from "../runtime/active-lease-registry.js"
import { RecoverySourceAuthority } from "../runtime/recovery-source-authority.js"
import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"
import { correlateRecoveryReplan, recoveryInput } from "./recovery-input.js"

/**
 * Rolling per-story log of Critic verdicts, so a Surgeon evaluating a
 * terminal failure sees WHY the Critic kept failing the story — not just
 * the final error string. Shared by all Surgeon variants.
 */
export class CritiqueLog {
    private readonly byStory = new Map<string, CritiqueData[]>()

    constructor(private readonly keep = 3) {}

    record(event: SemanticEvent<unknown>): void {
        if (!Critique.is(event)) return
        const list = this.byStory.get(event.data.agentId) ?? []
        list.push(event.data)
        if (list.length > this.keep) list.shift()
        this.byStory.set(event.data.agentId, list)
    }

    forStory(storyId: string): readonly CritiqueData[] {
        return this.byStory.get(storyId) ?? []
    }
}

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
        /** Observable behavior the story must preserve for its consumers. */
        acceptance?: readonly string[]
        /** Executable checks that expose the story's capability surface. */
        tests?: readonly string[]
        /** Global GoalContract evidence owned by this story. */
        goalInvariantIds?: readonly string[]
        dependsOn: readonly string[]
        passes: boolean
        /** Current routing tier ("light" | "standard" | "heavy", legacy haiku/sonnet/opus, or backend:model). */
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

export const SURGEON_SYSTEM_PROMPT = `\
You are the Surgeon — an autonomous planner that adapts a software-project
DAG when stories fail. Given:
1. A snapshot of the current PRD (project, story list with dependencies +
   pass/fail state), plus description, acceptance, verification, and routing
   context for every direct dependent of the failed story.
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
             "dependsOn":["…"], "acceptance":["…"], "tests":["…"],
             "goalInvariantIds":["G-A1"], "model":"…" } ],
 "removed":["S?"],
 "modifiedDeps":[{"id":"S?","newDependsOn":["…"]}]}

Rules:
- Story ids you ADD must not collide with existing ids.
- Story ids you REMOVE must currently exist and not yet have passes=true.
- Every added story must have at least one concrete, observable acceptance
  criterion and at least one executable test command; neither may be blank.
- When replacing or splitting a story, distribute every one of its
  goalInvariantIds across the replacement stories that will produce that
  evidence. Never drop a global invariant during recovery.
- "modifiedDeps" rewires a story's dependsOn — use to repoint dependents
  of a removed story to a replacement.
- If you remove a story, EVERY direct dependent that remains in the graph must
  have its own "modifiedDeps" entry. Preserve its unrelated dependencies and
  replace the removed id with the terminal added replacement story or stories
  whose acceptance criteria cover the concrete behavior that dependent consumes.
  A terminal replacement is an added recovery story that no other added recovery
  story depends on. Do not blindly point all dependents at the first item in
  "added"; that item may only be a prerequisite, and different dependents may
  consume different acceptance subsets.
- "abort" → empty added/removed/modifiedDeps arrays.
- MODEL: LEAVE "model" UNSET on stories you add unless you deliberately use
  the EXACT escalation selector printed below. Do not invent a tier or route:
  depending on runtime routing, the selector may be the semantic tier "heavy"
  or an explicit backend:model.
- ESCALATION vs SPLIT — the failing story already burned its retries on
  the model shown ("Model that just failed"). Two ways to recover:
    * SPLIT (preferred): if it was TOO BROAD — too many files/concerns
      for one session — break it into smaller, focused stories and
      leave their "model" unset (they stay on the cheaper model). A
      smaller, sharper story is usually what a stuck run actually needs.
    * ESCALATE (sparingly): if the story was already RIGHT-SIZED but
      genuinely needs a more capable model, set that ONE story's "model"
      to the exact ESCALATION SELECTOR printed in the failure context
      below. That runs it on the stronger model. Only escalate when the
      scope is already tight — never as a reflex.
- Output ONLY the JSON object, nothing else.`

export function buildSurgeonPrompt(
    snap: PrdSnapshot,
    failure: StoryResultData,
    resolveRoute?: RouteDescriber,
    escalationRoute?: string,
    critiques?: readonly CritiqueData[],
): string {
    const storyLines = snap.stories
        .map(
            (s) =>
                `  - ${s.id} ${s.passes ? "[passed]" : "[pending]"} ${s.model ? `<tier:${s.model}> ` : ""}"${s.title}" deps=${JSON.stringify(s.dependsOn)}`,
        )
        .join("\n")
    const failureStory = snap.stories.find((s) => s.id === failure.storyId)
    const directDependentLines = snap.stories
        .filter((story) => story.dependsOn.includes(failure.storyId))
        .map((story) => {
            const actualModel = resolveRoute ? resolveRoute(story.model) : null
            return `  - ${JSON.stringify({
                id: story.id,
                title: story.title,
                description: story.description,
                dependsOn: story.dependsOn,
                acceptance: story.acceptance ?? [],
                tests: story.tests ?? [],
                goalInvariantIds: story.goalInvariantIds ?? [],
                modelTier: story.model ?? "(default)",
                ...(actualModel ? { actualModel } : {}),
            })}`
        })
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
        `# Direct dependents of ${failure.storyId}`,
        `If ${failure.storyId} is removed, every story below that remains in the graph ` +
            `is a separate rewire obligation. Replace ${failure.storyId} with the ` +
            `terminal replacement(s) that cover the dependent's concrete acceptance ` +
            `and capability subset; do not default all of them to the first added story.`,
        ...(directDependentLines.length
            ? directDependentLines
            : [`  - (none)`]),
        "",
        `# Failure`,
        `Story id: ${failure.storyId}`,
        `Title: ${failureStory?.title ?? "(unknown)"}`,
        `Description: ${failureStory?.description ?? "(unknown)"}`,
        `Acceptance: ${JSON.stringify(failureStory?.acceptance ?? [])}`,
        `Verification commands: ${JSON.stringify(failureStory?.tests ?? [])}`,
        `Global invariant ids: ${JSON.stringify(failureStory?.goalInvariantIds ?? [])}`,
        `Tier that just failed: ${failureStory?.model ?? "(default)"}`,
        ...(ranOn
            ? [
                  `Model that actually ran: ${ranOn}  (an override replaced the ` +
                      `planner tier above; refer to THIS model in your reason, not the tier)`,
              ]
            : []),
        `Attempts: ${failure.attempts}`,
        `Error: ${failure.error ?? "(no reason captured)"}`,
        ...(critiques && critiques.length
            ? [
                  "",
                  `# Critic verdicts on this story (oldest → latest)`,
                  ...critiques.map(
                      (c) =>
                          `- turn ${c.turn}: ${c.verdict.toUpperCase()} — ${c.reasoning}` +
                          (c.violatedCriteria.length
                              ? ` (violated: ${c.violatedCriteria.join("; ")})`
                              : ""),
                  ),
              ]
            : []),
        ...(escalationRoute
            ? [
                  "",
                  `# Escalation selector`,
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
