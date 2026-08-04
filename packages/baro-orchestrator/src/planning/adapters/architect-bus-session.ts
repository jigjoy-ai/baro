/**
 * The Architect as a participant instead of a one-shot call.
 *
 * The subprocess Architect states everything it believes in a single reply
 * and is gone before the first line of code exists — which is how a run ends
 * up bound to a premise the repository contradicts (a test command that runs
 * nothing, an import that fails under jest, an enum member that does not
 * exist), with the contract still asserting it hours later.
 *
 * Here it stays open for the whole phase on one environment: it says what it
 * needs to know, scouts answer as participants beside it, it may ask again
 * with those answers in hand, and a rejected outcome comes back to it as a
 * correction rather than killing the phase. Every step is bounded, and the
 * host validates the outcome — the model states, the host decides.
 */

import { randomUUID } from "node:crypto"

import {
    AgenticEnvironment,
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "../../runtime/mozaik.js"
import { AgentResult } from "../../semantic-events.js"
import { ClaudeCliParticipant } from "../../harness/claude/cli-participant.js"
import { IdleWatchdog, llmIdleTimeoutMs } from "../../harness/liveness.js"
import type { GoalEnvelope } from "../../conversation/session/conversation-contract.js"
import {
    parseResearchQuestions,
    renderScoutFindings,
    type ScoutFinding,
    type ScoutQuestion,
} from "./architect-scouts.js"
import { runArchitectResearchSession } from "./architect-research-session.js"

const DEFAULT_RESEARCH_ROUNDS = 2
const DEFAULT_OUTCOME_REPAIRS = 2

export interface ArchitectBusSessionOptions {
    /** The Architect's own contract prompt; this session never rewrites it. */
    systemPrompt: string
    /** First user message: the phase's real instruction. */
    userMessage: string
    cwd: string
    goal: string
    model?: string
    effort?: string
    claudeBin?: string
    projectContext?: string
    goalEnvelope?: GoalEnvelope
    /** Structured-output schema, when the phase has one. */
    outcomeSchema?: unknown
    maxResearchRounds?: number
    maxOutcomeRepairs?: number
    roundBudgetMs?: number
    /** Host validation; throws with a reason the Architect can act on. */
    validateOutcome?: (raw: string) => void
    onFinding?: (finding: ScoutFinding) => void
    onProgress?: (line: string) => void
    /** Test seam, and the seam a run-wide environment plugs into. */
    environment?: AgenticEnvironment
}

export interface ArchitectBusSessionResult {
    outcome: string
    findings: ScoutFinding[]
    researchRounds: number
    outcomeAttempts: number
}

/** Hands each terminal reply to the session as it lands. */
class ReplyStream extends BaseObserver {
    private readonly queue: string[] = []
    private waiter: ((text: string | null) => void) | null = null
    private closed = false

    constructor(private readonly agentId: string) {
        super()
    }

    next(): Promise<string | null> {
        if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
        if (this.closed) return Promise.resolve(null)
        return new Promise((resolve) => {
            this.waiter = resolve
        })
    }

    end(): void {
        this.closed = true
        if (this.waiter) {
            this.waiter(null)
            this.waiter = null
        }
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!AgentResult.is(event) || event.data.agentId !== this.agentId) return
        const text = event.data.isError ? null : event.data.resultText
        if (typeof text !== "string") return
        if (this.waiter) {
            this.waiter(text)
            this.waiter = null
        } else {
            this.queue.push(text)
        }
    }
}

const RESEARCH_TURN_INSTRUCTION = [
    "Before you decide, say what you must learn about this repository.",
    "Scouts will read the code and answer in parallel, with file:line citations.",
    "",
    "A good question is one whose answer changes a decision: which module owns",
    "a behavior, whether a convention already exists, what a boundary actually",
    "validates, which callers depend on a shape. Ask nothing you can already",
    "answer, nothing that is really a design opinion, and nothing a scout",
    "cannot cite.",
    "",
    'Reply with ONLY {"questions":[{"question":"...","scope":"optional path"}]}',
    "— an empty array if you need nothing.",
].join("\n")

function decideTurnInstruction(findings: readonly ScoutFinding[], last: boolean): string {
    return [
        renderScoutFindings(findings),
        "",
        last
            ? "This was the last research round. Produce your outcome now, using what you have and stating any remaining unknown as an assumption."
            : 'If something you must know is still unknown, reply with ONLY {"questions":[...]} for one more round. Otherwise produce your outcome now.',
    ].join("\n")
}

/**
 * Run the Architect phase as a conversation on the bus. Returns the raw
 * outcome text the caller's own parser owns — this session validates shape
 * through `validateOutcome` and never interprets the decision itself.
 */
export async function runArchitectBusSession(
    opts: ArchitectBusSessionOptions,
): Promise<ArchitectBusSessionResult> {
    const sessionId = randomUUID().slice(0, 8)
    const agentId = `architect:${sessionId}`
    const env = opts.environment ?? new AgenticEnvironment("architect-bus")
    const replies = new ReplyStream(agentId)
    const architect = new ClaudeCliParticipant(agentId, {
        cwd: opts.cwd,
        model: opts.model,
        effort: opts.effort,
        claudeBin: opts.claudeBin,
        includePartialMessages: true,
        permissionMode: "dontAsk",
        extraArgs: [
            "--tools",
            "Read,Glob,Grep",
            "--safe-mode",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--no-session-persistence",
            ...(opts.outcomeSchema
                ? ["--json-schema", JSON.stringify(opts.outcomeSchema)]
                : []),
            "--system-prompt",
            opts.systemPrompt,
        ],
    })

    const maxRounds = Math.max(0, opts.maxResearchRounds ?? DEFAULT_RESEARCH_ROUNDS)
    const maxRepairs = Math.max(0, opts.maxOutcomeRepairs ?? DEFAULT_OUTCOME_REPAIRS)
    const findings: ScoutFinding[] = []
    let watchdog: IdleWatchdog | null = null
    let researchRounds = 0
    let outcomeAttempts = 0

    const failed = (reason: string): never => {
        throw new Error(`architect bus session: ${reason}`)
    }

    try {
        replies.join(env)
        architect.join(env)
        architect.start(env)
        watchdog = new IdleWatchdog(llmIdleTimeoutMs(), () => {
            replies.end()
            void architect.abortAndWait()
        })
        architect.onActivity = () => watchdog?.pet()
        void architect.done.then(() => replies.end())

        architect.sendUserMessage(
            maxRounds > 0
                ? `${opts.userMessage}\n\n---\n\n${RESEARCH_TURN_INSTRUCTION}`
                : opts.userMessage,
        )

        // Research rounds: the Architect asks, scouts answer beside it.
        while (researchRounds < maxRounds) {
            const reply = await replies.next()
            if (reply === null) failed("the Architect exited during research")
            const questions = parseResearchQuestions(reply!)
            if (questions.length === 0) {
                // No questions means this reply IS the outcome attempt. Waiting
                // for another would deadlock: nobody is speaking next.
                outcomeAttempts = 1
                return await settleOutcome(reply!, {
                    opts,
                    architect,
                    replies,
                    findings,
                    researchRounds,
                    maxRepairs,
                    startingAttempt: 1,
                })
            }
            researchRounds += 1
            opts.onProgress?.(
                `[architect-bus] research round ${researchRounds}: ${questions.length} question(s)`,
            )
            const round = await runResearch(questions, env, opts)
            findings.push(...round)
            architect.sendUserMessage(
                decideTurnInstruction(findings, researchRounds >= maxRounds),
            )
        }

        const reply = await replies.next()
        if (reply === null) failed("the Architect exited before an outcome")
        outcomeAttempts = 1
        return await settleOutcome(reply!, {
            opts,
            architect,
            replies,
            findings,
            researchRounds,
            maxRepairs,
            startingAttempt: 1,
        })
    } finally {
        watchdog?.dispose()
        replies.end()
        architect.closeStdin()
        void architect.abortAndWait()
        replies.leave(env)
        if (architect.getEnvironments().includes(env)) architect.leave(env)
    }
}

async function runResearch(
    questions: readonly ScoutQuestion[],
    env: AgenticEnvironment,
    opts: ArchitectBusSessionOptions,
): Promise<ScoutFinding[]> {
    return await runArchitectResearchSession({
        questions,
        cwd: opts.cwd,
        model: opts.model,
        effort: opts.effort,
        claudeBin: opts.claudeBin,
        environment: env,
        ...(opts.roundBudgetMs ? { roundBudgetMs: opts.roundBudgetMs } : {}),
        onFinding: (finding) => {
            opts.onProgress?.(
                `[architect-bus] ${finding.id} ${finding.ok ? "answered" : "FAILED"}: ` +
                    `${finding.question.slice(0, 80)}`,
            )
            opts.onFinding?.(finding)
        },
    })
}

/**
 * A rejected outcome is a correction, not the end of the phase: the Architect
 * is told exactly what the host refused and answers again, up to its budget.
 */
async function settleOutcome(
    firstReply: string,
    input: {
        opts: ArchitectBusSessionOptions
        architect: ClaudeCliParticipant
        replies: ReplyStream
        findings: ScoutFinding[]
        researchRounds: number
        maxRepairs: number
        startingAttempt: number
    },
): Promise<ArchitectBusSessionResult> {
    const { opts, architect, replies, findings, researchRounds, maxRepairs } = input
    let reply: string | null = firstReply
    let attempt = input.startingAttempt
    for (;;) {
        if (reply === null) {
            throw new Error("architect bus session: the Architect exited mid-repair")
        }
        try {
            opts.validateOutcome?.(reply)
            return {
                outcome: reply,
                findings,
                researchRounds,
                outcomeAttempts: attempt,
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            if (attempt > maxRepairs) {
                throw new Error(
                    `architect bus session: outcome rejected after ${attempt} attempt(s): ${reason}`,
                )
            }
            opts.onProgress?.(
                `[architect-bus] outcome attempt ${attempt} rejected: ${reason}`,
            )
            attempt += 1
            architect.sendUserMessage(
                `Your outcome was rejected: ${reason}\n\n` +
                    "Reply with ONLY the corrected outcome. Change nothing that " +
                    "was already valid, and do not restate this message.",
            )
            reply = await replies.next()
        }
    }
}
