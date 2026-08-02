/**
 * Progressive planner as a collective bus participant.
 *
 * The subprocess planner lane (run-planner → stdout wire → Rust bridge →
 * orchestrator stdin) is one-way by construction: the planner's receipts are
 * computed locally in its own process and it never learns what the host
 * actually admitted, pruned, executed or merged. This session runs the same
 * Claude planner INSIDE the orchestrator instead: a long-lived stream-json
 * CLI participant whose publish_plan_fragment tool result carries the
 * Board's authoritative admission (graph version, dropped edges), and whose
 * open stdin lets awareness runners narrate execution back to it mid-plan.
 */

import { randomUUID } from "node:crypto"

import {
    BaseObserver,
    type AgenticEnvironment,
    type Participant,
    type SemanticEvent,
} from "../../runtime/mozaik.js"
import {
    AgentResult,
    PlanFragmentAdmitted,
    PlanFragmentRejected,
} from "../../semantic-events.js"
import { ClaudeCliParticipant } from "../../harness/claude/cli-participant.js"
import { IdleWatchdog, llmIdleTimeoutMs } from "../../harness/liveness.js"
import type { PlanningFeed } from "../../execution/planning-feed.js"
import type { GoalEnvelope } from "../../conversation/session/conversation-contract.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
    heuristicModeContract,
    type ModeContract,
} from "../domain/planner-prompts.js"
import {
    createPlannerHarnessProgressiveSupport,
    currentPlannerMcpServerCommand,
    PROGRESSIVE_PLANNER_MCP_SERVER_NAME,
    PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
    type PlannerMcpServerCommand,
} from "./planner-harness-progressive.js"
import type { PlannerOpenAIPlanFragmentEvent } from "./planner-openai-progressive.js"
import { extractJsonObject } from "../domain/planner-prompts.js"

export interface PlannerBusSessionOptions {
    runId: string
    cwd: string
    env: AgenticEnvironment
    feed: PlanningFeed
    goalEnvelope: GoalEnvelope
    decisionDocument?: string
    projectContext?: string
    modeContract?: ModeContract
    model?: string
    effort?: string
    claudeBin?: string
    /** Max silence before the planner is presumed hung. Activity on either
     *  stream resets it — a thinking planner is never killed. */
    idleTimeoutMs?: number
    /** Test override; defaults to this process entry serving the MCP mode. */
    mcpServer?: PlannerMcpServerCommand
    /** The Rust bootstrap PRD pre-seeds the planning latch with its own
     *  planningId; fragments must carry THAT id or the Board rejects them
     *  with planning_id_mismatch. When set, the session adopts it and skips
     *  its own planning_open. */
    existingPlanningId?: string
}

/** The planner's stable bus identity; awareness runners address this. */
export function plannerBusAgentId(runId: string): string {
    return `planner:${runId}`
}

interface FragmentReceipt {
    admitted: boolean
    graphVersion?: number
    storyIds?: readonly string[]
    droppedEdges?: readonly string[]
    replay?: boolean
    rejectionCode?: string
    rejectionReason?: string
}

/** Resolves fragment receipts by correlating admission events on the bus. */
class ReceiptObserver extends BaseObserver {
    private readonly waiters = new Map<
        string,
        (receipt: FragmentReceipt) => void
    >()

    constructor(private readonly planningId: string) {
        super()
    }

    await(fragmentId: string): Promise<FragmentReceipt> {
        return new Promise((resolve) => {
            this.waiters.set(fragmentId, resolve)
        })
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (PlanFragmentAdmitted.is(event)) {
            if (event.data.planningId !== this.planningId) return
            this.settle(event.data.fragmentId, {
                admitted: true,
                graphVersion: event.data.graphVersion,
                storyIds: event.data.storyIds,
                droppedEdges: event.data.droppedEdges,
                replay: event.data.replay,
            })
            return
        }
        if (PlanFragmentRejected.is(event)) {
            if (event.data.planningId !== this.planningId) return
            if (!event.data.fragmentId) return
            this.settle(event.data.fragmentId, {
                admitted: false,
                rejectionCode: event.data.code,
                rejectionReason: event.data.reason,
            })
        }
    }

    private settle(fragmentId: string, receipt: FragmentReceipt): void {
        const waiter = this.waiters.get(fragmentId)
        if (!waiter) return
        this.waiters.delete(fragmentId)
        waiter(receipt)
    }
}

/** Hands each of the planner's terminal results to the session as it lands,
 *  so a rejected final PRD can be answered with a correction on the still-open
 *  stdin instead of killing the whole planning stream. */
class ResultStream extends BaseObserver {
    private readonly queue: string[] = []
    private waiter: ((text: string | null) => void) | null = null
    private closed = false

    constructor(private readonly agentId: string) {
        super()
    }

    /** Resolves with the next result text, or null once the agent is gone. */
    next(): Promise<string | null> {
        if (this.queue.length > 0) {
            return Promise.resolve(this.queue.shift()!)
        }
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
        if (!AgentResult.is(event) || event.data.agentId !== this.agentId) {
            return
        }
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

/** Render the trusted envelope as the planner's goal statement. */
export function goalTextFromEnvelope(envelope: GoalEnvelope): string {
    const section = (title: string, items: readonly string[]): string =>
        items.length > 0 ? `\n\n${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : ""
    return (
        envelope.objective +
        section("Constraints", envelope.constraints) +
        section("Acceptance criteria", envelope.acceptanceCriteria) +
        section("Non-goals", envelope.nonGoals) +
        section("Assumptions", envelope.assumptions)
    )
}

export interface PlannerBusSessionResult {
    status: "completed" | "failed"
    reason?: string
}

/**
 * Run one planner session on the bus. Resolves when planning has completed
 * or failed; fragment admission and final reconciliation flow through the
 * same PlanningFeed authority the stdin lane uses, so the Board's validation
 * path is identical in both modes.
 */
export async function runPlannerBusSession(
    opts: PlannerBusSessionOptions,
): Promise<PlannerBusSessionResult> {
    const planningId =
        opts.existingPlanningId ?? `planning-bus-${randomUUID().slice(0, 13)}`
    const agentId = plannerBusAgentId(opts.runId)
    const goal = goalTextFromEnvelope(opts.goalEnvelope)
    const modeContract =
        opts.modeContract ??
        heuristicModeContract({
            goal,
            decisionDocument: opts.decisionDocument,
        })

    if (!opts.existingPlanningId) {
        opts.feed.open({
            type: "planning_open",
            run_id: opts.runId,
            planning_id: planningId,
        })
    }

    const fail = (code: string, reason: string): PlannerBusSessionResult => {
        opts.feed.failed({
            type: "plan_failed",
            run_id: opts.runId,
            planning_id: planningId,
            code,
            reason,
        })
        return { status: "failed", reason: `${code}: ${reason}` }
    }

    const receipts = new ReceiptObserver(planningId)
    receipts.join(opts.env)

    let progressive: Awaited<
        ReturnType<typeof createPlannerHarnessProgressiveSupport>
    >
    try {
        progressive = await createPlannerHarnessProgressiveSupport({
            runId: opts.runId,
            planningId,
            trustedGoalEnvelope: opts.goalEnvelope,
            trustedDecisionDocument: opts.decisionDocument,
            // The host holds the admitted prefix; the model finalizes with
            // only the appended tail and the host composes the full plan.
            finalizationTailOnly: true,
            mcpServer: opts.mcpServer ?? currentPlannerMcpServerCommand(),
            publish: async (event: PlannerOpenAIPlanFragmentEvent) => {
                const receipt = receipts.await(event.fragment_id)
                opts.feed.fragment(event)
                const outcome = await receipt
                if (!outcome.admitted) {
                    throw new Error(
                        `fragment rejected (${outcome.rejectionCode}): ${outcome.rejectionReason}`,
                    )
                }
                return {
                    graphVersion: outcome.graphVersion,
                    admittedStoryIds: outcome.storyIds,
                    replayed: outcome.replay === true,
                    ...(outcome.droppedEdges && outcome.droppedEdges.length > 0
                        ? {
                              droppedEdges: outcome.droppedEdges,
                              droppedEdgeNote:
                                  "these dependsOn edges had no supporting file " +
                                  "and were pruned by the host on admission",
                          }
                        : {}),
                }
            },
        })
    } catch (error) {
        receipts.leave(opts.env)
        return fail(
            "planner_failed",
            error instanceof Error ? error.message : String(error),
        )
    }

    const systemPrompt = progressive.systemInstruction
        ? `${PLANNER_SYSTEM_PROMPT}\n\n${progressive.systemInstruction}`
        : PLANNER_SYSTEM_PROMPT
    const mcp = progressive.mcpConnection
    if (!mcp) {
        receipts.leave(opts.env)
        await progressive.close()
        return fail("planner_failed", "progressive MCP relay unavailable")
    }
    const progressiveTool =
        `mcp__${PROGRESSIVE_PLANNER_MCP_SERVER_NAME}__${PROGRESSIVE_PLANNER_MCP_TOOL_NAME}`
    const mcpConfig = JSON.stringify({
        mcpServers: {
            [PROGRESSIVE_PLANNER_MCP_SERVER_NAME]: {
                type: "stdio",
                command: mcp.command,
                args: mcp.args,
                // Claude expands ${VAR} from its own environment, so the
                // relay secret never enters argv.
                env: Object.fromEntries(
                    Object.keys(mcp.providerEnvironment).map((name) => [
                        name,
                        `\${${name}}`,
                    ]),
                ),
            },
        },
    })

    const planner = new ClaudeCliParticipant(agentId, {
        cwd: opts.cwd,
        model: opts.model,
        effort: opts.effort,
        claudeBin: opts.claudeBin,
        includePartialMessages: true,
        permissionMode: "dontAsk",
        extraArgs: [
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            mcpConfig,
            "--tools",
            `Read,Glob,Grep,${progressiveTool}`,
            "--allowed-tools",
            progressiveTool,
            "--system-prompt",
            systemPrompt,
        ],
    })

    const previousEnv: Record<string, string | undefined> = {}
    for (const [name, value] of Object.entries(mcp.providerEnvironment)) {
        previousEnv[name] = process.env[name]
        process.env[name] = value
    }

    const results = new ResultStream(agentId)
    let watchdog: IdleWatchdog | null = null
    try {
        results.join(opts.env)
        planner.join(opts.env)
        planner.start(opts.env)
        watchdog = new IdleWatchdog(
            opts.idleTimeoutMs ?? llmIdleTimeoutMs(),
            () => {
                results.end()
                void planner.abortAndWait()
            },
        )
        planner.onActivity = () => watchdog?.pet()
        void planner.done.then(() => results.end())
        planner.sendUserMessage(
            buildPlannerUserMessage({
                goal,
                decisionDocument: opts.decisionDocument,
                projectContext: opts.projectContext,
                modeContract,
            }),
        )

        // Run 13 died here the old way: one verbatim mismatch in the final
        // PRD closed the whole stream. The planner's stdin is open — a
        // rejected finalization is something it can be TOLD, so it gets the
        // error back as a message and another turn to restate.
        const maxFinalizationAttempts = 3
        for (let attempt = 1; attempt <= maxFinalizationAttempts; attempt++) {
            const resultText = await results.next()
            if (resultText === null) {
                const summary = await planner.done
                return fail(
                    "planner_failed",
                    summary.error?.message ??
                        `planner exited without a result (exit=${summary.exitCode}, signal=${summary.exitSignal})`,
                )
            }
            let composedFinalPrd: Record<string, unknown>
            try {
                const candidate = extractJsonObject(resultText.trim())
                progressive.assertInitialized()
                composedFinalPrd = progressive.reconcileFinalCandidate(candidate)
            } catch (error) {
                const reason =
                    error instanceof Error ? error.message : String(error)
                process.stderr.write(
                    `[planner-bus] finalization attempt ${attempt}/${maxFinalizationAttempts} rejected: ${reason}\n`,
                )
                if (attempt === maxFinalizationAttempts) {
                    planner.closeStdin()
                    return fail("planner_failed", reason)
                }
                planner.sendUserMessage(
                    `Your final PRD was rejected: ${reason}\n\n` +
                        `The host already holds every published story verbatim — do not ` +
                        `repeat them. Reply with ONLY the corrected final PRD JSON whose ` +
                        `userStories contains just the stories that come after the ` +
                        `published prefix (an empty array if nothing remains), plus the ` +
                        `usual project, branchName and description metadata.`,
                )
                continue
            }
            planner.closeStdin()
            await planner.done
            opts.feed.complete({
                type: "plan_complete",
                run_id: opts.runId,
                planning_id: planningId,
                final_prd: composedFinalPrd,
            })
            return { status: "completed" }
        }
        return fail("planner_failed", "finalization attempts exhausted")
    } catch (error) {
        // Whatever went wrong, the open planning stream must be closed —
        // an orphaned latch would stall the Board forever.
        return fail(
            "planner_failed",
            error instanceof Error ? error.message : String(error),
        )
    } finally {
        watchdog?.dispose()
        results.end()
        receipts.leave(opts.env)
        results.leave(opts.env)
        if (planner.getEnvironments().includes(opts.env)) {
            planner.leave(opts.env)
        }
        await progressive.close()
        for (const [name, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
}
