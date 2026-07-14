/**
 * SurgeonOpenAI — sibling of `Surgeon` that runs the replan-reasoning
 * call through Mozaik 3.9's native OpenAI inference runner instead of
 * shelling out to `claude --print`.
 *
 * Same bus contract:
 *   - Observes `StoryResultItem` failures (`success === false`).
 *   - For each failure within the per-run `maxReplans` budget, asks
 *     the model for a structured replan (split/prereq/rewire/skip/abort).
 *   - Emits one `ReplanItem` per evaluation (or zero on "abort").
 *   - Falls back to the deterministic skip strategy on inference errors
 *     so a flaky LLM call doesn't strand the run.
 *
 * Wired via `OrchestrateConfig.llm === "openai"` in `orchestrate.ts`.
 * Default model: `gpt-5.5` — every OpenAI phase routes through 5.5 now.
 * Surgeon's reasoning load justifies the flagship even more than the
 * higher-frequency Critic does.
 */

import {
    BaseObserver,
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    ModelContext,
    SemanticEvent,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
    type Participant,
    type TokenUsage,
} from "@mozaik-ai/core"

import type { GatewayBillingCoordinator } from "../billing/index.js"
import {
    GenericOpenAIModel,
    UsageAccumulator,
    runInferenceRound,
} from "../planning/openai-runtime.js"

import {
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
import {
    SURGEON_SYSTEM_PROMPT,
    buildSurgeonPrompt,
    CritiqueLog,
    extractJsonObject,
    surgeonDeterministicReplan,
    type PrdSnapshot,
    type RouteDescriber,
} from "./surgeon.js"

export interface SurgeonOpenAIOptions {
    /** PRD snapshot provider. Same shape as `Surgeon`. */
    snapshot: () => PrdSnapshot
    /** Describes the model a story actually ran on (issue #48). */
    resolveRoute?: RouteDescriber
    /** Explicit `backend:model` the Surgeon may set to escalate a stuck, right-sized story. */
    escalationRoute?: string
    /** Max replans this Surgeon will emit per run. Default: 10. */
    maxReplans?: number
    /**
     * OpenAI model name. One of `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
     * `gpt-5.4-nano`. Default: `gpt-5.5`.
     */
    model?: string
    runId?: string
    emitRecoveryDecisions?: boolean
    /** Collective-only dynamic authority for terminal execution results. */
    outcomeAuthority?: StoryOutcomeAuthority
    /** Trusted Gateway receipt correlation for recovery evaluator calls. */
    billingCoordinator?: GatewayBillingCoordinator
}

interface SurgeonOpenAIEvaluation {
    replan: ReplanData | null
    telemetry: SurgeonOpenAITelemetry
}

interface SurgeonOpenAITelemetry {
    status: ModelInvocationStatus
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
}

function pickModel(name: string): GenerativeModel {
    switch (name) {
        case "gpt-5.5":
            return new Gpt55()
        case "gpt-5.4":
            return new Gpt54()
        case "gpt-5.4-mini":
            return new Gpt54Mini()
        case "gpt-5.4-nano":
            return new Gpt54Nano()
        default:
            process.stderr.write(
                `[pickModel] Using model "${name}" as-is with the OpenAI API.\n`,
            )
            return new GenericOpenAIModel(name)
    }
}

export class SurgeonOpenAI extends BaseObserver {
    private readonly opts: Required<Pick<SurgeonOpenAIOptions, "maxReplans" | "model">> &
        SurgeonOpenAIOptions
    private readonly model: GenerativeModel
    private readonly billingCoordinator: GatewayBillingCoordinator | null

    private replansEmitted = 0
    /** Monotonic correlation for legacy failures that have no lease generation. */
    private evaluationSequence = 0
    private readonly critiques = new CritiqueLog()
    private readonly leases = new ActiveLeaseRegistry()
    private readonly sources: RecoverySourceAuthority
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: SurgeonOpenAIOptions) {
        super()
        this.sources = new RecoverySourceAuthority(opts.outcomeAuthority)
        this.opts = {
            maxReplans: opts.maxReplans ?? Infinity,
            model: opts.model ?? "gpt-5.5",
            snapshot: opts.snapshot,
            resolveRoute: opts.resolveRoute,
            escalationRoute: opts.escalationRoute,
            runId: opts.runId,
            emitRecoveryDecisions: opts.emitRecoveryDecisions,
            outcomeAuthority: opts.outcomeAuthority,
        }
        this.model = pickModel(this.opts.model)
        this.billingCoordinator = opts.billingCoordinator?.trustsEndpoint(
            process.env.OPENAI_BASE_URL,
            process.env.OPENAI_API_KEY,
        )
            ? opts.billingCoordinator
            : null
    }

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
                const sequence = ++this.evaluationSequence
                const evaluation = await this.evaluate(failure, sequence)
                if (!this.billingCoordinator) {
                    this.publishMeasurement(
                        failure,
                        sequence,
                        evaluation.telemetry,
                    )
                }
                const { replan } = evaluation
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
        telemetry: SurgeonOpenAITelemetry,
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
            round: 1,
            backend: "openai",
            // A custom OpenAI-compatible endpoint may front another vendor.
            provider: null,
            requestedModel: this.opts.model,
            resolvedModel: this.opts.model,
            status: telemetry.status,
            durationMs: telemetry.durationMs,
            tokens: telemetry.tokens,
            cost: telemetry.cost,
            evidence: {
                producer: "runner",
                providerRequestId: null,
                rateCardVersion: null,
                granularity: "round",
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
                    source: "surgeon:openai",
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
                    source: "surgeon:openai",
                    action,
                    reason,
                }),
            )
        }
    }

    /**
     * One-shot OpenAI inference call asking the model for a structured
     * replan. Returns `null` on the "abort" action (no Replan event
     * emitted, run ends). Returns a deterministic-skip data shape on any
     * inference or JSON-parse error so the run still has a chance to
     * recover.
     */
    private async evaluate(
        failure: StoryResultData,
        sequence: number,
    ): Promise<SurgeonOpenAIEvaluation> {
        const snap = this.opts.snapshot()
        const userPrompt = buildSurgeonPrompt(
            snap,
            failure,
            this.opts.resolveRoute,
            this.opts.escalationRoute,
            this.critiques.forStory(failure.storyId),
        )
        const context = ModelContext.create("surgeon")
            .addContextItem(SystemMessageItem.create(SURGEON_SYSTEM_PROMPT))
            .addContextItem(UserMessageItem.create(userPrompt))

        let round: Awaited<ReturnType<typeof runInferenceRound>>
        try {
            round = await this.runRound(context, failure, sequence)
        } catch (err) {
            const timedOut = isProviderTimeout(err)
            return openAIFallback(
                failure,
                err,
                unknownOpenAITelemetry(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
            )
        }

        // A resolved round is a successful provider response even if the
        // replan text below is empty or malformed.
        const telemetry = openAITelemetry(round.usage)
        const usage = new UsageAccumulator()
        usage.add(round.usage)
        process.stderr.write(`[surgeon-openai] ${usage.summary()}\n`)

        try {
            let assistantText = ""
            for (const item of round.items) {
                if (item.type === "message") {
                    const json = item.toJSON() as { content: Array<{ text: string }> }
                    assistantText += json.content?.[0]?.text ?? ""
                }
            }
            if (!assistantText.trim()) {
                throw new Error("OpenAI returned empty assistant text")
            }

            const verdictJson = extractJsonObject(assistantText)
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
            return openAIFallback(failure, err, telemetry)
        }
    }

    /** Narrow override seam for protocol-focused tests; production uses the shared runtime. */
    private runRound(
        context: ModelContext,
        failure: StoryResultData,
        sequence: number,
    ) {
        return runInferenceRound(
            context,
            this.model,
            this.billingCoordinator
                ? {
                      billing: {
                          coordinator: this.billingCoordinator,
                          context: {
                              runId:
                                  this.opts.runId ?? failure.runId ?? null,
                              phase: "surgeon",
                              storyId: failure.storyId,
                              leaseId: failure.leaseId ?? null,
                              generation: failure.generation ?? null,
                              attempt: null,
                              turn: sequence,
                              round: 1,
                          },
                      },
                  }
                : {},
        )
    }
}

function openAIFallback(
    failure: StoryResultData,
    error: unknown,
    telemetry: SurgeonOpenAITelemetry,
): SurgeonOpenAIEvaluation {
    const fallback = surgeonDeterministicReplan(failure)
    return {
        replan: {
            ...fallback,
            reason: `${fallback.reason} (openai-llm fallback after error: ${(error as Error)?.message ?? String(error)})`,
        },
        telemetry,
    }
}

function openAITelemetry(
    usage: TokenUsage | undefined,
): SurgeonOpenAITelemetry {
    return {
        status: "succeeded",
        durationMs: unknownMetric("not_reported"),
        tokens: usage
            ? {
                  inputTotal: tokenMetric(usage.inputTokens),
                  cachedInput: tokenMetric(
                      usage.inputTokenDetails?.cached_tokens,
                  ),
                  cacheWriteInput: notApplicableMetric(),
                  outputTotal: tokenMetric(usage.outputTokens),
                  reasoningOutput: tokenMetric(
                      usage.outputTokenDetails?.reasoning_tokens,
                  ),
                  total: tokenMetric(usage.totalTokens),
              }
            : unknownOpenAITokens("not_reported"),
        cost: pendingOpenAICost(),
    }
}

function unknownOpenAITelemetry(
    status: ModelInvocationStatus,
    reason: UnknownMetricReason,
): SurgeonOpenAITelemetry {
    return {
        status,
        durationMs: unknownMetric(reason),
        tokens: unknownOpenAITokens(reason),
        cost: pendingOpenAICost(),
    }
}

function unknownOpenAITokens(reason: UnknownMetricReason): ModelTokenMetrics {
    return {
        inputTotal: unknownMetric(reason),
        cachedInput: unknownMetric(reason),
        cacheWriteInput: notApplicableMetric(),
        outputTotal: unknownMetric(reason),
        reasoningOutput: unknownMetric(reason),
        total: unknownMetric(reason),
    }
}

function pendingOpenAICost(): ModelCostMetrics {
    return {
        providerUsd: unknownMetric("pending_gateway_meter"),
        customerUsd: unknownMetric("pending_gateway_meter"),
        equivalentUsd: notApplicableMetric(),
    }
}

function tokenMetric(value: unknown): Metric {
    return value == null
        ? unknownMetric("not_reported")
        : typeof value === "number" && Number.isFinite(value) && value >= 0
          ? knownMetric(value, "provider_response")
          : unknownMetric("parse_error")
}

function isProviderTimeout(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false
    const item = error as Record<string, unknown>
    if (item.name === "AbortError" || item.code === "ETIMEDOUT") return true
    return (
        typeof item.message === "string" &&
        /(?:timed?\s*out|timeout)/i.test(item.message)
    )
}
