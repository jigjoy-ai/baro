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
} from "@mozaik-ai/core"

import {
    GenericOpenAIModel,
    UsageAccumulator,
    runInferenceRound,
} from "../planning/openai-runtime.js"
import {
    AgentResult,
    AgentTargetedMessage,
    Critique,
} from "../semantic-events.js"
import {
    VERDICT_SYSTEM_PROMPT,
    buildCorrectiveMessage,
    buildEvalPrompt,
    extractVerdictJson,
} from "./critic.js"

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
    private readonly opts: Required<CriticOpenAIOptions>
    private readonly model: GenerativeModel

    private readonly emissions = new Map<string, number>()
    private readonly turnCount = new Map<string, number>()
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: CriticOpenAIOptions) {
        super()
        this.opts = {
            maxEmissionsPerAgent: opts.maxEmissionsPerAgent ?? 2,
            model: opts.model ?? "gpt-5.4-mini",
            targets: opts.targets,
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
        if (!AgentResult.is(event)) return
        const { agentId, isError, resultText } = event.data
        if (isError || !resultText) return

        const criteria = this.opts.targets.get(agentId)
        if (!criteria || criteria.length === 0) return

        const turn = (this.turnCount.get(agentId) ?? 0) + 1
        this.turnCount.set(agentId, turn)

        const work = (async () => {
            const { verdict, reasoning, violatedCriteria } = await this.evaluate(
                resultText,
                criteria,
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

            if (verdict === "fail") {
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
    ): Promise<{
        verdict: "pass" | "fail"
        reasoning: string
        violatedCriteria: string[]
    }> {
        const userPrompt = buildEvalPrompt(criteria, resultText)
        const context = ModelContext.create("critic")
            .addContextItem(SystemMessageItem.create(VERDICT_SYSTEM_PROMPT))
            .addContextItem(UserMessageItem.create(userPrompt))

        try {
            const round = await runInferenceRound(context, this.model)
            const usage = new UsageAccumulator()
            usage.add(round.usage)
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
            process.stderr.write(`[critic-openai] ${usage.summary()}\n`)

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
            }
        } catch (err) {
            return {
                verdict: "fail",
                reasoning: `Critic (OpenAI) LLM call failed: ${String((err as Error)?.message ?? err)}`,
                violatedCriteria: ["[critic-openai error — could not evaluate]"],
            }
        }
    }
}
