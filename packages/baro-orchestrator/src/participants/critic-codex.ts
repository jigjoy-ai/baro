/**
 * CriticCodex — live acceptance-criteria evaluator via `codex exec --json`.
 *
 * Codex CLI is an agentic harness rather than a tool-less inference API, so
 * this adapter gives it an evidence-only turn in a fresh directory with a
 * deny-workspace permission profile, no inherited tool environment, no web,
 * and no ambient configuration. The bounded evidence is piped over stdin and
 * is never exposed as repository state or command-line arguments.
 *
 * Library-grade: no imports from prd.ts, story-agent.ts, or conductor.ts.
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

export interface CriticCodexOptions extends TerminalTurnAuthorityOptions {
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
    /** Bounded repository + command evidence captured independently of the summary. */
    evidence?: CriticEvidenceSource
}

export class CriticCodex extends BaseObserver {
    private readonly opts: Required<
        Omit<
            CriticCodexOptions,
            | "targets"
            | "model"
            | "codexBin"
            | "runId"
            | "evidence"
            | "outcomeAuthority"
            | "terminalProjectorAuthority"
        >
    > & {
        targets: ReadonlyMap<string, readonly string[]>
        model: string | undefined
        codexBin: string
        runId: string | undefined
        evidence: CriticEvidenceSource | undefined
    }
    private readonly terminalAuthorities: TerminalTurnAuthorityOptions
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
            let evaluation: {
                status?: "evaluated" | "inconclusive"
                verdict: "pass" | "fail"
                reasoning: string
                violatedCriteria: string[]
            }
            try {
                const preparation = await prepareCriticEvaluation(
                    criteria,
                    resultText,
                    agentId,
                    this.opts.evidence,
                )
                evaluation = preparation.status === "ready"
                    ? await this.evaluate(preparation.prompt, agentId, turn)
                    : inconclusiveEvidenceVerdict(preparation.issues)
            } catch (error) {
                evaluation = {
                    status: "inconclusive",
                    verdict: "fail",
                    reasoning:
                        "CriticCodex could not prepare bounded acceptance " +
                        `evidence: ${String((error as Error)?.message ?? error)}`,
                    violatedCriteria: [
                        "[critic evidence preparation failed]",
                    ],
                }
            }
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
                modelUsed: this.opts.model ?? "codex-default",
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
        void work.then(
            () => this.pending.delete(work),
            () => this.pending.delete(work),
        )

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
                runCodexOneShot({
                    prompt: `${VERDICT_SYSTEM_PROMPT}\n\n${userPrompt}`,
                    promptViaStdin: true,
                    cwd,
                    model: this.opts.model,
                    codexBin: this.opts.codexBin,
                    timeoutMs: this.opts.timeoutMs,
                    label: "codex-critic",
                    // Critic receives every fact through the bounded prompt.
                    // Its Codex harness may authenticate, but spawned tools
                    // cannot see a checkout, inherited secrets, or the web.
                    bypassSandbox: false,
                    isolateToolFilesystem: true,
                    ephemeral: true,
                    ignoreUserConfig: true,
                    ignoreRules: true,
                    disableHooks: true,
                    neverApprove: true,
                    disableWebSearch: true,
                    disableProjectDocs: true,
                    skipGitRepoCheck: true,
                    onInvocation: this.invocationObserver(agentId, turn),
                }),
            )

            const verdictJson = extractVerdictJson(text.trim())
            const parsed: unknown = JSON.parse(verdictJson)
            if (!isCodexVerdict(parsed)) {
                throw new Error("Codex critic returned an invalid verdict object")
            }

            return {
                status: "evaluated",
                verdict: parsed.verdict,
                reasoning: parsed.reasoning,
                violatedCriteria: [...parsed.violated_criteria],
            }
        } catch (err) {
            return {
                status: "inconclusive",
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

interface CodexVerdict {
    verdict: "pass" | "fail"
    reasoning: string
    violated_criteria: string[]
}

function isCodexVerdict(value: unknown): value is CodexVerdict {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false
    }
    const candidate = value as Record<string, unknown>
    const keys = Object.keys(candidate).sort()
    const exactKeys = ["reasoning", "verdict", "violated_criteria"]
    if (
        keys.length !== exactKeys.length ||
        keys.some((key, index) => key !== exactKeys[index])
    ) {
        return false
    }
    const violatedCriteria = candidate.violated_criteria
    if (
        !Array.isArray(violatedCriteria) ||
        violatedCriteria.some(
            (criterion) =>
                typeof criterion !== "string" || !criterion.trim(),
        )
    ) {
        return false
    }
    return (
        (candidate.verdict === "pass" || candidate.verdict === "fail") &&
        typeof candidate.reasoning === "string" &&
        Boolean(candidate.reasoning.trim()) &&
        (candidate.verdict === "pass"
            ? violatedCriteria.length === 0
            : violatedCriteria.length > 0)
    )
}
