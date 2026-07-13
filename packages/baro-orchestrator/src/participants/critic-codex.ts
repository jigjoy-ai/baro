/**
 * CriticCodex — fail-closed adapter for Codex CLI Critic configuration.
 *
 * Same bus contract as the Claude variant: observes AgentResultItem
 * events, evaluates the agent's output against acceptance criteria,
 * publishes a CritiqueItem (audit trail), and emits an
 * AgentTargetedMessageItem corrective when the verdict is "fail" (up
 * to maxEmissionsPerAgent). Codex CLI currently has no tool-less inference
 * mode, so this adapter refuses to pass untrusted evidence to its agentic
 * harness. Use CriticOpenAI for direct, tool-less OpenAI inference.
 *
 * Library-grade: no imports from prd.ts, story-agent.ts, or
 * conductor.ts.
 */

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { AgentTargetedMessage, Critique } from "../semantic-events.js"
import { buildCorrectiveMessage } from "./critic.js"
import type { CriticEvidenceSource } from "./critic-evidence.js"
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
            const { verdict, reasoning, violatedCriteria } = await this.evaluate()

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

    private async evaluate(): Promise<{
        verdict: "pass" | "fail"
        reasoning: string
        violatedCriteria: string[]
    }> {
        return {
            verdict: "fail",
            reasoning:
                "CriticCodex is disabled: refusing to send untrusted Critic " +
                "evidence to Codex CLI because it exposes no tool-less " +
                "inference mode. Configure the direct OpenAI Critic backend " +
                "or another tool-less Critic backend instead.",
            violatedCriteria: [
                "[critic backend unavailable — tool-less evaluation required]",
            ],
        }
    }
}
