/**
 * Repository research as a collective, not a fan-out.
 *
 * Every scout is a participant on one environment, its answer is an event,
 * and the board hands each answer to the scouts still reading — so a scout
 * that finds the convention tells the others while they can still use it.
 * The Architect consumes findings as they land (`onFinding`), and the round
 * ends on its own budget, so one slow scout costs its own time instead of
 * the round's. This is the shape the earlier Promise.all round stood in for.
 */

import { randomUUID } from "node:crypto"

import {
    AgenticEnvironment,
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "../../runtime/mozaik.js"
import {
    AgentResult,
    AgentTargetedMessage,
    ScoutDispatched,
    ScoutFindingPublished,
} from "../../semantic-events.js"
import { laneAdapterFor } from "../../harness/lane-registry.js"
import type { InteractiveModelParticipant } from "../../harness/interactive-participant.js"
import type { OpenAIConnection } from "../../harness/openai/runtime.js"
import type { GatewayBillingCoordinator } from "../../telemetry/billing/index.js"
import { IdleWatchdog, llmIdleTimeoutMs } from "../../harness/liveness.js"
import type { ScoutFinding, ScoutQuestion } from "./architect-scouts.js"

const MAX_FINDING_CHARS = 4_000
const PEER_NOTE_CHARS = 500
const DEFAULT_ROUND_BUDGET_MS = 6 * 60 * 1000

export const SCOUT_SESSION_SYSTEM_PROMPT = `You are a Baro repository scout. \
You answer exactly one question about this repository for the Architect who \
asked it, and you work alongside other scouts answering theirs.

Rules:
- Read the code. Never guess, never generalize from a filename.
- Cite file:line for every claim. A claim without a citation is not an answer.
- Report what IS, not what should be. No recommendations, no refactors.
- If the answer is "no such thing exists", say so and name where you looked.
- Be terse: the Architect reads many answers at once. No preamble, no
  restatement of the question, no markdown headings.
- A peer's finding may arrive while you work. Use it: it is evidence someone
  else already verified. If it answers part of your question, say so and
  spend your remaining effort on what is still unknown. If it contradicts
  what you found, say that too — a contradiction is worth more than a
  confident answer.
- You have read-only tools. You never write, and you never run project
  commands.`

export function scoutAgentId(questionId: string, sessionId: string): string {
    return `scout:${sessionId}:${questionId}`
}

/** One research round is one "run"; a scout is its own single-generation lease. */
function scoutCorrelation(
    sessionId: string,
    agentId: string,
): { runId: string; leaseId: string; generation: number } {
    return { runId: `research:${sessionId}`, leaseId: agentId, generation: 0 }
}

/**
 * Collects answers, publishes them as events, and keeps the still-reading
 * scouts informed of what their peers found.
 */
class ResearchBoard extends BaseObserver {
    private readonly settled = new Map<string, ScoutFinding>()
    private readonly live = new Set<string>()

    constructor(
        private readonly questions: ReadonlyMap<string, ScoutQuestion>,
        /** Stamped on peer notes so only this board can reach these scouts. */
        private readonly sessionId: string,
        private readonly onFinding?: (finding: ScoutFinding) => void,
        /** Internal: the session releases the scout once it has answered. */
        private readonly onSettled?: (agentId: string) => void,
    ) {
        super()
        for (const agentId of questions.keys()) this.live.add(agentId)
    }

    get findings(): ScoutFinding[] {
        return [...this.questions.keys()].flatMap((agentId) => {
            const finding = this.settled.get(agentId)
            return finding ? [finding] : []
        })
    }

    get pending(): number {
        return this.live.size
    }

    /** A scout that never answered still owes the Architect an honest gap. */
    recordUnanswered(agentId: string, reason: string): void {
        if (this.settled.has(agentId)) return
        const question = this.questions.get(agentId)
        if (!question) return
        this.publishFinding({
            id: question.id,
            question: question.question,
            answer: `unanswered: ${reason}`,
            ok: false,
        }, agentId)
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!AgentResult.is(event)) return
        const agentId = event.data.agentId
        if (!this.questions.has(agentId) || this.settled.has(agentId)) return
        const question = this.questions.get(agentId)!
        const text = event.data.isError ? null : event.data.resultText
        this.publishFinding(
            typeof text === "string" && text.trim()
                ? {
                      id: question.id,
                      question: question.question,
                      answer: text.trim().slice(0, MAX_FINDING_CHARS),
                      ok: true,
                  }
                : {
                      id: question.id,
                      question: question.question,
                      answer: "unanswered: the scout returned no usable answer",
                      ok: false,
                  },
            agentId,
        )
    }

    private publishFinding(finding: ScoutFinding, agentId: string): void {
        this.settled.set(agentId, finding)
        this.live.delete(agentId)
        this.emit(
            ScoutFindingPublished.create({
                scoutId: agentId,
                question: finding.question,
                answer: finding.answer,
                ok: finding.ok,
            }),
        )
        this.onFinding?.(finding)
        this.onSettled?.(agentId)
        if (!finding.ok) return
        // Horizontal awareness: peers still reading hear this now, not after
        // the round. A late scout that would have re-derived the same fact
        // spends its remaining effort on what is still unknown.
        const note =
            `[peer ${finding.id}] ${finding.question}\n` +
            `${finding.answer.slice(0, PEER_NOTE_CHARS)}`
        for (const recipientId of this.live) {
            this.emit(
                AgentTargetedMessage.create({
                    recipientId,
                    text: note,
                    metadata: { source: "research-board", findingId: finding.id },
                    ...scoutCorrelation(this.sessionId, recipientId),
                }),
            )
        }
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, event)
        }
    }
}

export interface ResearchSessionOptions {
    questions: readonly ScoutQuestion[]
    cwd: string
    model?: string
    effort?: string
    claudeBin?: string
    /** Which lane holds the scouts. Defaults to the CLI this began on. */
    backend?: string
    /** Endpoint for a lane that calls a model directly. */
    connection?: OpenAIConnection
    /** Meters the rounds this process issues; a CLI reports its own. */
    billingCoordinator?: GatewayBillingCoordinator
    /** Whole-round budget; a scout still reading when it expires is aborted. */
    roundBudgetMs?: number
    /** Called as each answer lands, before the round ends. */
    onFinding?: (finding: ScoutFinding) => void
    /** Test seam: an environment the caller owns and observes. */
    environment?: AgenticEnvironment
}

/**
 * Run one research round. Returns every finding, answered or not — an
 * unanswered question is a stated gap, never a silent one.
 */
export async function runArchitectResearchSession(
    opts: ResearchSessionOptions,
): Promise<ScoutFinding[]> {
    if (opts.questions.length === 0) return []
    const sessionId = randomUUID().slice(0, 8)
    const env = opts.environment ?? new AgenticEnvironment("architect-research")
    const questions = new Map<string, ScoutQuestion>(
        opts.questions.map((question) => [
            scoutAgentId(question.id, sessionId),
            question,
        ]),
    )
    const lane = laneAdapterFor({
        backend: opts.backend ?? "claude",
        ...(opts.connection ? { connection: opts.connection } : {}),
        ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
    })
    // A scout reads and never writes; that is the whole of what it needs, and
    // stating it as a capability is what lets any lane hold one.
    const grant = await lane.grant([{ kind: "read-repo", cwd: opts.cwd }])
    const scouts = new Map<string, InteractiveModelParticipant<unknown>>()
    // A scout keeps its stdin open so peers' findings can reach it mid-read;
    // closing it is what lets the process exit once its own answer is in.
    const board = new ResearchBoard(questions, sessionId, opts.onFinding, (agentId) => {
        scouts.get(agentId)?.closeStdin()
    })
    board.join(env)

    for (const [agentId, question] of questions) {
        const scout = lane.create(
            {
                agentId,
                cwd: opts.cwd,
                ...(opts.model ? { model: opts.model } : {}),
                ...(opts.effort ? { effort: opts.effort } : {}),
                systemPrompt: SCOUT_SESSION_SYSTEM_PROMPT,
                // The board is the only voice a scout listens to; the
                // synthetic correlation is what the authenticated delivery
                // path checks.
                targetedMessageAuthority: board,
                targetedMessageCorrelation: scoutCorrelation(sessionId, agentId),
                ...(opts.billingCoordinator
                    ? {
                          billing: {
                              coordinator: opts.billingCoordinator,
                              phase: "architect" as const,
                          },
                      }
                    : {}),
            },
            grant,
        )
        scouts.set(agentId, scout)
    }

    const watchdogs = new Map<string, IdleWatchdog>()
    try {
        for (const [agentId, scout] of scouts) {
            const question = questions.get(agentId)!
            scout.join(env)
            scout.start(env)
            env.deliverSemanticEvent(
                board,
                ScoutDispatched.create({
                    scoutId: agentId,
                    question: question.question,
                    ...(question.scope ? { scope: question.scope } : {}),
                }),
            )
            const watchdog = new IdleWatchdog(llmIdleTimeoutMs(), () => {
                board.recordUnanswered(agentId, "no output within the idle budget")
                void scout.abortAndWait()
            })
            scout.onActivity = () => watchdog.pet()
            watchdogs.set(agentId, watchdog)
            scout.sendUserMessage(
                question.scope
                    ? `${question.question}\n\nStart looking here: ${question.scope}`
                    : question.question,
            )
        }

        const budget = opts.roundBudgetMs ?? DEFAULT_ROUND_BUDGET_MS
        let expired = false
        const roundDeadline = new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                expired = true
                resolve()
            }, budget)
            timer.unref?.()
        })
        await Promise.race([
            (async () => {
                for (const scout of scouts.values()) await scout.done
            })(),
            roundDeadline,
        ])
        if (expired) {
            for (const [agentId, scout] of scouts) {
                board.recordUnanswered(agentId, "the research round budget expired")
                scout.closeStdin()
                void scout.abortAndWait()
            }
        }
        return board.findings
    } finally {
        for (const watchdog of watchdogs.values()) watchdog.dispose()
        for (const scout of scouts.values()) {
            if (scout.getEnvironments().includes(env)) scout.leave(env)
        }
        board.leave(env)
    }
}
