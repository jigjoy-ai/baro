/**
 * CriticCopilot — live acceptance-criteria evaluator via `copilot -p
 * --output-format json`. Sibling of `critic.ts` (Claude),
 * `critic-codex.ts`, and `critic-openai.ts`.
 *
 * Same bus contract as the Claude variant: observes AgentResultItem
 * events, evaluates the agent's output against acceptance criteria,
 * publishes a CritiqueItem (audit trail), and emits an
 * AgentTargetedMessageItem corrective when the verdict is "fail" (up
 * to maxEmissionsPerAgent). The only difference is which subprocess
 * the verdict call shells to.
 *
 * Library-grade: no imports from prd.ts, story-agent.ts, or
 * conductor.ts.
 */

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { runCopilotOneShot } from "../copilot-one-shot.js"
import {
    AgentResult,
    AgentTargetedMessage,
    Critique,
} from "../semantic-events.js"
import {
    VERDICT_SYSTEM_PROMPT,
    buildEvalPrompt,
    buildCorrectiveMessage,
    extractVerdictJson,
} from "./critic.js"

export interface CriticCopilotOptions {
    /** Map from agentId to its acceptance-criteria strings. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Max corrective AgentTargetedMessageItem-s per agent. Default: 2. */
    maxEmissionsPerAgent?: number
    /** Copilot model used for verdict calls. Default: undefined (Copilot picks). */
    model?: string
    /** Path to the `copilot` binary. Default: "copilot". */
    copilotBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 180_000 (3 min). */
    timeoutMs?: number
}

export class CriticCopilot extends BaseObserver {
    private readonly opts: Required<
        Omit<CriticCopilotOptions, "targets" | "model" | "copilotBin">
    > & {
        targets: ReadonlyMap<string, readonly string[]>
        model: string | undefined
        copilotBin: string
    }
    private readonly emissions = new Map<string, number>()
    private readonly turnCount = new Map<string, number>()
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: CriticCopilotOptions) {
        super()
        this.opts = {
            maxEmissionsPerAgent: opts.maxEmissionsPerAgent ?? 2,
            model: opts.model,
            copilotBin: opts.copilotBin ?? "copilot",
            timeoutMs: opts.timeoutMs ?? 180_000,
            targets: opts.targets,
        }
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
                modelUsed: this.opts.model ?? "copilot-default",
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
        work.finally(() => {
            this.pending.delete(work)
        })

        await work
    }

    private async evaluate(
        resultText: string,
        criteria: readonly string[],
    ): Promise<{
        verdict: "pass" | "fail"
        reasoning: string
        violatedCriteria: string[]
    }> {
        const userPrompt = buildEvalPrompt(criteria, resultText)
        const prompt = `${VERDICT_SYSTEM_PROMPT}\n\n${userPrompt}`

        try {
            const text = await runCopilotOneShot({
                prompt,
                cwd: process.cwd(),
                model: this.opts.model,
                copilotBin: this.opts.copilotBin,
                timeoutMs: this.opts.timeoutMs,
                label: "copilot-critic",
            })

            const verdictJson = extractVerdictJson(text.trim())
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
                reasoning: `CriticCopilot LLM call failed: ${String((err as Error)?.message ?? err)}`,
                violatedCriteria: ["[critic error — could not evaluate]"],
            }
        }
    }
}
