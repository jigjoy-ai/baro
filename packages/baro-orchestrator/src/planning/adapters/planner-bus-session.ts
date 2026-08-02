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

/** Ends the planner's stdin once its terminal result event lands: with
 *  stream-json input the CLI otherwise waits forever for another turn. */
class ResultCloser extends BaseObserver {
    constructor(
        private readonly agentId: string,
        private readonly close: () => void,
    ) {
        super()
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (AgentResult.is(event) && event.data.agentId === this.agentId) {
            this.close()
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

    const closer = new ResultCloser(agentId, () => planner.closeStdin())
    let watchdog: IdleWatchdog | null = null
    try {
        closer.join(opts.env)
        planner.join(opts.env)
        planner.start(opts.env)
        watchdog = new IdleWatchdog(
            opts.idleTimeoutMs ?? llmIdleTimeoutMs(),
            () => void planner.abortAndWait(),
        )
        planner.onActivity = () => watchdog?.pet()
        planner.sendUserMessage(
            buildPlannerUserMessage({
                goal,
                decisionDocument: opts.decisionDocument,
                projectContext: opts.projectContext,
                modeContract,
            }),
        )
        const summary = await planner.done
        watchdog.dispose()
        planner.onActivity = null

        const resultText = summary.lastResult?.resultText
        if (summary.lastResult?.isError || typeof resultText !== "string") {
            return fail(
                "planner_failed",
                summary.error?.message ??
                    `planner exited without a result (exit=${summary.exitCode}, signal=${summary.exitSignal})`,
            )
        }
        let candidate: string
        try {
            candidate = extractJsonObject(resultText.trim())
            progressive.assertInitialized()
            progressive.reconcileFinalCandidate(candidate)
        } catch (error) {
            return fail(
                "planner_failed",
                error instanceof Error ? error.message : String(error),
            )
        }
        opts.feed.complete({
            type: "plan_complete",
            run_id: opts.runId,
            planning_id: planningId,
            final_prd: JSON.parse(candidate),
        })
        return { status: "completed" }
    } catch (error) {
        // Whatever went wrong, the open planning stream must be closed —
        // an orphaned latch would stall the Board forever.
        return fail(
            "planner_failed",
            error instanceof Error ? error.message : String(error),
        )
    } finally {
        watchdog?.dispose()
        receipts.leave(opts.env)
        closer.leave(opts.env)
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
