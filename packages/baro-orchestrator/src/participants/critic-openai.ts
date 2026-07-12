/**
 * CriticOpenAI — sibling of `Critic` that runs the verdict evaluation
 * through Mozaik 3.9's native OpenAI inference runner instead of
 * shelling out to `claude --print`.
 *
 * Same bus contract:
 *   - Observes `AgentResultItem` on the bus.
 *   - Emits one `CritiqueItem` per evaluation (always).
 *   - Emits at most `maxEmissionsPerAgent` `AgentTargetedMessageItem`s
 *     when the verdict is "fail" — those get injected back into the
 *     running Claude session's stdin via `ClaudeCliParticipant`.
 *
 * Wired via `OrchestrateConfig.llm === "openai"` in `orchestrate.ts`.
 * Default model: `gpt-5.4-mini`. Critic is the highest-volume LLM
 * caller in a run (one verdict per agent per turn) and the verdict is
 * a structured PASS/FAIL — mini handles it reliably without burning
 * flagship-tier tokens on per-turn work. Every other OpenAI phase is
 * 5.5 because they're one-shot or rare; Critic is the exception.
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

import {
    GenericOpenAIModel,
    UsageAccumulator,
    runInferenceRound,
} from "../planning/openai-runtime.js"
import {
    AgentTargetedMessage,
    Critique,
    ModelInvocationMeasured,
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
import {
    VERDICT_SYSTEM_PROMPT,
    buildCorrectiveMessage,
    buildEvalPrompt,
    extractVerdictJson,
} from "./critic.js"
import { criticInput } from "./critic-input.js"

export interface CriticOpenAIOptions {
    /** Map from agentId to its acceptance-criteria strings. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Max corrective AgentTargetedMessageItem-s per agent. Default: 2. */
    maxEmissionsPerAgent?: number
    /**
     * OpenAI model name. One of the names Mozaik 3.9 ships:
     * `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`.
     * Default: `gpt-5.4-mini` (cheap; Critic runs per turn per agent).
     */
    model?: string
    /** Run correlation used by model-invocation telemetry. */
    runId?: string
}

interface CriticOpenAIEvaluation {
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: string[]
    /** Optional only so existing test/subclass overrides remain compatible. */
    telemetry?: CriticOpenAITelemetry
}

interface CriticOpenAITelemetry {
    status: ModelInvocationStatus
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
}

/** Instantiate the Mozaik model wrapper for a given OpenAI model name. */
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

export class CriticOpenAI extends BaseObserver {
    private readonly opts: Required<Omit<CriticOpenAIOptions, "runId">> & {
        runId?: string
    }
    private readonly model: GenerativeModel

    private readonly emissions = new Map<string, number>()
    private readonly turnCount = new Map<string, number>()
    private readonly seenTerminalIds = new Set<string>()
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: CriticOpenAIOptions) {
        super()
        this.opts = {
            maxEmissionsPerAgent: opts.maxEmissionsPerAgent ?? 2,
            model: opts.model ?? "gpt-5.4-mini",
            targets: opts.targets,
            runId: opts.runId,
        }
        this.model = pickModel(this.opts.model)
    }

    /** Resolves once every in-flight evaluation has emitted its CritiqueItem. */
    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        const input = criticInput(event)
        if (!input) return
        const { agentId, isError, resultText, canContinue, terminalId } = input
        if (isError || !resultText) return

        const criteria = this.opts.targets.get(agentId)
        if (!criteria || criteria.length === 0) return
        if (terminalId) {
            if (this.seenTerminalIds.has(terminalId)) return
            this.seenTerminalIds.add(terminalId)
        }

        const turn = (this.turnCount.get(agentId) ?? 0) + 1
        this.turnCount.set(agentId, turn)

        const work = (async () => {
            const evaluation = await this.evaluate(
                resultText,
                criteria,
            )
            const { verdict, reasoning, violatedCriteria } = evaluation

            // Consumers must see the usage evidence before the Critique it
            // explains. The stable ID also makes event-log replay idempotent.
            this.publishMeasurement(
                agentId,
                turn,
                evaluation.telemetry ?? unknownOpenAITelemetry("succeeded", "not_reported"),
            )

            const critiqueEvent = Critique.create({
                agentId,
                verdict,
                reasoning,
                violatedCriteria,
                turn,
                modelUsed: this.opts.model,
            })
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, critiqueEvent)
            }

            if (verdict === "fail" && canContinue) {
                const emitted = this.emissions.get(agentId) ?? 0
                if (emitted < this.opts.maxEmissionsPerAgent) {
                    this.emissions.set(agentId, emitted + 1)
                    const text = buildCorrectiveMessage(reasoning, violatedCriteria)
                    const msg = AgentTargetedMessage.create({
                        recipientId: agentId,
                        text,
                        metadata: {
                            criticTurn: turn,
                            emissionIndex: emitted + 1,
                        },
                    })
                    for (const env of this.getEnvironments()) {
                        env.deliverSemanticEvent(this, msg)
                    }
                }
            }
        })()

        this.pending.add(work)
        work.finally(() => this.pending.delete(work))
    }

    private publishMeasurement(
        agentId: string,
        turn: number,
        telemetry: CriticOpenAITelemetry,
    ): void {
        const invocationId = `${this.opts.runId ?? "local"}:critic:${agentId}:${turn}`
        const data: ModelInvocationMeasuredData = {
            schemaVersion: 1,
            measurementId: `${invocationId}:runner`,
            invocationId,
            runId: this.opts.runId ?? null,
            phase: "critic",
            storyId: agentId,
            attempt: null,
            turn,
            round: 1,
            backend: "openai",
            // A custom OpenAI-compatible base URL may front another provider,
            // so the runtime backend alone is not trustworthy attribution.
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

    /**
     * One-shot OpenAI inference call. Builds a ModelContext with the
     * verdict system prompt + the eval prompt, runs the inference, and
     * parses the JSON verdict the model returned. Same prompt and same
     * JSON shape as the Claude version so behaviour stays comparable
     * for benchmarking.
     */
    private async evaluate(
        resultText: string,
        criteria: readonly string[],
    ): Promise<CriticOpenAIEvaluation> {
        const userPrompt = buildEvalPrompt(criteria, resultText)
        const context = ModelContext.create("critic")
            .addContextItem(SystemMessageItem.create(VERDICT_SYSTEM_PROMPT))
            .addContextItem(UserMessageItem.create(userPrompt))

        let round: Awaited<ReturnType<typeof runInferenceRound>>
        try {
            round = await this.runRound(context)
        } catch (err) {
            const timedOut = isProviderTimeout(err)
            return openAIFailure(
                err,
                unknownOpenAITelemetry(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
            )
        }

        // A resolved inference round is a successful provider response even
        // if the assistant's verdict is malformed. Keep its usage intact and
        // fail only the Critique parsing below.
        const telemetry = openAITelemetry(round.usage)
        const usage = new UsageAccumulator()
        usage.add(round.usage)
        process.stderr.write(`[critic-openai] ${usage.summary()}\n`)

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

            const verdictJson = extractVerdictJson(assistantText)
            const parsed = JSON.parse(verdictJson) as {
                verdict: "pass" | "fail"
                reasoning: string
                violated_criteria: string[]
            }
            return {
                verdict: parsed.verdict === "pass" ? "pass" : "fail",
                reasoning: parsed.reasoning ?? "",
                violatedCriteria: Array.isArray(parsed.violated_criteria)
                    ? parsed.violated_criteria
                    : [],
                telemetry,
            }
        } catch (err) {
            return openAIFailure(err, telemetry)
        }
    }

    /** Narrow override seam for protocol-focused tests; production uses the shared runtime. */
    private runRound(context: ModelContext) {
        return runInferenceRound(context, this.model)
    }
}

function openAIFailure(
    err: unknown,
    telemetry: CriticOpenAITelemetry,
): CriticOpenAIEvaluation {
    return {
        verdict: "fail",
        reasoning: `Critic (OpenAI) LLM call failed: ${String((err as Error)?.message ?? err)}`,
        violatedCriteria: ["[critic-openai error — could not evaluate]"],
        telemetry,
    }
}

function openAITelemetry(usage: TokenUsage | undefined): CriticOpenAITelemetry {
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
): CriticOpenAITelemetry {
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
