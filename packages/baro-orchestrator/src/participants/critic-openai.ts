/**
 * CriticOpenAI — sibling of `Critic` that runs the verdict evaluation
 * through Mozaik 3.9's native OpenAI inference runner instead of
 * shelling out to `claude --print`.
 *
 * Same bus contract:
 *   - Observes `ClaudeResultItem` on the bus.
 *   - Emits one `CritiqueItem` per evaluation (always).
 *   - Emits at most `maxEmissionsPerAgent` `AgentTargetedMessageItem`s
 *     when the verdict is "fail" — those get injected back into the
 *     running Claude session's stdin via `ClaudeCliParticipant`.
 *
 * Wired via `OrchestrateConfig.llm === "openai"` in `orchestrate.ts`.
 * Default model: `gpt-5.4-mini` (cheap, fast — Critic runs per turn
 * per agent and is the highest-volume LLM caller in a baro run).
 */

import {
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    ModelContext,
    OpenAIInferenceRunner,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
    type Participant,
} from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "../bus.js"
import {
    AgentTargetedMessageItem,
    ClaudeResultItem,
    CritiqueItem,
} from "../types.js"
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
            throw new Error(
                `CriticOpenAI: unknown model "${name}" — Mozaik 3.9 ships ` +
                `gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano`,
            )
    }
}

export class CriticOpenAI extends BaroParticipant {
    private readonly opts: Required<CriticOpenAIOptions>
    private readonly model: GenerativeModel
    private readonly runner = new OpenAIInferenceRunner()

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

    override async onExternalBusEvent(_source: Participant, event: BusEvent): Promise<void> {
        if (!(event instanceof ClaudeResultItem)) return
        if (event.isError || !event.resultText) return

        const criteria = this.opts.targets.get(event.agentId)
        if (!criteria || criteria.length === 0) return

        const turn = (this.turnCount.get(event.agentId) ?? 0) + 1
        this.turnCount.set(event.agentId, turn)

        const work = (async () => {
            const { verdict, reasoning, violatedCriteria } = await this.evaluate(
                event.resultText!,
                criteria,
            )

            const critiqueItem = new CritiqueItem(
                event.agentId,
                verdict,
                reasoning,
                violatedCriteria,
                turn,
                this.opts.model,
            )
            for (const env of this.getEnvironments()) {
                ;(env as BaroEnvironment).deliverBusEvent(this, critiqueItem)
            }

            if (verdict === "fail") {
                const emitted = this.emissions.get(event.agentId) ?? 0
                if (emitted < this.opts.maxEmissionsPerAgent) {
                    this.emissions.set(event.agentId, emitted + 1)
                    const text = buildCorrectiveMessage(reasoning, violatedCriteria)
                    const msg = new AgentTargetedMessageItem(event.agentId, text, {
                        criticTurn: turn,
                        emissionIndex: emitted + 1,
                    })
                    for (const env of this.getEnvironments()) {
                        ;(env as BaroEnvironment).deliverBusEvent(this, msg)
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
            let assistantText = ""
            for await (const item of this.runner.run(context, this.model)) {
                if (item.type === "message" && item.role === "assistant") {
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
