/**
 * CriticCodex — live acceptance-criteria evaluator via `codex exec
 * --json`. Sibling of `critic.ts` (Claude) and `critic-openai.ts`.
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

import { runCodexOneShot } from "../codex-one-shot.js"
import { runnerMeasurement } from "../runner-measurement.js"
import type { RunnerInvocationObserver } from "../runner-invocation.js"
import {
    AgentTargetedMessage,
    Critique,
    ModelInvocationMeasured,
} from "../semantic-events.js"
import {
    VERDICT_SYSTEM_PROMPT,
    buildEvalPrompt,
    buildCorrectiveMessage,
    extractVerdictJson,
} from "./critic.js"
import { criticInput } from "./critic-input.js"

export interface CriticCodexOptions {
    /** Map from agentId to its acceptance-criteria strings. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Max corrective AgentTargetedMessageItem-s per agent. Default: 2. */
    maxEmissionsPerAgent?: number
    /** Codex model used for verdict calls. Default: undefined (Codex picks). */
    model?: string
    /** Path to the `codex` binary. Default: "codex". */
    codexBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 180_000 (3 min). */
    timeoutMs?: number
    runId?: string
}

export class CriticCodex extends BaseObserver {
    private readonly opts: Required<
        Omit<CriticCodexOptions, "targets" | "model" | "codexBin" | "runId">
    > & {
        targets: ReadonlyMap<string, readonly string[]>
        model: string | undefined
        codexBin: string
        runId: string | undefined
    }
    private readonly emissions = new Map<string, number>()
    private readonly turnCount = new Map<string, number>()
    private readonly seenTerminalIds = new Set<string>()
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: CriticCodexOptions) {
        super()
        this.opts = {
            maxEmissionsPerAgent: opts.maxEmissionsPerAgent ?? 2,
            model: opts.model,
            codexBin: opts.codexBin ?? "codex",
            timeoutMs: opts.timeoutMs ?? 180_000,
            targets: opts.targets,
            runId: opts.runId,
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
            const { verdict, reasoning, violatedCriteria } = await this.evaluate(
                resultText,
                criteria,
                agentId,
                turn,
            )

            const critiqueEvent = Critique.create({
                agentId,
                verdict,
                reasoning,
                violatedCriteria,
                turn,
                modelUsed: this.opts.model ?? "codex-default",
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
        work.finally(() => {
            this.pending.delete(work)
        })

        await work
    }

    private async evaluate(
        resultText: string,
        criteria: readonly string[],
        agentId: string,
        turn: number,
    ): Promise<{
        verdict: "pass" | "fail"
        reasoning: string
        violatedCriteria: string[]
    }> {
        const userPrompt = buildEvalPrompt(criteria, resultText)
        const prompt = `${VERDICT_SYSTEM_PROMPT}\n\n${userPrompt}`

        try {
            const text = await runCodexOneShot({
                prompt,
                cwd: process.cwd(),
                skipGitRepoCheck: true,
                bypassSandbox: true,
                model: this.opts.model,
                codexBin: this.opts.codexBin,
                timeoutMs: this.opts.timeoutMs,
                label: "codex-critic",
                onInvocation: this.invocationObserver(agentId, turn),
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
                reasoning: `CriticCodex LLM call failed: ${String((err as Error)?.message ?? err)}`,
                violatedCriteria: ["[critic error — could not evaluate]"],
            }
        }
    }

    private invocationObserver(agentId: string, turn: number): RunnerInvocationObserver {
        return (observation) => {
            const event = ModelInvocationMeasured.create(
                runnerMeasurement(
                    {
                        invocationBaseId: `${this.opts.runId ?? "local"}:critic:${agentId}:${turn}`,
                        runId: this.opts.runId ?? null,
                        phase: "critic",
                        storyId: agentId,
                        turn,
                        backend: "codex",
                        requestedModel: this.opts.model ?? null,
                    },
                    observation,
                ),
            )
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, event)
            }
        }
    }
}
