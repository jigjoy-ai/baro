/**
 * CriticPi — live acceptance-criteria evaluator via the `pi` CLI.
 * Sibling of `critic.ts` (Claude), `critic-openai.ts`, `critic-codex.ts`,
 * and `critic-opencode.ts`.
 *
 * Same bus contract as the other variants: observes AgentResultItem
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

import { runPiOneShot } from "../pi-one-shot.js"
import { runnerMeasurement } from "../runner-measurement.js"
import type { RunnerInvocationObserver } from "../runner-invocation.js"
import {
    AgentTargetedMessage,
    Critique,
    ModelInvocationMeasured,
} from "../semantic-events.js"
import {
    VERDICT_SYSTEM_PROMPT,
    buildCorrectiveMessage,
    extractVerdictJson,
} from "./critic.js"
import {
    inconclusiveEvidenceVerdict,
    prepareCriticEvaluation,
    type CriticEvidenceSource,
} from "./critic-evidence.js"
import { withIsolatedCriticCwd } from "./critic-cli-isolation.js"
import { criticInput, criticReplayKey } from "./critic-input.js"
import { drainCriticPending } from "./critic-pending.js"
import {
    isAuthorizedTerminalTurn,
    type TerminalTurnAuthorityOptions,
} from "./terminal-turn-authority.js"

export interface CriticPiOptions extends TerminalTurnAuthorityOptions {
    /** Map from agentId to its acceptance-criteria strings. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Max corrective AgentTargetedMessageItem-s per agent. Default: 2. */
    maxEmissionsPerAgent?: number
    /**
     * Provider to use (e.g. "anthropic", "openai"). Omit to use Pi's
     * configured default.
     */
    provider?: string
    /**
     * Model identifier. Omit to use Pi's configured default.
     */
    model?: string
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 180_000 (3 min). */
    timeoutMs?: number
    runId?: string
    /** Bounded repository + command evidence captured independently of the summary. */
    evidence?: CriticEvidenceSource
}

export class CriticPi extends BaseObserver {
    private readonly opts: Required<
        Omit<
            CriticPiOptions,
            | "targets"
            | "provider"
            | "model"
            | "piBin"
            | "runId"
            | "evidence"
            | "outcomeAuthority"
            | "terminalProjectorAuthority"
        >
    > & {
        targets: ReadonlyMap<string, readonly string[]>
        provider: string | undefined
        model: string | undefined
        piBin: string
        runId: string | undefined
        evidence: CriticEvidenceSource | undefined
    }
    private readonly terminalAuthorities: TerminalTurnAuthorityOptions
    private readonly emissions = new Map<string, number>()
    private readonly turnCount = new Map<string, number>()
    private readonly seenTerminalIds = new Set<string>()
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: CriticPiOptions) {
        super()
        this.opts = {
            maxEmissionsPerAgent: opts.maxEmissionsPerAgent ?? 2,
            provider: opts.provider,
            model: opts.model,
            piBin: opts.piBin ?? "pi",
            timeoutMs: opts.timeoutMs ?? 180_000,
            targets: opts.targets,
            runId: opts.runId,
            evidence: opts.evidence,
        }
        this.terminalAuthorities = {
            outcomeAuthority: opts.outcomeAuthority,
            terminalProjectorAuthority: opts.terminalProjectorAuthority,
        }
    }

    /** Resolves once every in-flight evaluation has emitted its CritiqueItem. */
    async idle(): Promise<void> {
        await drainCriticPending(this.pending)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        const input = criticInput(event)
        if (!input) return
        if (!isAuthorizedTerminalTurn(source, event, input, this.terminalAuthorities)) return
        const { agentId, isError, resultText, canContinue, terminalId } = input
        if (isError || !resultText) return

        const criteria = this.opts.targets.get(agentId)
        if (!criteria || criteria.length === 0) return
        const replayKey = criticReplayKey(agentId, terminalId)
        if (replayKey) {
            if (this.seenTerminalIds.has(replayKey)) return
            this.seenTerminalIds.add(replayKey)
        }

        const turn = (this.turnCount.get(agentId) ?? 0) + 1
        this.turnCount.set(agentId, turn)

        const work = (async () => {
            const preparation = await prepareCriticEvaluation(
                criteria,
                resultText,
                agentId,
                this.opts.evidence,
            )
            const evaluation = preparation.status === "ready"
                ? await this.evaluate(preparation.prompt, agentId, turn)
                : inconclusiveEvidenceVerdict(preparation.issues)
            const { verdict, reasoning, violatedCriteria } = evaluation
            const status = evaluation.status ?? "evaluated"

            const critiqueEvent = Critique.create({
                agentId,
                ...(terminalId ? { terminalId } : {}),
                status,
                verdict,
                reasoning,
                violatedCriteria,
                turn,
                modelUsed: this.opts.model ?? "pi-default",
            })
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, critiqueEvent)
            }

            if (status === "evaluated" && verdict === "fail" && canContinue) {
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
                            ...(terminalId ? { terminalId } : {}),
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
        userPrompt: string,
        agentId: string,
        turn: number,
    ): Promise<{
        status?: "evaluated" | "inconclusive"
        verdict: "pass" | "fail"
        reasoning: string
        violatedCriteria: string[]
    }> {
        try {
            const text = await withIsolatedCriticCwd((cwd) =>
                runPiOneShot({
                    prompt: userPrompt,
                    cwd,
                    provider: this.opts.provider,
                    model: this.opts.model,
                    piBin: this.opts.piBin,
                    timeoutMs: this.opts.timeoutMs,
                    label: "pi-critic",
                    onInvocation: this.invocationObserver(agentId, turn),
                    safeEvaluatorSystemPrompt: VERDICT_SYSTEM_PROMPT,
                }),
            )

            const verdictJson = extractVerdictJson(text.trim())
            const parsed = JSON.parse(verdictJson) as {
                verdict: "pass" | "fail"
                reasoning: string
                violated_criteria: string[]
            }

            return {
                status: "evaluated",
                verdict: parsed.verdict === "pass" ? "pass" : "fail",
                reasoning: parsed.reasoning ?? "",
                violatedCriteria: Array.isArray(parsed.violated_criteria)
                    ? parsed.violated_criteria
                    : [],
            }
        } catch (err) {
            return {
                status: "inconclusive",
                verdict: "fail",
                reasoning: `CriticPi LLM call failed: ${String((err as Error)?.message ?? err)}`,
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
                        backend: "pi",
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
