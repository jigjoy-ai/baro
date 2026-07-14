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

import { harnessChildEnvironment } from "../harness-environment.js"
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
} from "../model-telemetry.js"
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

export interface SurgeonOptions {
    /** Returns a fresh snapshot of the current PRD. */
    snapshot: () => PrdSnapshot
    /** Describes the model a story actually ran on (see RouteDescriber). */
    resolveRoute?: RouteDescriber
    /** Exact routing selector for escalating a right-sized story (`heavy`
     * under tier routing, otherwise an explicit backend:model). */
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
    runId?: string
    emitRecoveryDecisions?: boolean
    /** Collective-only dynamic authority for terminal execution results. */
    outcomeAuthority?: StoryOutcomeAuthority
}

interface SurgeonLlmEvaluation {
    replan: ReplanData | null
    telemetry: SurgeonLlmTelemetry
}

interface SurgeonLlmTelemetry {
    status: ModelInvocationStatus
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
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
             "dependsOn":["…"], "acceptance":["…"], "tests":["…"],
             "model":"…" } ],
 "removed":["S?"],
 "modifiedDeps":[{"id":"S?","newDependsOn":["…"]}]}

Rules:
- Story ids you ADD must not collide with existing ids.
- Story ids you REMOVE must currently exist and not yet have passes=true.
- Every added story must have at least one concrete, observable acceptance
  criterion and at least one executable test command; neither may be blank.
- "modifiedDeps" rewires a story's dependsOn — use to repoint dependents
  of a removed story to a replacement.
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

export class Surgeon extends BaseObserver {
    private readonly opts: Required<
        Pick<
            SurgeonOptions,
            "useLlm" | "model" | "maxReplans" | "claudeBin" | "timeoutMs"
        >
    > &
        SurgeonOptions

    private replansEmitted = 0
    /** Monotonic correlation for legacy failures that have no lease generation. */
    private evaluationSequence = 0
    private readonly pending = new Set<Promise<void>>()
    private readonly critiques = new CritiqueLog()
    private readonly leases = new ActiveLeaseRegistry()
    private readonly sources: RecoverySourceAuthority

    constructor(opts: SurgeonOptions) {
        super()
        this.sources = new RecoverySourceAuthority(opts.outcomeAuthority)
        this.opts = {
            useLlm: opts.useLlm ?? true,
            model: opts.model ?? "opus",
            maxReplans: opts.maxReplans ?? Infinity,
            claudeBin: opts.claudeBin ?? "claude",
            timeoutMs: opts.timeoutMs ?? 90_000,
            snapshot: opts.snapshot,
            resolveRoute: opts.resolveRoute,
            escalationRoute: opts.escalationRoute,
            runId: opts.runId,
            emitRecoveryDecisions: opts.emitRecoveryDecisions,
        }
    }

    /** Resolves once every in-flight LLM evaluation has completed. */
    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    setLeaseAuthority(authority: Participant): void {
        this.sources.setLeaseAuthority(authority)
    }

    setQualityAuthority(authority: Participant): void {
        this.sources.setQualityAuthority(authority)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        this.critiques.record(event)
        if (this.sources.observeLease(source, event, this.leases, this.opts.runId)) return
        if (!this.sources.accepts(source, event)) return
        const failure = recoveryInput(event)
        if (!failure) return
        if (
            this.opts.emitRecoveryDecisions &&
            !this.leases.consumeResult(failure, this.opts.runId)
        ) return
        if (this.replansEmitted >= this.opts.maxReplans) {
            this.emitRecoveryDecision(failure, "abort", "replan budget exhausted")
            return
        }

        this.emitRecoveryStarted(failure)

        const work = (async () => {
            try {
                let replan: ReplanData | null
                if (this.opts.useLlm) {
                    const sequence = ++this.evaluationSequence
                    const evaluation = await this.evaluateWithLlm(failure)
                    this.publishMeasurement(failure, sequence, evaluation.telemetry)
                    replan = evaluation.replan
                } else {
                    replan = this.evaluateDeterministic(failure)
                }
                if (!replan) {
                    this.emitRecoveryDecision(failure, "abort", "surgeon chose abort")
                    return
                }
                this.replansEmitted += 1
                for (const env of this.getEnvironments()) {
                    env.deliverSemanticEvent(
                        this,
                        Replan.create(correlateRecoveryReplan(replan, failure)),
                    )
                }
                this.emitRecoveryDecision(failure, "replan", replan.reason)
            } catch (error) {
                this.emitRecoveryDecision(
                    failure,
                    "abort",
                    `surgeon failed: ${(error as Error)?.message ?? String(error)}`,
                )
            }
        })()

        this.pending.add(work)
        work.finally(() => this.pending.delete(work))
        await work
    }

    private publishMeasurement(
        failure: StoryResultData,
        sequence: number,
        telemetry: SurgeonLlmTelemetry,
    ): void {
        const runId = this.opts.runId ?? failure.runId ?? null
        const correlation = failure.generation == null
            ? `evaluation-${sequence}`
            : `generation-${failure.generation}`
        const invocationId = `${runId ?? "local"}:surgeon:${failure.storyId}:${correlation}`
        const data: ModelInvocationMeasuredData = {
            schemaVersion: 1,
            measurementId: `${invocationId}:runner`,
            invocationId,
            runId,
            phase: "surgeon",
            storyId: failure.storyId,
            attempt: null,
            turn: sequence,
            round: null,
            backend: "claude",
            // Claude CLI may route through Anthropic, Bedrock, or Vertex.
            provider: null,
            requestedModel: this.opts.model,
            resolvedModel: this.opts.model,
            status: telemetry.status,
            durationMs: telemetry.durationMs,
            tokens: telemetry.tokens,
            cost: telemetry.cost,
            evidence: {
                producer: "runner",
                // session_id is resumable conversation state, not a provider
                // request/charge identifier, so it is intentionally omitted.
                providerRequestId: null,
                rateCardVersion: null,
                granularity: "process",
            },
        }
        const event = ModelInvocationMeasured.create(data)
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }

    private emitRecoveryStarted(failure: StoryResultData): void {
        if (!this.opts.emitRecoveryDecisions || !this.opts.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(
                this,
                RecoveryEvaluationStarted.create({
                    runId: this.opts.runId,
                    storyId: failure.storyId,
                    source: "surgeon:claude",
                }),
            )
        }
    }

    private emitRecoveryDecision(
        failure: StoryResultData,
        action: "replan" | "abort",
        reason: string,
    ): void {
        if (!this.opts.emitRecoveryDecisions || !this.opts.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(
                this,
                RecoveryDecision.create({
                    runId: this.opts.runId,
                    storyId: failure.storyId,
                    source: "surgeon:claude",
                    action,
                    reason,
                }),
            )
        }
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
    ): Promise<SurgeonLlmEvaluation> {
        const snap = this.opts.snapshot()
        const prompt = buildSurgeonPrompt(
            snap,
            failure,
            this.opts.resolveRoute,
            this.opts.escalationRoute,
            this.critiques.forStory(failure.storyId),
        )

        let stdout: string
        try {
            const response = await execFileAsync(
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
                    env: harnessChildEnvironment(),
                    timeout: this.opts.timeoutMs,
                    maxBuffer: 4 * 1024 * 1024,
                },
            )
            stdout = response.stdout
        } catch (err) {
            const timedOut = isExecTimeout(err)
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                err,
                unknownClaudeTelemetry(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
            )
        }

        let wrapper: Record<string, unknown>
        try {
            const parsedWrapper: unknown = JSON.parse(stdout)
            if (!isRecord(parsedWrapper)) {
                throw new Error("claude returned a non-object JSON wrapper")
            }
            wrapper = parsedWrapper
        } catch (err) {
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                err,
                unknownClaudeTelemetry("failed", "parse_error"),
            )
        }

        if (wrapper.is_error === true || isErrorSubtype(wrapper.subtype)) {
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                new Error("claude returned an error result"),
                unknownClaudeTelemetry("failed", "not_reported"),
            )
        }

        // A valid, non-error wrapper proves that the provider call completed.
        // Replan JSON parsing below may still fail closed without rewriting
        // successful usage/cost evidence as a provider failure.
        const telemetry = claudeTelemetry(wrapper)
        try {
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

            if (parsed.action === "abort") {
                return { replan: null, telemetry }
            }

            const modifiedDeps: Record<string, readonly string[]> = {}
            for (const m of parsed.modifiedDeps ?? []) {
                if (typeof m.id === "string" && Array.isArray(m.newDependsOn)) {
                    modifiedDeps[m.id] = [...m.newDependsOn]
                }
            }
            return {
                replan: {
                    source: "surgeon",
                    reason: `${parsed.action}: ${parsed.reason ?? ""}`,
                    addedStories: parsed.added ?? [],
                    removedStoryIds: parsed.removed ?? [],
                    modifiedDeps,
                },
                telemetry,
            }
        } catch (err) {
            return surgeonLlmFallback(
                this.evaluateDeterministic(failure),
                err,
                telemetry,
            )
        }
    }
}

function surgeonLlmFallback(
    fallback: ReplanData,
    error: unknown,
    telemetry: SurgeonLlmTelemetry,
): SurgeonLlmEvaluation {
    return {
        replan: {
            ...fallback,
            reason: `${fallback.reason} (llm fallback after error: ${(error as Error)?.message ?? String(error)})`,
        },
        telemetry,
    }
}

function claudeTelemetry(
    wrapper: Record<string, unknown>,
): SurgeonLlmTelemetry {
    const usage = isRecord(wrapper.usage) ? wrapper.usage : null
    return {
        status: "succeeded",
        durationMs: metricFromKeys(wrapper, ["duration_ms"], "cli_result"),
        tokens: usage
            ? claudeTokenMetrics(usage)
            : unknownClaudeTokens(
                  wrapper.usage == null ? "not_reported" : "parse_error",
              ),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: metricFromKeys(
                wrapper,
                ["total_cost_usd"],
                "cli_result",
            ),
        },
    }
}

function claudeTokenMetrics(
    usage: Record<string, unknown>,
): ModelTokenMetrics {
    const cache = isRecord(usage.cache) ? usage.cache : null
    const rawInput = metricFromKeys(
        usage,
        ["input_tokens", "inputTokens"],
        "provider_response",
    )
    const cachedInput = firstReportedMetric([
        metricFromKeysOptional(
            usage,
            ["cache_read_input_tokens", "cached_input_tokens"],
            "provider_response",
        ),
        cache
            ? metricFromKeysOptional(cache, ["read"], "provider_response")
            : null,
    ])
    const cacheWriteInput = firstReportedMetric([
        metricFromKeysOptional(
            usage,
            ["cache_creation_input_tokens", "cache_write_input_tokens"],
            "provider_response",
        ),
        cache
            ? metricFromKeysOptional(cache, ["write"], "provider_response")
            : null,
    ])
    const outputTotal = metricFromKeys(
        usage,
        ["output_tokens", "outputTokens"],
        "provider_response",
    )
    const inputTotal = sumMetrics([rawInput, cachedInput, cacheWriteInput])
    const reportedTotal = metricFromKeysOptional(
        usage,
        ["total_tokens", "totalTokens"],
        "provider_response",
    )

    return {
        inputTotal,
        cachedInput,
        cacheWriteInput,
        outputTotal,
        reasoningOutput: notApplicableMetric(),
        total: reportedTotal ?? sumMetrics([inputTotal, outputTotal]),
    }
}

function unknownClaudeTelemetry(
    status: ModelInvocationStatus,
    reason: UnknownMetricReason,
): SurgeonLlmTelemetry {
    return {
        status,
        durationMs: unknownMetric(reason),
        tokens: unknownClaudeTokens(reason),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: unknownMetric(reason),
        },
    }
}

function unknownClaudeTokens(reason: UnknownMetricReason): ModelTokenMetrics {
    return {
        inputTotal: unknownMetric(reason),
        cachedInput: unknownMetric(reason),
        cacheWriteInput: unknownMetric(reason),
        outputTotal: unknownMetric(reason),
        reasoningOutput: notApplicableMetric(),
        total: unknownMetric(reason),
    }
}

function metricFromKeys(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
): Metric {
    return (
        metricFromKeysOptional(source, keys, metricSource) ??
        unknownMetric("not_reported")
    )
}

function metricFromKeysOptional(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
): Metric | null {
    for (const key of keys) {
        if (!(key in source) || source[key] == null) continue
        const value = source[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0
            ? knownMetric(value, metricSource)
            : unknownMetric("parse_error")
    }
    return null
}

function firstReportedMetric(metrics: readonly (Metric | null)[]): Metric {
    return (
        metrics.find((metric): metric is Metric => metric !== null) ??
        unknownMetric("not_reported")
    )
}

function sumMetrics(metrics: readonly Metric[]): Metric {
    if (metrics.every((metric) => metric.state === "known")) {
        return knownMetric(
            metrics.reduce(
                (sum, metric) =>
                    sum + (metric.state === "known" ? metric.value : 0),
                0,
            ),
            "derived",
        )
    }
    const unknown = metrics.find((metric) => metric.state === "unknown")
    return unknown?.state === "unknown"
        ? unknownMetric(unknown.reason)
        : unknownMetric("not_reported")
}

function isExecTimeout(error: unknown): boolean {
    if (!isRecord(error)) return false
    if (error.killed === true || error.code === "ETIMEDOUT") return true
    return (
        typeof error.message === "string" &&
        /(?:timed?\s*out|timeout)/i.test(error.message)
    )
}

function isErrorSubtype(value: unknown): boolean {
    return typeof value === "string" && value.toLowerCase().startsWith("error")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

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
