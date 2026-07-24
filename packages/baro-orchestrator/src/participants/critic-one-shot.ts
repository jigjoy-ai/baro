/**
 * Shared skeleton for one-shot CLI critics (Codex, OpenCode, Pi). The bus
 * contract, replay dedup, evidence preparation, Critique/corrective emission,
 * and telemetry are identical across backends; a subclass supplies only the
 * subprocess invocation and its verdict parser.
 *
 * Library-grade: no imports from prd.ts, story-agent.ts, or conductor.ts.
 */

import { BaseObserver, Participant, SemanticEvent } from "../runtime/mozaik.js"

import { runnerMeasurement } from "../runner-measurement.js"
import type { RunnerInvocationObserver } from "../runner-invocation.js"
import {
    AgentTargetedMessage,
    Critique,
    ModelInvocationMeasured,
} from "../semantic-events.js"
import { buildCorrectiveMessage, extractVerdictJson } from "./critic-verdict.js"
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

export interface OneShotCriticEvaluation {
    status?: "evaluated" | "inconclusive"
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: string[]
}

export interface OneShotCriticCoreOptions extends TerminalTurnAuthorityOptions {
    /** Map from agentId to its acceptance-criteria strings. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Max corrective AgentTargetedMessageItem-s per agent. Default: 2. */
    maxEmissionsPerAgent?: number
    /** Per-evaluation timeout in milliseconds. Default: 180_000 (3 min). */
    timeoutMs?: number
    runId?: string
    /** Bounded repository + command evidence captured independently of the summary. */
    evidence?: CriticEvidenceSource
}

export interface OneShotCriticBackendSpec {
    /** Telemetry backend tag. */
    backend: "claude" | "codex" | "opencode" | "pi"
    /** Critique `modelUsed` when no explicit model was requested. */
    defaultModelLabel: string
    /** Human-facing prefix for evaluator failure reasons. */
    errorLabel: string
}

export interface OneShotCriticInvocationContext {
    cwd: string
    timeoutMs: number
    onInvocation: RunnerInvocationObserver
}

export abstract class OneShotCritic extends BaseObserver {
    private readonly terminalAuthorities: TerminalTurnAuthorityOptions
    private readonly maxEmissionsPerAgent: number
    private readonly targets: ReadonlyMap<string, readonly string[]>
    protected readonly runId: string | undefined
    private readonly evidence: CriticEvidenceSource | undefined
    protected readonly timeoutMs: number
    private readonly emissions = new Map<string, number>()
    private readonly turnCount = new Map<string, number>()
    private readonly seenTerminalIds = new Set<string>()
    private readonly pending = new Set<Promise<void>>()

    protected constructor(
        core: OneShotCriticCoreOptions,
        private readonly spec: OneShotCriticBackendSpec,
        /** Critique `modelUsed` / telemetry model, when explicitly requested. */
        private readonly requestedModel: string | undefined,
    ) {
        super()
        this.targets = core.targets
        this.maxEmissionsPerAgent = core.maxEmissionsPerAgent ?? 2
        this.timeoutMs = core.timeoutMs ?? 180_000
        this.runId = core.runId
        this.evidence = core.evidence
        this.terminalAuthorities = {
            outcomeAuthority: core.outcomeAuthority,
            terminalProjectorAuthority: core.terminalProjectorAuthority,
        }
    }

    /** Run one evaluator subprocess and return its raw response text. */
    protected abstract invoke(
        prompt: string,
        context: OneShotCriticInvocationContext,
    ): Promise<string>

    /** Turn raw evaluator text into a verdict; throw to mark inconclusive. */
    protected parseVerdict(text: string): OneShotCriticEvaluation {
        const parsed = JSON.parse(extractVerdictJson(text.trim())) as {
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
    }

    /**
     * Runs after each evaluation, before its Critique reaches the bus —
     * the slot for backend telemetry that must precede the verdict it
     * describes. `preparationReady` is false when evidence preparation
     * failed or was inconclusive, i.e. no evaluator model was invoked.
     */
    protected onEvaluationSettled(
        _agentId: string,
        _turn: number,
        _evaluation: OneShotCriticEvaluation,
        _preparationReady: boolean,
    ): void {}

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

        const criteria = this.targets.get(agentId)
        if (!criteria || criteria.length === 0) return
        const replayKey = criticReplayKey(agentId, terminalId)
        if (replayKey) {
            if (this.seenTerminalIds.has(replayKey)) return
            this.seenTerminalIds.add(replayKey)
        }

        const turn = (this.turnCount.get(agentId) ?? 0) + 1
        this.turnCount.set(agentId, turn)

        const work = (async () => {
            let repositoryFingerprint: string | null = null
            let preparationReady = false
            let evaluation: OneShotCriticEvaluation
            try {
                const preparation = await prepareCriticEvaluation(
                    criteria,
                    resultText,
                    agentId,
                    this.evidence,
                )
                repositoryFingerprint = preparation.repositoryFingerprint
                preparationReady = preparation.status === "ready"
                evaluation = preparationReady
                    ? await this.evaluate(preparation.prompt, agentId, turn)
                    : inconclusiveEvidenceVerdict(preparation.issues)
            } catch (error) {
                evaluation = {
                    status: "inconclusive",
                    verdict: "fail",
                    reasoning:
                        `${this.spec.errorLabel} could not prepare bounded acceptance ` +
                        `evidence: ${String((error as Error)?.message ?? error)}`,
                    violatedCriteria: [
                        "[critic evidence preparation failed]",
                    ],
                }
            }
            this.onEvaluationSettled(agentId, turn, evaluation, preparationReady)
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
                modelUsed: this.requestedModel ?? this.spec.defaultModelLabel,
                ...(repositoryFingerprint ? { repositoryFingerprint } : {}),
            })
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, critiqueEvent)
            }

            if (status === "evaluated" && verdict === "fail" && canContinue) {
                const emitted = this.emissions.get(agentId) ?? 0
                if (emitted < this.maxEmissionsPerAgent) {
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
        void work.then(
            () => this.pending.delete(work),
            () => this.pending.delete(work),
        )

        await work
    }

    protected async evaluate(
        userPrompt: string,
        agentId: string,
        turn: number,
    ): Promise<OneShotCriticEvaluation> {
        try {
            const text = await withIsolatedCriticCwd((cwd) =>
                this.invoke(userPrompt, {
                    cwd,
                    timeoutMs: this.timeoutMs,
                    onInvocation: this.invocationObserver(agentId, turn),
                }),
            )
            return this.parseVerdict(text)
        } catch (err) {
            return {
                status: "inconclusive",
                verdict: "fail",
                reasoning: `${this.spec.errorLabel} LLM call failed: ${String((err as Error)?.message ?? err)}`,
                violatedCriteria: ["[critic error — could not evaluate]"],
            }
        }
    }

    private invocationObserver(agentId: string, turn: number): RunnerInvocationObserver {
        return (observation) => {
            const event = ModelInvocationMeasured.create(
                runnerMeasurement(
                    {
                        invocationBaseId: `${this.runId ?? "local"}:critic:${agentId}:${turn}`,
                        runId: this.runId ?? null,
                        phase: "critic",
                        storyId: agentId,
                        turn,
                        backend: this.spec.backend,
                        requestedModel: this.requestedModel ?? null,
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
